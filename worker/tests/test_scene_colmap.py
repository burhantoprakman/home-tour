import numpy as np

from pipeline.colmap import make_pairs
from pipeline.scene import Scene, read_colmap_text


def test_make_pairs_sequential_plus_keyframes():
    names = [f"{i:05d}.jpg" for i in range(100)]
    pairs = make_pairs(names, window=5, keyframe_every=10)
    s = set(pairs)
    assert ("00000.jpg", "00005.jpg") in s and ("00000.jpg", "00006.jpg") not in s
    assert ("00000.jpg", "00090.jpg") in s  # loop closure between keyframes
    assert len(s) == len(pairs)
    assert all(a < b for a, b in pairs)


def test_read_colmap_text(tmp_path):
    (tmp_path / "cameras.txt").write_text(
        "# Camera list\n1 PINHOLE 640 480 500 510 320 240\n2 SIMPLE_PINHOLE 320 240 250 160 120\n")
    # identity rotation, translation (1,2,3); second image has an empty points line
    (tmp_path / "images.txt").write_text(
        "# Image list\n"
        "2 1 0 0 0 0 0 0 2 00002.jpg\n\n"
        "1 1 0 0 0 1 2 3 1 00001.jpg\n10 20 -1 30 40 5\n")
    (tmp_path / "points3D.txt").write_text(
        "# 3D points\n"
        "1 0.5 0.5 0.5 255 0 0 0.5 1 0 2 0 1 1\n"  # track 3, ok
        "2 9 9 9 0 255 0 5.0 1 0 2 0 1 1\n"  # error too high
        "3 1 1 1 0 0 255 0.1 1 0\n")  # track too short
    sc = read_colmap_text(tmp_path)
    assert sc.image_names == ["00001.jpg", "00002.jpg"]
    assert np.allclose(sc.K[0], [[500, 0, 320], [0, 510, 240], [0, 0, 1]])
    assert np.allclose(sc.K[1], [[250, 0, 160], [0, 250, 120], [0, 0, 1]])
    assert np.allclose(sc.camera_centres()[0], [-1, -2, -3])
    assert sc.points.shape == (1, 3) and sc.colors.tolist() == [[255, 0, 0]]


def test_scene_npz_roundtrip(tmp_path):
    sc = Scene(["a.jpg"], np.eye(3)[None], np.array([4]), np.array([3]), np.eye(4)[None],
               np.ones((2, 3)), np.zeros((2, 3), np.uint8))
    sc.save_npz(tmp_path / "s.npz")
    back = Scene.load_npz(tmp_path / "s.npz")
    assert back.image_names == ["a.jpg"] and np.allclose(back.w2c, sc.w2c)
