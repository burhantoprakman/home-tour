import sqlite3
import struct

import numpy as np
import pytest

from pipeline.intrinsics import (PAIR_ID_BASE, candidate_windows, QT_FOCAL_35MM_KEY, choose_window, focal_35mm_from_video,
                                 focal_px_from_35mm, pair_inliers, quicktime_metadata, read_cameras,
                                 read_cameras_bin, write_focal_prior)


def atom(typ: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + typ + payload


def mdta_meta(items: dict[str, str | bytes]) -> bytes:
    keys = b"".join(atom(b"mdta", k.encode()) for k in items)
    ilst = b""
    for i, v in enumerate(items.values(), start=1):
        typ, raw = (1, v.encode()) if isinstance(v, str) else (23, v)
        data = atom(b"data", struct.pack(">II", typ, 0) + raw)
        ilst += atom(struct.pack(">I", i), data)
    hdlr = atom(b"hdlr", b"\0" * 8 + b"mdta" + b"\0" * 12)
    return atom(b"meta", hdlr + atom(b"keys", struct.pack(">II", 0, len(items)) + keys) + atom(b"ilst", ilst))


def write_mov(path, moov_meta=None, trak_meta=None):
    moov = b""
    if moov_meta:
        moov += mdta_meta(moov_meta)
    trak = atom(b"tkhd", b"\0" * 84) + (mdta_meta(trak_meta) if trak_meta else b"")
    moov += atom(b"trak", trak)
    path.write_bytes(atom(b"ftyp", b"qt  \0\0\0\0qt  ") + atom(b"mdat", b"\0" * 64) + atom(b"moov", moov))
    return path


def test_reads_track_level_focal_like_an_iphone(tmp_path):
    mov = write_mov(tmp_path / "v.mov", moov_meta={"com.apple.quicktime.make": "Apple"},
                    trak_meta={"com.apple.quicktime.camera.lens_model": "iPhone 17 back camera 2.22mm f/2.2",
                               QT_FOCAL_35MM_KEY: "14", "com.apple.quicktime.apple-maker-note.74": b"\0\0\0\4"})
    meta = quicktime_metadata(mov)
    assert meta["com.apple.quicktime.make"] == "Apple"
    assert meta["com.apple.quicktime.camera.lens_model"].startswith("iPhone 17")
    assert focal_35mm_from_video(mov) == 14.0


def test_no_or_bad_focal_metadata(tmp_path):
    assert focal_35mm_from_video(write_mov(tmp_path / "a.mov", moov_meta={"com.apple.quicktime.make": "x"})) is None
    assert focal_35mm_from_video(write_mov(tmp_path / "b.mov", trak_meta={QT_FOCAL_35MM_KEY: "abc"})) is None
    assert focal_35mm_from_video(write_mov(tmp_path / "c.mov", trak_meta={QT_FOCAL_35MM_KEY: "0"})) is None
    (tmp_path / "d.mp4").write_bytes(b"not a quicktime file")
    assert focal_35mm_from_video(tmp_path / "d.mp4") is None


def test_focal_px_from_35mm():
    # 36 x 24 mm frame at 36 x 24 px: 1 px per mm, so f px == f mm.
    assert focal_px_from_35mm(50, 36, 24) == pytest.approx(50)
    assert focal_px_from_35mm(14, 900, 1600) == pytest.approx(594.0, abs=0.1)


def make_db(path, model=2, params=(1920.0, 450.0, 800.0, 0.0), names=("a.jpg", "b.jpg", "c.jpg")):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE cameras (camera_id INTEGER PRIMARY KEY, model INTEGER NOT NULL, width INTEGER NOT NULL,"
                " height INTEGER NOT NULL, params BLOB, prior_focal_length INTEGER NOT NULL)")
    con.execute("CREATE TABLE images (image_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, camera_id INTEGER)")
    con.execute("CREATE TABLE two_view_geometries (pair_id INTEGER PRIMARY KEY, rows INTEGER NOT NULL)")
    con.execute("INSERT INTO cameras VALUES (1, ?, 900, 1600, ?, 0)",
                (model, np.array(params, dtype="<f8").tobytes()))
    for i, n in enumerate(names, start=1):
        con.execute("INSERT INTO images VALUES (?, ?, 1)", (i, n))
    con.commit()
    con.close()
    return path


def test_write_focal_prior_round_trips_params_blob(tmp_path):
    db = make_db(tmp_path / "d.db")
    (cam,) = read_cameras(db)
    assert cam.focal == 1920.0 and not cam.prior_focal_length
    assert write_focal_prior(db, 731.5) == 1
    (cam,) = read_cameras(db)
    assert cam.prior_focal_length and cam.model == 2
    np.testing.assert_array_equal(cam.params, [731.5, 450.0, 800.0, 0.0])  # cx, cy, k untouched
    with pytest.raises(ValueError):
        write_focal_prior(db, float("nan"))


def test_write_focal_prior_pinhole_sets_fx_and_fy(tmp_path):
    db = make_db(tmp_path / "d.db", model=1, params=(1000.0, 990.0, 450.0, 800.0))
    write_focal_prior(db, 700.0)
    (cam,) = read_cameras(db)
    np.testing.assert_array_equal(cam.params, [700.0, 700.0, 450.0, 800.0])


def test_pair_inliers_decodes_pair_ids(tmp_path):
    db = make_db(tmp_path / "d.db")
    con = sqlite3.connect(db)
    con.executemany("INSERT INTO two_view_geometries VALUES (?, ?)",
                    [(1 * PAIR_ID_BASE + 2, 100), (2 * PAIR_ID_BASE + 3, 50), (1 * PAIR_ID_BASE + 3, 0)])
    con.commit()
    con.close()
    assert pair_inliers(db) == {("a.jpg", "b.jpg"): 100, ("b.jpg", "c.jpg"): 50}


def test_choose_window_picks_the_best_matched_stretch():
    names = [f"{i:03d}" for i in range(100)]
    inl = {(names[i], names[i + 1]): 10 for i in range(99)}
    for i in range(60, 79):  # frames 60..79 are much better matched
        inl[(names[i], names[i + 1])] = 500
        inl[(names[i], names[i + 2])] = 300
    inl[(names[0], names[99])] = 10_000  # a loop closure longer than the window doesn't count
    w = choose_window(names, inl, size=20)
    assert w == names[60:80]
    assert choose_window(names[:5], inl, size=20) == names[:5]


def test_read_cameras_bin(tmp_path):
    p = tmp_path / "cameras.bin"
    p.write_bytes(struct.pack("<Q", 1) + struct.pack("<IiQQ", 1, 2, 900, 1600) + struct.pack("<4d", 731.0, 450, 800, 0.08))
    ((cid, model, w, h, params),) = read_cameras_bin(p)
    assert (cid, model, w, h) == (1, 2, 900, 1600) and params[0] == 731.0


def test_candidate_windows_fall_back_to_other_parts_of_the_walk():
    names = [f"{i:05d}.jpg" for i in range(200)]
    inl = {(names[i], names[i + 1]): 500 for i in range(90, 100)}  # a static stretch scores best
    ws = candidate_windows(names, inl, size=40, attempts=3)
    assert len(ws) == 3 and all(len(w) == 40 for w in ws)
    starts = [names.index(w[0]) for w in ws]
    assert all(abs(a - b) >= 40 for i, a in enumerate(starts) for b in starts[i + 1:])
    assert candidate_windows(names[:30], inl, size=40) == [names[:30]]
