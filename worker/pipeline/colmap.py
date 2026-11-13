"""Stage 2: camera solve with COLMAP 4.x on the CPU.

SIFT features -> matches on a custom pair list (sequential window + keyframe all-pairs for
loop closure) -> focal prior (a 40-frame incremental self-calibration, else video metadata;
see intrinsics.py) -> global_mapper (GLOMAP) -> undistort to PINHOLE -> Scene -> folded-solve
check; the incremental mapper runs instead when GLOMAP fails, registers too few frames, folds
the room, or breaks the camera path into pieces (see floor.check_solve). When both solves are
flagged, the less broken one is kept.
"""

from __future__ import annotations

import itertools
import os
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .errors import PipelineError
from .floor import SolveCheck, check_solve
from .intrinsics import focal_px_from_35mm, read_cameras, self_calibrate, write_focal_prior
from .scene import Scene, read_colmap_text

STAGE = "solve"
SEQ_WINDOW = 12  # match each frame with the next N
KEYFRAME_EVERY = 8  # every Nth frame joins the all-pairs loop-closure set
MIN_REGISTERED_FRACTION = 0.6


def make_pairs(names: list[str], window: int = SEQ_WINDOW, keyframe_every: int = KEYFRAME_EVERY) -> list[tuple[str, str]]:
    """Image pairs to match: neighbours in time plus all pairs among keyframes."""
    pairs: set[tuple[int, int]] = set()
    n = len(names)
    for i in range(n):
        for j in range(i + 1, min(n, i + 1 + window)):
            pairs.add((i, j))
    keys = list(range(0, n, keyframe_every))
    for i, j in itertools.combinations(keys, 2):
        pairs.add((i, j))
    return [(names[i], names[j]) for i, j in sorted(pairs)]


def _run(cmd: list[str], log: Path) -> subprocess.CompletedProcess[str]:
    print("[solve] $ " + " ".join(cmd[:2]) + " ...", flush=True)
    res = subprocess.run(cmd, capture_output=True, text=True)
    with log.open("a") as f:
        f.write("$ " + " ".join(cmd) + "\n" + res.stdout + res.stderr + "\n")
    return res


def _check(res: subprocess.CompletedProcess[str], what: str, log: Path) -> None:
    if res.returncode != 0:
        tail = (res.stderr or res.stdout).strip().splitlines()[-3:]
        raise PipelineError(
            # Tool crashes, not capture problems (those come from the mapper checks below).
            "Processing the video failed on our side. Please try again.",
            stage=STAGE, detail=f"{what} exited {res.returncode}: {' | '.join(tail)} (log: {log})",
            # SIGILL: the binary uses CPU instructions this cloud machine lacks.
            retry_on_new_host=res.returncode == -signal.SIGILL,
        )


def _registered_count(model_dir: Path) -> int:
    """Images in a binary model, read via model_analyzer-free parsing of images.bin header."""
    images_bin = model_dir / "images.bin"
    if not images_bin.exists():
        return 0
    with images_bin.open("rb") as f:
        return int.from_bytes(f.read(8), "little")


def _best_model(sparse_dir: Path) -> tuple[Path | None, int]:
    best, best_n = None, 0
    if not sparse_dir.exists():
        return None, 0
    for d in sorted(p for p in sparse_dir.iterdir() if p.is_dir()):
        n = _registered_count(d)
        if n > best_n:
            best, best_n = d, n
    return best, best_n


@dataclass(frozen=True)
class SolveResult:
    scene: Scene  # undistorted (PINHOLE), COLMAP's arbitrary frame
    images_dir: Path  # undistorted images the scene refers to
    mapper: str  # "global" or "incremental"
    fallback_reason: str | None  # why the global solve was rejected, if it was
    focal_prior: float | None = None  # px, written into the database before global_mapper
    focal_source: str | None = None  # "metadata" | "self-calibration" | None (COLMAP default)


def match_threads() -> int:
    """Matcher threads: 1 by default (Homebrew COLMAP 4.2.1 on macOS corrupts its DB with more);
    the Modal Linux image sets COLMAP_MATCH_THREADS."""
    try:
        return max(1, int(os.environ.get("COLMAP_MATCH_THREADS", "1")))
    except ValueError:
        return 1


def focal_prior(db: Path, frames_dir: Path, names: list[str], sfm: Path, log: Path,
                focal_35mm: float | None) -> tuple[float | None, str | None]:
    """Focal prior (px) for GLOMAP: a quick incremental self-calibration, else video metadata.

    Self-calibration goes first: on newsalon the metadata focal (iPhone 14 mm -> 594 px) ignores
    the stabilisation crop and gave a degraded GLOMAP solve (7% of points under the floor),
    while the 19 s self-calibration (731 px) gave a clean one.
    """
    cams = read_cameras(db)
    if not cams:
        return None, None
    t0 = time.perf_counter()
    f = self_calibrate(db, frames_dir, names, sfm / "calib", log)
    print(f"[solve] self-calibration: focal {f if f is None else round(f, 1)} px "
          f"in {time.perf_counter() - t0:.0f}s", flush=True)
    if f:
        return f, "self-calibration"
    if focal_35mm:
        return focal_px_from_35mm(focal_35mm, cams[0].width, cams[0].height), "metadata"
    return None, None


def solve(frames_dir: Path, names: list[str], work_dir: Path, *, prefer_global: bool = True,
          focal_35mm: float | None = None) -> SolveResult:
    """Camera solve. GLOMAP (global_mapper) first; if it registers too few frames or the
    solve looks folded (floor.check_solve), the incremental mapper instead."""
    if shutil.which("colmap") is None:
        raise PipelineError("COLMAP is not installed on this machine.", stage=STAGE)
    sfm = work_dir / "sfm"
    shutil.rmtree(sfm, ignore_errors=True)
    sfm.mkdir(parents=True)
    db = sfm / "database.db"
    log = sfm / "colmap.log"

    _check(_run([
        "colmap", "feature_extractor", "--database_path", str(db), "--image_path", str(frames_dir),
        "--ImageReader.single_camera", "1", "--ImageReader.camera_model", "SIMPLE_RADIAL",
        "--FeatureExtraction.use_gpu", "0", "--FeatureExtraction.max_image_size", "1600",
        "--SiftExtraction.max_num_features", "8192",
    ], log), "feature_extractor", log)

    pairs_file = sfm / "pairs.txt"
    pairs_file.write_text("".join(f"{a} {b}\n" for a, b in make_pairs(names)))
    _check(_run([
        "colmap", "matches_importer", "--database_path", str(db), "--match_list_path", str(pairs_file),
        "--match_type", "pairs", "--FeatureMatching.use_gpu", "0",
        # COLMAP 4.2.1 (Homebrew, CPU) corrupts its SQLite DB or deadlocks when matching with
        # more than one thread ("database disk image is malformed"); one thread is reliable.
        "--FeatureMatching.num_threads", str(match_threads()),
    ], log), "matches_importer", log)

    need = int(MIN_REGISTERED_FRACTION * len(names))
    prior: tuple[float | None, str | None] = (None, None)
    rejected: tuple[Scene, Path, SolveCheck] | None = None  # global solve that failed its check
    if prefer_global:
        prior = focal_prior(db, frames_dir, names, sfm, log, focal_35mm)
        if prior[0]:
            write_focal_prior(db, prior[0])
            print(f"[solve] focal prior {prior[0]:.1f} px ({prior[1]})", flush=True)
        out = sfm / "global"
        out.mkdir()
        res = _run([
            "colmap", "global_mapper", "--database_path", str(db), "--image_path", str(frames_dir),
            "--output_path", str(out), "--GlobalMapper.gp_use_gpu", "0", "--GlobalMapper.ba_ceres_use_gpu", "0",
        ], log)
        model_dir, n_reg = _best_model(out) if res.returncode == 0 else (None, 0)
        print(f"[solve] global_mapper: exit {res.returncode}, {n_reg}/{len(names)} registered", flush=True)
        if model_dir is not None and n_reg >= need:
            scene, images = _export(frames_dir, model_dir, sfm / "global_export", log)
            chk = check_solve(scene)
            print(f"[solve] global solve check: {_describe(chk)}"
                  + (f" -> REJECTED ({'; '.join(chk.problems)}), falling back to incremental" if not chk.ok else ""),
                  flush=True)
            if chk.ok:
                return SolveResult(scene, images, "global", None, *prior)
            fallback_reason = "rejected: " + "; ".join(chk.problems)
            rejected = (scene, images, chk)
        else:
            fallback_reason = f"global_mapper registered {n_reg}/{len(names)}"
    else:
        fallback_reason = None

    out = sfm / "incremental"
    out.mkdir()
    res = _run([
        "colmap", "mapper", "--database_path", str(db), "--image_path", str(frames_dir),
        "--output_path", str(out),
    ], log)
    model_dir, n_reg = _best_model(out) if res.returncode == 0 else (None, 0)
    print(f"[solve] mapper: exit {res.returncode}, {n_reg}/{len(names)} registered", flush=True)
    if (model_dir is None or n_reg < need) and rejected is not None:
        print("[solve] incremental registered too few; keeping the rejected global solve", flush=True)
        return SolveResult(rejected[0], rejected[1], "global", fallback_reason + f"; mapper registered {n_reg}",
                           *prior)
    if model_dir is None or n_reg < need:
        raise PipelineError(
            "Camera tracking failed: we could only place "
            f"{n_reg} of {len(names)} frames. Walk slowly, keep the camera moving smoothly, "
            "and avoid pointing at blank walls for long.",
            stage=STAGE, detail=f"log: {log}",
        )
    scene, images = _export(frames_dir, model_dir, sfm / "incremental_export", log)
    if rejected is not None:
        chk = check_solve(scene)
        print(f"[solve] incremental solve check: {_describe(chk)}", flush=True)
        if _worse(chk, rejected[2]):
            # Both flagged and the global one is less broken (e.g. GLOMAP: 1 piece of the path
            # off, incremental: half the video in 2 pieces): keep it.
            return SolveResult(rejected[0], rejected[1], "global",
                               f"{fallback_reason}; incremental was worse: {'; '.join(chk.problems)}", *prior)
    return SolveResult(scene, images, "incremental", fallback_reason, *prior)


def _describe(chk: SolveCheck) -> str:
    return (f"{chk.below_floor_fraction:.1%} of points below the floor, camera heights spread "
            f"{chk.camera_height_spread_m:.2f} m, largest unbroken path {chk.main_path_fraction:.0%}")


def _worse(a: SolveCheck, b: SolveCheck) -> bool:
    """Is solve check a worse than b? Fewer problems wins, then the longer unbroken path."""
    return (len(a.problems), -a.main_path_fraction) > (len(b.problems), -b.main_path_fraction)


def _export(frames_dir: Path, model_dir: Path, dst: Path, log: Path) -> tuple[Scene, Path]:
    """Undistort a model to PINHOLE and read it as a Scene (+ the undistorted images dir)."""
    und = dst / "undistorted"
    dst.mkdir(parents=True, exist_ok=True)  # image_undistorter only creates the leaf directory
    _check(_run([
        "colmap", "image_undistorter", "--image_path", str(frames_dir), "--input_path", str(model_dir),
        "--output_path", str(und), "--output_type", "COLMAP",
    ], log), "image_undistorter", log)
    txt = dst / "model_txt"
    txt.mkdir()
    _check(_run([
        "colmap", "model_converter", "--input_path", str(und / "sparse"), "--output_path", str(txt),
        "--output_type", "TXT",
    ], log), "model_converter", log)
    scene = read_colmap_text(txt)
    print(f"[solve] {scene.num_cameras} cameras, {len(scene.points)} sparse points", flush=True)
    return scene, und / "images"
