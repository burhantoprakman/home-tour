import numpy as np
import pytest

import open3d as o3d

from pipeline.collision import build_collision, crop_box_from_points

ROOM_MIN = np.array([-2.0, 0.0, -1.5])
ROOM_MAX = np.array([2.0, 2.5, 1.5])


def _w2c(centre, yaw, pitch):
    fwd = np.array([np.cos(pitch) * np.cos(yaw), np.sin(pitch), np.cos(pitch) * np.sin(yaw)])
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = -R @ centre
    return M


def _box_depth(M, K, w, h):
    """Analytic z-depth from inside an axis-aligned box room."""
    R, t = M[:3, :3], M[:3, 3]
    c = -R.T @ t
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    rays_cam = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1)
    d = rays_cam @ R  # world dirs (R^T x per pixel)
    with np.errstate(divide="ignore", invalid="ignore"):
        t_hi = np.where(d > 0, (ROOM_MAX - c) / d, (ROOM_MIN - c) / d)
    t_exit = np.nanmin(np.where(np.isfinite(t_hi) & (t_hi > 0), t_hi, np.inf), axis=-1)
    return t_exit.astype(np.float32)  # rays_cam has z=1, so t is z-depth


def test_box_room_becomes_lowpoly_glb(tmp_path):
    w, h = 160, 120
    K = np.array([[100.0, 0, 80], [0, 100.0, 60], [0, 0, 1]])
    poses = []
    for yaw in np.linspace(0, 2 * np.pi, 24, endpoint=False):
        for pitch in (-0.9, -0.3, 0.4):
            poses.append(_w2c(np.array([0.3 * np.cos(yaw), 1.4, 0.3 * np.sin(yaw)]), yaw, pitch))
    w2cs = np.array(poses)
    depths = [_box_depth(M, K, w, h) for M in w2cs]
    out = tmp_path / "collision.glb"
    stats = build_collision(depths, np.repeat(K[None], len(w2cs), 0), w2cs, out, target_triangles=2000)
    assert out.read_bytes()[:4] == b"glTF"
    back = o3d.io.read_triangle_mesh(str(out))  # independent reader (Assimp)
    assert len(back.triangles) == stats.triangles and len(back.vertices) == stats.vertices
    assert stats.triangles <= 2000 < stats.raw_triangles
    lo, hi = np.array(stats.bounds_min), np.array(stats.bounds_max)
    # floor at y~0, ceiling ~2.5, walls at the box extents (within a few voxels)
    assert abs(lo[1] - 0.0) < 0.1 and abs(hi[1] - 2.5) < 0.1
    assert np.all(np.abs(lo[[0, 2]] - ROOM_MIN[[0, 2]]) < 0.1)
    assert np.all(np.abs(hi[[0, 2]] - ROOM_MAX[[0, 2]]) < 0.1)


def test_crop_removes_geometry_outside_room(tmp_path):
    w, h = 160, 120
    K = np.array([[100.0, 0, 80], [0, 100.0, 60], [0, 0, 1]])
    w2cs = np.array([_w2c(np.array([0.0, 1.4, 0.0]), yaw, p)
                     for yaw in np.linspace(0, 2 * np.pi, 16, endpoint=False) for p in (-0.6, 0.2)])
    depths = [_box_depth(M, K, w, h) for M in w2cs]
    rng = np.random.default_rng(0)
    pts = rng.uniform(ROOM_MIN, ROOM_MAX, (5000, 3))
    lo, hi = crop_box_from_points(pts, margin=-0.5)  # deliberately tight: inside the walls
    stats = build_collision(depths, np.repeat(K[None], len(w2cs), 0), w2cs, tmp_path / "c.glb",
                            target_triangles=2000, box=(lo, hi))
    assert np.all(np.array(stats.bounds_min)[[0, 2]] >= lo[[0, 2]] - 1e-6)
    assert np.all(np.array(stats.bounds_max) <= hi + 1e-6)


def test_floor_fill_covers_camera_path_and_faces_up(tmp_path):
    from pipeline.collision import add_floor, convex_hull_2d

    hull = convex_hull_2d(np.array([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]))
    assert len(hull) == 4
    empty = o3d.geometry.TriangleMesh()
    m = add_floor(empty, np.array([[-1.0, -1.0], [2.0, -1.0], [2.0, 1.5], [-1.0, 1.5], [0.3, 0.2]]))
    m.compute_triangle_normals()
    n = np.asarray(m.triangle_normals)
    assert len(n) == 2 and np.all(n[:, 1] > 0.99)
    assert np.allclose(np.asarray(m.vertices)[:, 1], 0.0)


def test_crop_top_follows_cameras():
    pts = np.c_[np.zeros(100), np.linspace(0, 0.5, 100), np.zeros(100)]  # points only near the floor
    lo, hi = crop_box_from_points(pts, np.array([[0.0, 1.45, 0.0]]))
    assert hi[1] == pytest.approx(1.45 + 1.2)


def test_crop_top_ignores_a_stray_high_camera():
    """Job 9acd3d47: one camera registered 12 m up made 13 m walls."""
    pts = np.c_[np.zeros(100), np.linspace(0, 2.4, 100), np.zeros(100)]
    lo, hi = crop_box_from_points(pts, np.array([[0.0, 1.4, 0.0], [0.0, 12.1, 0.0]]))
    assert hi[1] <= 3.5


def test_build_collision_adds_floor_under_cameras(tmp_path):
    w, h = 160, 120
    K = np.array([[100.0, 0, 80], [0, 100.0, 60], [0, 0, 1]])
    cams = np.array([[0.3 * np.cos(a), 1.4, 0.3 * np.sin(a)] for a in np.linspace(0, 2 * np.pi, 16, endpoint=False)])
    w2cs = np.array([_w2c(c, a, 0.3) for c, a in zip(cams, np.linspace(0, 2 * np.pi, 16, endpoint=False))])  # never look down
    depths = [_box_depth(M, K, w, h) for M in w2cs]
    out = tmp_path / "c.glb"
    build_collision(depths, np.repeat(K[None], 16, 0), w2cs, out, target_triangles=2000, cam_centres=cams)
    m = o3d.io.read_triangle_mesh(str(out))
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(m))
    ray = o3d.core.Tensor([[0.0, 1.0, 0.0, 0.0, -1.0, 0.0]], dtype=o3d.core.Dtype.Float32)
    hit = scene.cast_rays(ray)["t_hit"].numpy()[0]
    assert hit == pytest.approx(1.0, abs=0.05)  # straight down from (0,1,0) hits the floor at y=0


def test_floor_fill_reaches_crop_box_edges(tmp_path):
    w, h = 160, 120
    K = np.array([[100.0, 0, 80], [0, 100.0, 60], [0, 0, 1]])
    angles = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    cams = np.array([[0.3 * np.cos(a), 1.4, 0.3 * np.sin(a)] for a in angles])
    w2cs = np.array([_w2c(c, a, 0.3) for c, a in zip(cams, angles)])
    depths = [_box_depth(M, K, w, h) for M in w2cs]
    box = (np.array([-1.8, -0.2, -1.8]), np.array([1.8, 2.6, 1.8]))
    out = tmp_path / "c.glb"
    build_collision(depths, np.repeat(K[None], 16, 0), w2cs, out, target_triangles=2000, box=box, cam_centres=cams)
    m = o3d.io.read_triangle_mesh(str(out))
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(m))
    ray = o3d.core.Tensor([[1.7, 1.0, -1.7, 0.0, -1.0, 0.0]], dtype=o3d.core.Dtype.Float32)  # far from the path
    hit = scene.cast_rays(ray)["t_hit"].numpy()[0]
    assert hit == pytest.approx(1.0, abs=0.05)


def test_box_walls_close_the_room(tmp_path):
    from pipeline.collision import add_box_walls

    m = add_box_walls(o3d.geometry.TriangleMesh(), np.array([-1.0, -0.2, -2.0]), np.array([1.0, 2.5, 2.0]))
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(m))
    a = np.linspace(0, 2 * np.pi, 36, endpoint=False)
    rays = np.c_[np.zeros(36), np.full(36, 1.0), np.zeros(36), np.cos(a), np.zeros(36), np.sin(a)]
    assert np.all(np.isfinite(scene.cast_rays(o3d.core.Tensor(rays.astype(np.float32)))["t_hit"].numpy()))
    m.compute_triangle_normals()
    v, t, n = np.asarray(m.vertices), np.asarray(m.triangles), np.asarray(m.triangle_normals)
    inward = (-v[t].mean(axis=1))[:, [0, 2]]  # towards the centre in x/z
    assert np.all(np.sum(n[:, [0, 2]] * inward, axis=1) > 0)


def _box_mesh(lo, hi) -> o3d.geometry.TriangleMesh:
    m = o3d.geometry.TriangleMesh.create_box(*(np.array(hi) - np.array(lo)))
    m.translate(np.array(lo, dtype=np.float64))
    return m.subdivide_midpoint(3)


def _line_path(x0, x1, z, n=20, y=1.4):
    return np.c_[np.linspace(x0, x1, n), np.full(n, y), np.full(n, z)]


def test_carving_removes_floaters_on_the_camera_path_only():
    from pipeline.collision import carve_walked_space

    floater = _box_mesh([0.4, 0.6, -0.1], [0.6, 0.9, 0.1])  # right on the walked line
    couch = _box_mesh([0.0, 0.0, 0.8], [1.5, 0.45, 1.6])  # 0.8 m beside it
    floor = _box_mesh([-1.0, -0.02, -1.0], [2.0, 0.0, 1.0])  # top at y=0: below CARVE_MIN_Y_M
    mesh = floater + couch + floor
    cams = _line_path(-0.5, 1.5, 0.0)
    out, n = carve_walked_space(mesh, cams)
    v = np.asarray(out.vertices)
    assert n == len(np.asarray(floater.triangles))
    assert not np.any((np.abs(v[:, 2]) < 0.2) & (v[:, 1] > 0.5))  # floater gone
    assert len(out.triangles) == len(couch.triangles) + len(floor.triangles)


def test_carving_ignores_crouched_and_flying_cameras():
    from pipeline.collision import carve_walked_space

    table = _box_mesh([0.4, 0.0, -0.2], [0.8, 0.45, 0.2])
    for y in (0.6, 2.6):  # held low over the table / mis-registered up in the air
        out, n = carve_walked_space(table, _line_path(0.0, 1.2, 0.0, y=y))
        assert n == 0 and len(out.triangles) == len(table.triangles)


def test_cameras_off_the_main_path_carve_less():
    """A broken-off piece of the path may be ~1 m off, so it only clears 0.2 m around itself."""
    from pipeline.collision import carve_walked_space, path_pieces

    couch = _box_mesh([0.0, 0.0, 0.3], [1.5, 0.45, 1.1])  # 0.3 m from the z=0 line
    main = _line_path(-3.0, -1.0, -2.0, n=40)
    stray = _line_path(0.0, 1.5, 0.0, n=10)
    cams = np.vstack([main, stray])
    assert [len(p) for p in path_pieces(cams)] == [40, 10]
    out, n = carve_walked_space(couch, cams)
    assert n == 0
    out, n = carve_walked_space(couch, np.vstack([stray, _line_path(1.5, 1.5, 0.0, n=1)]))
    assert n > 0  # the same cameras as the main piece clear 0.35 m and cut into it


def test_recarve_published_collision_keeps_floor_and_walls(tmp_path):
    from pipeline.collision import close_room, export_glb, recarve_collision, strip_room_closure

    box = (np.array([-2.0, -0.2, -2.0]), np.array([2.0, 2.6, 2.0]))
    cams = _line_path(-1.0, 1.0, 0.0)
    floater = _box_mesh([-0.1, 0.5, -0.1], [0.1, 1.2, 0.1])
    wall = _box_mesh([-1.9, 0.01, 1.7], [1.9, 2.4, 1.8])  # TSDF geometry never lies exactly on y=0
    published = close_room(floater + wall, cams, box)
    assert len(strip_room_closure(published, box).triangles) == len((floater + wall).triangles)
    glb = tmp_path / "in.glb"
    export_glb(published, glb)
    stats = recarve_collision(glb, tmp_path / "out.glb", cams, box)
    assert stats.carved_triangles == len(floater.triangles)
    m = o3d.io.read_triangle_mesh(str(tmp_path / "out.glb"))
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(m))
    rays = np.array([[0.0, 1.0, 0.0, 0.0, -1.0, 0.0],  # floor under the old floater
                     [0.0, 1.0, 0.0, 1.0, 0.0, 0.0],  # box wall at x=2
                     [0.0, 1.0, 0.0, 0.0, 0.0, 1.0]], dtype=np.float32)  # real wall at z=1.7
    hit = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
    assert hit == pytest.approx([1.0, 2.0, 1.7], abs=0.02)


def test_crop_box_leaves_room_around_the_camera_path():
    from pipeline.collision import crop_box_from_points

    rng = np.random.default_rng(0)
    pts = rng.uniform([-2, 0, -2], [2, 2.5, 2], size=(5000, 3))
    cams = np.array([[0.0, 1.4, -2.3], [0.0, 1.4, 0.0], [0.0, 1.4, 2.0]])  # starts past the points
    lo, hi = crop_box_from_points(pts, cams, margin=0.5)
    assert lo[2] <= -2.3 - 0.5 + 1e-9
    assert hi[2] >= 2.0 + 0.5 - 1e-9
