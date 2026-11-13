"""Stage 6: trained PLY -> streamed SOG octree with LODs, via splat-transform.

  room_lod/lod-meta.json   the deliverable (WORKER_OUTPUT_FILES.splat): LOD 0 full, LOD 1 50%,
                           LOD 2 25%, with one folder of WebP chunks per LOD beside it. The
                           viewer's splat budget only applies to this streamed form.
  room.sog                 optional debug copy: bundled single-file SOG of LOD 0 (no contract).

Coordinates: training happens in our floor-levelled metric frame (+Y up, floor y=0), the same
frame as collision.glb. PlayCanvas's splat loaders (ply, sog, gsplat-octree) apply no
rotation and the viewer entity isn't rotated, so the data is written as-is: the splat lines up
with collision.glb, which glTF also loads as-is (+Y up).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .errors import PipelineError
from .splat_ply import read_ply_vertex_count

STAGE = "compress"
LOD_DIR = "room_lod"
LOD_FRACTIONS = (50, 50)  # percent of the previous level -> 100%, 50%, 25%
# Cleanup before the LODs: MCMC leaves many near-transparent and huge Gaussians, plus floaters
# outside the room and under the floor; on a phone they read as haze in front of everything.
MIN_OPACITY = 0.02  # linear, splat-transform's -V opacity units
MAX_SCALE_M = 1.0  # per-axis extent (linear)
BOX_MARGIN_M = 0.3  # around the collision mesh's bounds
FLOOR_CUT_M = -0.15  # keep Gaussians above this y (floor is y=0)
# Publish guard: good rooms keep ~45% of the trained Gaussians after cleanup (newsalon2: 661k
# of 1.5M); job 9acd3d47 kept 0.14% (2,081) because training had diverged out of the room,
# and an empty room was published. Below this fraction we fail instead.
MIN_KEPT_FRACTION = 0.10
# One splat-transform call: fail instead of hanging the job (see gpu_args).
ST_TIMEOUT_S = 15 * 60


@dataclass(frozen=True)
class CompressResult:
    lod_meta: Path
    sog: Path | None  # debug copy, if written
    gaussian_count: int  # LOD 0 of the streamed octree
    lod_counts: list[int]


def splat_transform_bin() -> str:
    """splat-transform from PATH, $SPLAT_TRANSFORM, or pnpm's global bin dir."""
    cands = [os.environ.get("SPLAT_TRANSFORM"), shutil.which("splat-transform")]
    pnpm_home = os.environ.get("PNPM_HOME") or str(Path.home() / "Library" / "pnpm")
    cands.append(str(Path(pnpm_home) / "bin" / "splat-transform"))
    for c in cands:
        if c and Path(c).exists():
            return c
    raise PipelineError("splat-transform is not installed (npm i -g @playcanvas/splat-transform).", stage=STAGE)


def gpu_args() -> list[str]:
    """splat-transform's device for SOG compression (k-means), from $SPLAT_TRANSFORM_GPU:
    'cpu' or a WebGPU adapter index; unset lets splat-transform pick an adapter.

    SOG k-means wants a GPU: job 9acd3d47's lod-meta.json (676k Gaussians + 2 LODs) took 22 s on
    a Mac GPU, hung 25+ min in the GPU-less CPU container, and with 'cpu' had not finished after
    14 min on the Mac (single-threaded; ~55x slower than the GPU on a small splat). So 'cpu' is
    only a last resort; publishing belongs where a WebGPU adapter exists.
    """
    dev = os.environ.get("SPLAT_TRANSFORM_GPU", "").strip()
    return ["-g", dev] if dev else []


def _st(args: list[str], timeout_s: float | None = None) -> str:
    cmd = [splat_transform_bin(), "-w", "-q", *gpu_args(), *args]
    timeout_s = ST_TIMEOUT_S if timeout_s is None else timeout_s
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired as e:
        raise PipelineError("Compressing the splat took too long.", stage=STAGE,
                            detail=f"splat-transform {' '.join(args[-1:])} still running after {timeout_s:.0f}s "
                                   "(no usable GPU adapter?)") from e
    if res.returncode != 0:
        raise PipelineError("Compressing the splat failed.", stage=STAGE,
                            detail=f"{' '.join(args)}: {(res.stderr or res.stdout).strip()[-400:]}")
    return res.stdout


def info(path: Path) -> dict:
    out = _st([str(path), "--info", "json", "null"])
    start = out.index("{")
    end = out.rindex("}") + 1
    return json.loads(out[start:end])


def cleanup_args(box: tuple[Sequence[float], Sequence[float]] | None) -> list[str]:
    """splat-transform filters for compress(); box is (min, max) of collision.glb, if known."""
    args = ["-V", f"opacity,gt,{MIN_OPACITY}"]
    args += [a for i in range(3) for a in ("-V", f"scale_{i},lt,{MAX_SCALE_M}")]
    if box is not None:
        lo = [v - BOX_MARGIN_M for v in box[0]]
        hi = [v + BOX_MARGIN_M for v in box[1]]
        lo[1] = FLOOR_CUT_M
        # Only splat-transform's -B uses this convention (the viewer doesn't): it takes the box in its engine space, which is the PLY data rotated
        # 180 deg about Z (x -> -x, y -> -y), so flip our data-space box to match.
        elo = [-hi[0], -hi[1], lo[2]]
        ehi = [-lo[0], -lo[1], hi[2]]
        args += ["-B", ",".join(f"{v:.3f}" for v in (*elo, *ehi))]
    return args


def check_kept(trained: int, kept: int, min_fraction: float = MIN_KEPT_FRACTION) -> None:
    """Fail (user-readable) instead of publishing a nearly empty room."""
    if trained > 0 and kept < min_fraction * trained:
        raise PipelineError("The 3D model of this room came out mostly empty. Please try again; if it "
                            "happens again, record the room moving slowly with furniture in view.", stage=STAGE,
                            detail=f"only {kept} of {trained} Gaussians are inside the room "
                                   f"({kept / trained:.2%} < {min_fraction:.0%})")


def compress(ply: Path, out_dir: Path, work_dir: Path, *, debug_sog: bool = False,
             box: tuple[Sequence[float], Sequence[float]] | None = None) -> CompressResult:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = work_dir / "splat_clean.ply"
    _st([str(ply), "--filter-nan", *cleanup_args(box), str(base)])
    check_kept(read_ply_vertex_count(ply), read_ply_vertex_count(base))
    sog = None
    if debug_sog:
        sog = out_dir / "room.sog"
        _st([str(base), str(sog)])

    levels = [base]
    for i, pct in enumerate(LOD_FRACTIONS, start=1):
        nxt = work_dir / f"lod{i}.ply"
        _st([str(levels[-1]), "--filter-nan", "--decimate", f"{pct}%", str(nxt)])
        levels.append(nxt)
    lod_dir = out_dir / LOD_DIR
    shutil.rmtree(lod_dir, ignore_errors=True)
    lod_dir.mkdir()
    args: list[str] = []
    for i, p in enumerate(levels):
        args += [str(p), "--filter-nan", "-l", str(i)]
    lod_meta = lod_dir / "lod-meta.json"
    _st(args + [str(lod_meta)])

    lod_info = info(lod_meta)
    lod_counts = [int(c) for c in lod_info["lodCounts"]]
    return CompressResult(lod_meta, sog, lod_counts[0], lod_counts)
