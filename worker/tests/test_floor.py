import numpy as np
import pytest

from pipeline.errors import PipelineError
from pipeline.floor import (alignment_from_floor, camera_up_hint, check_solve, drop_outlier_cameras, fit_floor,
                            level_scene)
from pipeline.scene import Scene, apply_similarity


def _random_rotation(rng) -> np.ndarray:
    q, r = np.linalg.qr(rng.normal(size=(3, 3)))
    q *= np.sign(np.diag(r))
    if np.linalg.det(q) < 0:
        q[:, 0] *= -1
    return q


def _look_w2c(centre: np.ndarray, yaw: float, pitch: float = -0.2) -> np.ndarray:
    """OpenCV camera (x right, y down, z forward) in a +Y-up world."""
    fwd = np.array([np.cos(pitch) * np.cos(yaw), np.sin(pitch), np.cos(pitch) * np.sin(yaw)])
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])  # rows = camera axes in world
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = -R @ centre
    return M


def _synthetic_room(rng, n_cams=60):
    """Metric room, +Y up, floor y=0, 4x3 m, 2.5 m ceiling, cameras at 1.4 m."""
    floor = np.c_[rng.uniform(-2, 2, 3000), rng.normal(0, 0.003, 3000), rng.uniform(-1.5, 1.5, 3000)]
    ceil = np.c_[rng.uniform(-2, 2, 1500), np.full(1500, 2.5), rng.uniform(-1.5, 1.5, 1500)]
    wall = np.c_[np.full(1500, 2.0), rng.uniform(0, 2.5, 1500), rng.uniform(-1.5, 1.5, 1500)]
    table = np.c_[rng.uniform(-0.5, 0.5, 600), np.full(600, 0.75), rng.uniform(-0.4, 0.4, 600)]
    pts = np.vstack([floor, ceil, wall, table])
    ang = np.linspace(0, 2 * np.pi, n_cams, endpoint=False)
    centres = np.c_[1.0 * np.cos(ang), 1.4 + rng.normal(0, 0.05, n_cams), 0.8 * np.sin(ang)]
    w2c = np.array([_look_w2c(c, a + np.pi) for c, a in zip(centres, ang)])
    K = np.tile(np.array([[500.0, 0, 320], [0, 500.0, 240], [0, 0, 1]]), (n_cams, 1, 1))
    return Scene([f"{i:05d}.jpg" for i in range(n_cams)], K, np.full(n_cams, 640), np.full(n_cams, 480),
                 w2c, pts, np.zeros((len(pts), 3), np.uint8))


def _scramble(scene: Scene, rng, s=0.37):
    """Put the metric room into an arbitrary COLMAP-like frame."""
    R = _random_rotation(rng)
    T = rng.normal(size=3) * 5
    return apply_similarity(scene, s, R, T), s


def test_apply_similarity_preserves_projection():
    rng = np.random.default_rng(0)
    room = _synthetic_room(rng)
    moved, _ = _scramble(room, rng)

    def project(sc, i, X):
        x = sc.w2c[i, :3, :3] @ X + sc.w2c[i, :3, 3]
        uv = sc.K[i] @ x
        return uv[:2] / uv[2]

    for i in (0, 17, 42):
        for j in (5, 999, 4000):
            assert np.allclose(project(room, i, room.points[j]), project(moved, i, moved.points[j]), atol=1e-6)
    assert np.allclose(np.linalg.norm(np.diff(moved.camera_centres(), axis=0), axis=1),
                       0.37 * np.linalg.norm(np.diff(room.camera_centres(), axis=0), axis=1))


def test_up_hint_matches_world_up():
    rng = np.random.default_rng(1)
    room = _synthetic_room(rng)
    assert camera_up_hint(room.w2c) @ np.array([0, 1, 0]) > 0.95


def test_fit_floor_ignores_ceiling_and_table():
    rng = np.random.default_rng(2)
    room = _synthetic_room(rng)
    fit = fit_floor(room.points, room.camera_centres(), camera_up_hint(room.w2c))
    assert fit.normal @ [0, 1, 0] > 0.999
    assert abs(fit.offset) < 0.01  # plane y = 0
    assert fit.camera_height == pytest.approx(1.4, abs=0.03)


def test_level_scene_recovers_metric_levelled_frame():
    rng = np.random.default_rng(3)
    room = _synthetic_room(rng)
    scrambled, s = _scramble(room, rng)
    levelled, al, _ = level_scene(scrambled)
    assert al.scale == pytest.approx(1 / s, rel=0.03)
    assert np.isclose(np.linalg.det(al.R), 1.0)
    cams = levelled.camera_centres()
    assert np.median(cams[:, 1]) == pytest.approx(1.4, abs=0.01)
    assert np.allclose(cams[:, [0, 2]].mean(axis=0), 0, atol=1e-6)
    floor_y = levelled.points[:3000, 1]
    assert np.abs(np.median(floor_y)) < 0.01
    ceil_y = levelled.points[3000:4500, 1]
    assert np.median(ceil_y) == pytest.approx(2.5, abs=0.06)
    # longest room axis (4 m) ends up on X
    xs, zs = levelled.points[:3000, 0], levelled.points[:3000, 2]
    assert np.ptp(xs) > np.ptp(zs)
    # image up still points to +Y after levelling
    assert camera_up_hint(levelled.w2c) @ [0, 1, 0] > 0.95


def test_alignment_apply_matches_scene_transform():
    rng = np.random.default_rng(4)
    scrambled, _ = _scramble(_synthetic_room(rng), rng)
    levelled, al, _ = level_scene(scrambled)
    assert np.allclose(al.apply(scrambled.points), levelled.points)


def test_no_floor_is_user_readable():
    rng = np.random.default_rng(5)
    room = _synthetic_room(rng)
    # only ceiling points: everything above the cameras
    with pytest.raises(PipelineError) as e:
        fit_floor(room.points[3000:4500], room.camera_centres(), camera_up_hint(room.w2c))
    assert "floor" in e.value.user_message.lower()


def test_alignment_handles_floor_facing_down_hint():
    rng = np.random.default_rng(6)
    room = _synthetic_room(rng)
    fit = fit_floor(room.points, room.camera_centres(), camera_up_hint(room.w2c))
    al = alignment_from_floor(fit, room.points, room.camera_centres())
    assert al.scale == pytest.approx(1.0, rel=0.03)


def _fold(scene: Scene, deg: float = 35.0, hinge_z: float = 0.3) -> Scene:
    """Fake a folded solve: the z > hinge_z part of the room (points + cameras) hinged down by
    deg about the x axis at the floor, like GLOMAP's tilted duplicate carpet."""
    a = np.radians(deg)
    R = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])  # +z tips to -y
    h = np.array([0.0, 0.0, hinge_z])
    pts = scene.points.copy()
    m = pts[:, 2] > hinge_z
    pts[m] = (pts[m] - h) @ R.T + h
    w2c = scene.w2c.copy()
    cams = scene.camera_centres()
    for i in np.nonzero(cams[:, 2] > hinge_z)[0]:
        c2w = np.linalg.inv(w2c[i])
        c2w[:3, :3] = R @ c2w[:3, :3]
        c2w[:3, 3] = R @ (c2w[:3, 3] - h) + h
        w2c[i] = np.linalg.inv(c2w)
    return Scene(scene.image_names, scene.K, scene.width, scene.height, w2c, pts, scene.colors)


def test_check_solve_accepts_a_clean_room():
    rng = np.random.default_rng(3)
    scrambled, _ = _scramble(_synthetic_room(rng), rng)
    chk = check_solve(scrambled)
    assert chk.ok, chk.problems
    assert chk.below_floor_fraction < 0.01
    assert chk.camera_height_spread_m < 0.5


def test_check_solve_flags_a_folded_room():
    rng = np.random.default_rng(4)
    scrambled, _ = _scramble(_fold(_synthetic_room(rng)), rng)
    chk = check_solve(scrambled)
    assert not chk.ok
    assert chk.below_floor_fraction > 0.1
    assert "below the floor" in chk.problems[0]


def test_check_solve_flags_wild_camera_heights():
    rng = np.random.default_rng(5)
    room = _synthetic_room(rng)
    cams = room.camera_centres()
    # Heights ramping 0.3 -> 9 (x the median-height scale): not a handheld walk-through.
    cams[:, 1] = np.linspace(0.3, 9.0, len(cams))
    w2c = np.array([_look_w2c(c, np.arctan2(-c[2], -c[0])) for c in cams])
    room = Scene(room.image_names, room.K, room.width, room.height, w2c, room.points, room.colors)
    chk = check_solve(room)
    assert any("camera heights" in p for p in chk.problems)


def test_check_solve_reports_missing_floor():
    rng = np.random.default_rng(6)
    room = _synthetic_room(rng)
    room = Scene(room.image_names, room.K, room.width, room.height, room.w2c, room.points[:20], room.colors[:20])
    chk = check_solve(room)
    assert not chk.ok and chk.problems[0].startswith("no floor")


def _with_cameras(room: Scene, centres: np.ndarray) -> Scene:
    w2c = np.array([_look_w2c(c, np.arctan2(-c[2], -c[0])) for c in centres])
    n = len(centres)
    K = np.tile(room.K[0], (n, 1, 1))
    return Scene([f"{i:05d}.jpg" for i in range(n)], K, np.full(n, 640), np.full(n, 480), w2c,
                 room.points, room.colors)


def test_level_scene_drops_misregistered_cameras():
    """Job 9acd3d47: a few frames registered flying 30 m away / 12 m up, a few at floor level."""
    rng = np.random.default_rng(7)
    room = _synthetic_room(rng)
    cams = room.camera_centres()
    stray = np.array([[-21.0, 12.1, -21.7], [-13.0, 9.7, -7.0], [-7.1, 6.3, -2.4], [0.5, -0.13, 0.2]])
    room = _with_cameras(room, np.vstack([cams, stray]))
    scrambled, _ = _scramble(room, rng)
    lv, al, _ = level_scene(scrambled)
    assert lv.num_cameras == len(cams)
    assert lv.image_names == room.image_names[:len(cams)]
    c = lv.camera_centres()
    assert c[:, 1].max() < 2.0 and c[:, 1].min() > 1.0
    assert al.scale == pytest.approx(1 / 0.37, rel=0.05)  # median camera height: unaffected


def test_level_scene_keeps_a_clean_walkthrough():
    rng = np.random.default_rng(8)
    room = _synthetic_room(rng)
    scrambled, _ = _scramble(room, rng)
    lv, _, _ = level_scene(scrambled)
    assert lv.num_cameras == room.num_cameras


def test_too_many_stray_cameras_is_user_readable():
    rng = np.random.default_rng(9)
    room = _synthetic_room(rng, n_cams=40)
    cams = room.camera_centres()
    cams[:15, 1] = np.linspace(4.0, 12.0, 15)  # 37% of the path in the air
    with pytest.raises(PipelineError) as e:
        drop_outlier_cameras(_with_cameras(room, cams))
    assert "camera path" in e.value.user_message


def _break_path(room: Scene, n: int = 25, shift=(1.5, 0.6, 0.0)) -> Scene:
    """The first n cameras registered as a rigidly shifted piece (job 9acd3d47's start)."""
    cams = room.camera_centres()
    cams[:n] += np.array(shift)
    return _with_cameras(room, cams)


def test_clean_path_is_one_piece():
    from pipeline.floor import main_path_fraction, path_segments

    room = _synthetic_room(np.random.default_rng(10))
    assert len(path_segments(room)) == 1 and main_path_fraction(room) == 1.0


def test_check_solve_flags_a_broken_camera_path():
    """Job 9acd3d47: GLOMAP placed the video as 5 pieces; the largest held 52% of the cameras."""
    from pipeline.floor import path_segments

    rng = np.random.default_rng(11)
    broken = _break_path(_synthetic_room(rng))
    assert [len(s) for s in path_segments(broken)] == [25, 35]
    chk = check_solve(_scramble(broken, rng)[0])
    assert not chk.ok and any("breaks into pieces" in p for p in chk.problems)
    assert chk.main_path_fraction == pytest.approx(35 / 60)


def test_path_check_uses_frame_numbers_for_gaps():
    """Frames dropped by the blur filter or the solve leave gaps; walking that far is fine."""
    from pipeline.floor import main_path_fraction

    room = _synthetic_room(np.random.default_rng(12))
    cams = room.camera_centres()
    sc = _with_cameras(room, cams)
    sc.image_names[:] = [f"{i * 20:05d}.jpg" for i in range(len(cams))]  # 20 frames between each
    cams[30:] += np.array([0.9, 0.0, 0.0])  # a 0.9 m step over 20 frames: walking, not a jump
    sc2 = _with_cameras(room, cams)
    sc2.image_names[:] = sc.image_names
    assert main_path_fraction(sc2) == 1.0
