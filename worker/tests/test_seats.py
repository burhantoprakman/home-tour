import json
import math

import numpy as np
import open3d as o3d

from pipeline.collision import add_box_walls, add_floor, export_glb
from pipeline.seats import detect_seats, find_patches, write_seats


def box(lo, hi, yaw=0.0, pivot=(0.0, 0.0)):
    """Closed box mesh from lo to hi, rotated by yaw (radians, about +Y) around pivot (x, z)."""
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    m = o3d.geometry.TriangleMesh.create_box(*(hi - lo))
    m.translate(lo)
    if yaw:
        R = m.get_rotation_matrix_from_xyz((0.0, yaw, 0.0))
        m.rotate(R, center=(pivot[0], 0.0, pivot[1]))
    return m


def room_with(*parts):
    """4 x 2.6 x 4 m room (floor fill + walls like collision.py) plus furniture boxes."""
    m = o3d.geometry.TriangleMesh()
    for p in parts:
        m += p
    lo, hi = np.array([-2.0, -0.2, -2.0]), np.array([2.0, 2.6, 2.0])
    m = add_floor(m, np.array([[-2, -2], [2, -2], [2, 2], [-2, 2]], float))
    m = add_box_walls(m, lo, hi)
    return np.asarray(m.vertices), np.asarray(m.triangles)


def facing(yaw):
    return np.array([-math.sin(yaw), -math.cos(yaw)])  # x, z


def couch(yaw=0.0, pivot=(0.0, 0.0)):
    """2.0 m couch along X: seat top at 0.45 m spanning z in [0, 0.8], backrest behind at z<0."""
    seat = box([-1.0, 0.0, 0.0], [1.0, 0.45, 0.8], yaw, pivot)
    back = box([-1.0, 0.0, -0.2], [1.0, 0.85, 0.0], yaw, pivot)
    return seat, back


def test_couch_gives_three_seats_facing_away_from_backrest():
    seat, back = couch()
    v, t = room_with(seat, back)
    seats = detect_seats(v, t)
    assert len(seats) == 3
    for s in seats:
        assert s["confirmed"] is False
        x, y, z = s["position"]
        assert abs(y - 0.45) < 0.02
        assert 0.3 < z < 0.5
        assert np.allclose(facing(s["facingYaw"]), [0, 1], atol=0.05)  # +Z, away from the back
    xs = sorted(s["position"][0] for s in seats)
    assert np.allclose(xs, [-2 / 3, 0, 2 / 3], atol=0.08)
    assert len({s["id"] for s in seats}) == 3


def test_rotated_couch_faces_away_from_backrest():
    yaw = math.radians(30)
    seat, back = couch(yaw)
    v, t = room_with(seat, back)
    seats = detect_seats(v, t)
    assert len(seats) == 3
    # Box rotated by +30 deg about Y: its local +Z (the open front) maps to (sin, 0, cos).
    want = np.array([math.sin(yaw), math.cos(yaw)])
    for s in seats:
        assert np.allclose(facing(s["facingYaw"]), want, atol=0.05)


def test_rejects_tables_steps_and_stools():
    table = box([0.5, 0.0, 0.5], [1.5, 0.75, 1.3])  # too high
    step = box([-1.5, 0.0, 0.5], [-0.5, 0.2, 1.3])  # too low
    stool = box([-1.5, 0.0, -1.5], [-1.25, 0.45, -1.25])  # too small (25 cm square)
    v, t = room_with(table, step, stool)
    assert detect_seats(v, t) == []


def test_armchair_without_backrest_faces_room_centre():
    pouf = box([1.0, 0.0, -0.3], [1.5, 0.5, 0.3])  # 50 x 60 cm ottoman east of centre
    v, t = room_with(pouf)
    seats = detect_seats(v, t)
    assert len(seats) == 1
    assert abs(seats[0]["position"][1] - 0.5) < 0.02
    assert np.allclose(facing(seats[0]["facingYaw"]), [-1, 0], atol=0.05)  # towards x=0


def test_patch_size_and_empty_room():
    seat, back = couch()
    v, t = room_with(seat, back)
    (p,) = find_patches(v, t)
    assert abs(p.length - 2.0) < 0.1 and abs(p.width - 0.8) < 0.1
    v, t = room_with()
    assert detect_seats(v, t) == []


def test_write_seats_round_trips_through_glb(tmp_path):
    seat, back = couch()
    v, t = room_with(seat, back)
    glb = tmp_path / "collision.glb"
    export_glb(o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(v), o3d.utility.Vector3iVector(t)), glb)
    path, seats = write_seats(tmp_path, glb)
    assert path.name == "seats.json"
    data = json.loads(path.read_text())
    assert data == seats and len(data) == 3
    assert set(data[0]) == {"id", "position", "facingYaw", "confirmed"}
