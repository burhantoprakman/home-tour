"""Stage 7: meta.json + output file names, mirroring packages/shared/src/worker.ts."""

from __future__ import annotations

import json
import math
from pathlib import Path

# WORKER_OUTPUT_FILES in packages/shared/src/worker.ts
OUTPUT_FILES = {
    "splat": "room_lod/lod-meta.json",  # streamed SOG octree; chunk dirs sit beside it
    "collision": "collision.glb",
    "seats": "seats.json",
    "meta": "meta.json",
}


def make_meta(gaussian_count: int, floor_y: float, scale: float) -> dict[str, int | float]:
    """WorkerMeta: gaussianCount int >= 0, floorY finite number, scale > 0."""
    if isinstance(gaussian_count, bool) or int(gaussian_count) != gaussian_count or gaussian_count < 0:
        raise ValueError(f"gaussianCount must be a non-negative int, got {gaussian_count!r}")
    if not math.isfinite(floor_y):
        raise ValueError(f"floorY must be finite, got {floor_y!r}")
    if not (math.isfinite(scale) and scale > 0):
        raise ValueError(f"scale must be positive, got {scale!r}")
    return {"gaussianCount": int(gaussian_count), "floorY": float(floor_y), "scale": float(scale)}


def write_meta(out_dir: Path, gaussian_count: int, floor_y: float, scale: float) -> Path:
    path = Path(out_dir) / OUTPUT_FILES["meta"]
    path.write_text(json.dumps(make_meta(gaussian_count, floor_y, scale), indent=2) + "\n")
    return path
