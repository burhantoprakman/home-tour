"""Focal-length prior for GLOMAP.

ffmpeg frames carry no EXIF, so COLMAP starts every camera at f = 1.2 x the long side with
no prior, and GLOMAP (global_mapper) can settle on a wrong focal and fold the room (newsalon:
844 px vs 731 px from the incremental mapper). Sources, in order (colmap.focal_prior):
  1. self-calibration: the incremental mapper on a short window of well-matched frames,
     reusing the database's matches; its refined focal is the prior (newsalon: 731 px, 19 s).
  2. video metadata: iPhones store camera.focal_length.35mm_equivalent in a track-level
     QuickTime `meta` atom (ffprobe doesn't show it). It's the lens's nominal value, so it
     ignores the stabilisation crop (newsalon: 14 mm -> 594 px) and is only a fallback.
The prior is written into the database's single shared camera with prior_focal_length=1;
global_mapper still refines it (ba_refine_focal_length defaults to 1).
"""

from __future__ import annotations

import math
import sqlite3
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator

import numpy as np

QT_FOCAL_35MM_KEY = "com.apple.quicktime.camera.focal_length.35mm_equivalent"
FULL_FRAME_DIAGONAL_MM = math.hypot(36.0, 24.0)
CALIB_WINDOW = 40
PAIR_ID_BASE = 2147483647  # COLMAP: pair_id = id1 * 2^31-1 + id2 (id1 < id2)
# COLMAP camera models whose params start with a single focal (f, cx, cy, ...) vs fx, fy.
SINGLE_FOCAL_MODELS = {0: 3, 2: 4, 3: 5, 8: 4, 9: 5}  # model id -> param count
DUAL_FOCAL_MODELS = {1: 4, 4: 8, 5: 8, 6: 12, 7: 9, 10: 14}


# ---- 1. QuickTime metadata -------------------------------------------------------------------

def _atoms(f: BinaryIO, start: int, end: int) -> Iterator[tuple[str, int, int]]:
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        size, typ = struct.unpack(">I4s", f.read(8))
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", f.read(8))[0]
            hdr = 16
        elif size == 0:
            size = end - pos
        if size < hdr:
            return
        yield typ.decode("latin1"), pos + hdr, pos + size
        pos += size


def _meta_items(f: BinaryIO, start: int, end: int) -> dict[str, bytes | str]:
    """keys + ilst of one mdta `meta` atom -> {key: value} (UTF-8 values as str)."""
    keys: dict[int, str] = {}
    vals: dict[int, bytes | str] = {}
    for t, a, b in _atoms(f, start, end):
        if t == "keys":
            f.seek(a + 4)
            n = struct.unpack(">I", f.read(4))[0]
            p = a + 8
            for i in range(1, n + 1):
                f.seek(p)
                sz = struct.unpack(">I", f.read(4))[0]
                f.read(4)  # namespace, e.g. mdta
                keys[i] = f.read(max(0, sz - 8)).decode("utf-8", errors="replace")
                p += sz
        elif t == "ilst":
            for t2, a2, b2 in _atoms(f, a, b):
                idx = struct.unpack(">I", t2.encode("latin1"))[0]
                for t3, a3, b3 in _atoms(f, a2, b2):
                    if t3 == "data":
                        f.seek(a3)
                        typ = struct.unpack(">I", f.read(4))[0] & 0xFFFFFF
                        f.read(4)  # locale
                        raw = f.read(b3 - a3 - 8)
                        vals[idx] = raw.decode("utf-8", errors="replace") if typ == 1 else raw
    return {keys[i]: v for i, v in vals.items() if i in keys}


def quicktime_metadata(video: Path) -> dict[str, bytes | str]:
    """All mdta key/values in moov/meta and moov/trak/meta (later ones don't override)."""
    out: dict[str, bytes | str] = {}
    with Path(video).open("rb") as f:
        f.seek(0, 2)
        end = f.tell()
        for t, a, b in _atoms(f, 0, end):
            if t != "moov":
                continue
            for t2, a2, b2 in _atoms(f, a, b):
                if t2 == "meta":
                    out = {**_meta_items(f, a2, b2), **out}
                elif t2 == "trak":
                    for t3, a3, b3 in _atoms(f, a2, b2):
                        if t3 == "meta":
                            out = {**_meta_items(f, a3, b3), **out}
    return out


def focal_35mm_from_video(video: Path) -> float | None:
    try:
        v = quicktime_metadata(video).get(QT_FOCAL_35MM_KEY)
    except (OSError, struct.error):
        return None
    try:
        f = float(v) if isinstance(v, str) else None
    except ValueError:
        return None
    return f if f and 5.0 <= f <= 300.0 else None


def focal_px_from_35mm(f35: float, width: int, height: int) -> float:
    """35 mm-equivalent focal -> pixels, by the diagonal (the EXIF definition)."""
    return f35 * math.hypot(width, height) / FULL_FRAME_DIAGONAL_MM


# ---- COLMAP database camera ------------------------------------------------------------------

@dataclass(frozen=True)
class DbCamera:
    camera_id: int
    model: int
    width: int
    height: int
    params: np.ndarray
    prior_focal_length: bool

    @property
    def focal(self) -> float:
        if self.model in DUAL_FOCAL_MODELS:
            return float(np.sqrt(self.params[0] * self.params[1]))
        return float(self.params[0])


def read_cameras(db: Path) -> list[DbCamera]:
    with sqlite3.connect(db) as con:
        rows = con.execute("SELECT camera_id, model, width, height, params, prior_focal_length FROM cameras").fetchall()
    return [DbCamera(r[0], r[1], r[2], r[3], np.frombuffer(r[4], dtype="<f8").copy(), bool(r[5])) for r in rows]


def write_focal_prior(db: Path, focal: float) -> int:
    """Set every camera's focal to `focal` and mark it as a prior. Returns cameras updated."""
    if not (math.isfinite(focal) and focal > 0):
        raise ValueError(f"bad focal {focal!r}")
    n = 0
    with sqlite3.connect(db) as con:
        for cid, model, blob in con.execute("SELECT camera_id, model, params FROM cameras").fetchall():
            p = np.frombuffer(blob, dtype="<f8").copy()
            if model in SINGLE_FOCAL_MODELS:
                p[0] = focal
            elif model in DUAL_FOCAL_MODELS:
                p[0] = p[1] = focal
            else:
                continue
            con.execute("UPDATE cameras SET params = ?, prior_focal_length = 1 WHERE camera_id = ?",
                        (p.astype("<f8").tobytes(), cid))
            n += 1
    return n


def read_cameras_bin(path: Path) -> list[tuple[int, int, int, int, np.ndarray]]:
    """COLMAP sparse model cameras.bin -> [(id, model, width, height, params)]."""
    counts = {**SINGLE_FOCAL_MODELS, **DUAL_FOCAL_MODELS}
    out = []
    with Path(path).open("rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            cid, model, w, h = struct.unpack("<IiQQ", f.read(24))
            k = counts[model]
            out.append((cid, model, w, h, np.array(struct.unpack(f"<{k}d", f.read(8 * k)))))
    return out


# ---- 2. self-calibration on a short window ---------------------------------------------------

def pair_inliers(db: Path) -> dict[tuple[str, str], int]:
    """Verified inlier count per image-name pair (two_view_geometries)."""
    with sqlite3.connect(db) as con:
        names = dict(con.execute("SELECT image_id, name FROM images").fetchall())
        rows = con.execute("SELECT pair_id, rows FROM two_view_geometries WHERE rows > 0").fetchall()
    out = {}
    for pid, n in rows:
        a, b = divmod(int(pid), PAIR_ID_BASE)
        if a in names and b in names:
            out[(names[a], names[b])] = int(n)
    return out


def choose_window(names: list[str], inliers: dict[tuple[str, str], int], size: int = CALIB_WINDOW) -> list[str]:
    """The `size` consecutive frames (time order) with the most verified inliers between them."""
    if len(names) <= size:
        return list(names)
    idx = {n: i for i, n in enumerate(names)}
    # Each pair counts towards every window that contains both frames: prefix sums over the
    # window start s, for pairs (i, j) with j - i < size, cover starts j-size+1 .. i.
    diff = np.zeros(len(names) + 1)
    for (a, b), n in inliers.items():
        if a not in idx or b not in idx:
            continue
        i, j = sorted((idx[a], idx[b]))
        if j - i >= size:
            continue
        lo, hi = max(0, j - size + 1), min(i, len(names) - size)
        if lo <= hi:
            diff[lo] += n
            diff[hi + 1] -= n
    score = np.cumsum(diff)[: len(names) - size + 1]
    s = int(np.argmax(score))
    return names[s:s + size]


CALIB_ATTEMPTS = 3


def candidate_windows(names: list[str], inliers: dict[tuple[str, str], int], size: int = CALIB_WINDOW,
                      attempts: int = CALIB_ATTEMPTS) -> list[list[str]]:
    """The best-matched window first, then non-overlapping windows spread over the video.

    The best-matched stretch is often the camera barely moving (little parallax), where the
    mapper can collapse after a few frames, so the fallbacks come from elsewhere in the walk.
    """
    first = choose_window(names, inliers, size)
    out = [first]
    if len(names) <= size:
        return out
    taken = [names.index(first[0])]
    for frac in (0.25, 0.75, 0.5, 0.1, 0.9):
        if len(out) >= attempts:
            break
        s = min(int(frac * (len(names) - size)), len(names) - size)
        if all(abs(s - t) >= size for t in taken):
            taken.append(s)
            out.append(names[s:s + size])
    return out


def _calibrate_window(db: Path, frames_dir: Path, window: list[str], out_dir: Path, log: Path) -> float | None:
    out_dir.mkdir(parents=True, exist_ok=True)
    lst = out_dir / "images.txt"
    lst.write_text("".join(n + "\n" for n in window))
    model_dir = out_dir / "sparse"
    model_dir.mkdir(exist_ok=True)
    cmd = ["colmap", "mapper", "--database_path", str(db), "--image_path", str(frames_dir),
           "--output_path", str(model_dir), "--Mapper.image_list_path", str(lst),
           "--Mapper.multiple_models", "0"]
    res = subprocess.run(cmd, capture_output=True, text=True)
    with log.open("a") as f:
        f.write("$ " + " ".join(cmd) + "\n" + res.stdout + res.stderr + "\n")
    best: tuple[int, float] | None = None
    for d in sorted(p for p in model_dir.iterdir() if p.is_dir()):
        cams, images_bin = d / "cameras.bin", d / "images.bin"
        if not (cams.exists() and images_bin.exists()):
            continue
        with images_bin.open("rb") as f:
            n_reg = int.from_bytes(f.read(8), "little")
        cam = read_cameras_bin(cams)[0]
        focal = float(np.sqrt(cam[4][0] * cam[4][1])) if cam[1] in DUAL_FOCAL_MODELS else float(cam[4][0])
        if best is None or n_reg > best[0]:
            best = (n_reg, focal)
    if best is None or best[0] < len(window) // 2:
        return None
    return best[1]


def self_calibrate(db: Path, frames_dir: Path, names: list[str], out_dir: Path, log: Path,
                   size: int = CALIB_WINDOW) -> float | None:
    """Incremental mapper on short windows (best-matched first); the first refined focal (px) wins."""
    for k, window in enumerate(candidate_windows(names, pair_inliers(db), size)):
        f = _calibrate_window(db, frames_dir, window, out_dir / f"try{k}", log)
        print(f"[solve] self-calibration window {k} ({window[0]}..{window[-1]}): "
              + (f"focal {f:.1f} px" if f else "failed"), flush=True)
        if f is not None:
            return f
    return None
