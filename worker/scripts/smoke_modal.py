"""Smoke test for the Modal GPU stage on a tiny synthetic room (no COLMAP needed).

    uv run python scripts/smoke_modal.py [--iters 300] [--out .out/smoke]

Ray-casts a textured 4 x 2.5 x 3 m box room (floor at y=0, already levelled and metric) from
48 views at 320x240, seeds 20k surface points, runs app.train_room remotely, then compresses
locally and checks the collision mesh matches the box.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.collision import mesh_bounds  # noqa: E402
from pipeline.compress import compress  # noqa: E402
from pipeline.meta import write_meta  # noqa: E402
from pipeline.scene import Scene  # noqa: E402
from run_local import train_remote  # noqa: E402

LO = np.array([-2.0, 0.0, -1.5])
HI = np.array([2.0, 2.5, 1.5])


def texture(p: np.ndarray) -> np.ndarray:
    """Deterministic colour per 20 cm cell, RGB uint8."""
    cell = np.floor(p / 0.2).astype(np.int64)
    h = (cell[..., 0] * 73856093) ^ (cell[..., 1] * 19349663) ^ (cell[..., 2] * 83492791)
    rgb = np.stack([(h >> s) & 255 for s in (0, 8, 16)], -1)
    return (64 + rgb // 2).astype(np.uint8)


def w2c_look(centre: np.ndarray, yaw: float, pitch: float) -> np.ndarray:
    fwd = np.array([np.cos(pitch) * np.cos(yaw), np.sin(pitch), np.cos(pitch) * np.sin(yaw)])
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = -R @ centre
    return M


def render(M: np.ndarray, K: np.ndarray, w: int, h: int) -> np.ndarray:
    R, t = M[:3, :3], M[:3, 3]
    c = -R.T @ t
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    d = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1) @ R
    with np.errstate(divide="ignore", invalid="ignore"):
        tt = np.where(d > 0, (HI - c) / d, (LO - c) / d)
    tt = np.where(np.isfinite(tt) & (tt > 0), tt, np.inf).min(-1)
    hit = c + d * tt[..., None]
    return texture(hit - 1e-4 * np.sign(d))


def build_scene(root: Path) -> Scene:
    rng = np.random.default_rng(0)
    w, h = 320, 240
    K = np.array([[220.0, 0, 160], [0, 220.0, 120], [0, 0, 1]])
    imgs = root / "images"
    imgs.mkdir(parents=True, exist_ok=True)
    poses, names = [], []
    for i, yaw in enumerate(np.linspace(0, 2 * np.pi, 16, endpoint=False)):
        for j, pitch in enumerate((-0.7, -0.2, 0.3)):
            M = w2c_look(np.array([0.4 * np.cos(yaw), 1.4, 0.4 * np.sin(yaw)]), yaw, pitch)
            name = f"{i:02d}_{j}.jpg"
            cv2.imwrite(str(imgs / name), render(M, K, w, h)[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 95])
            poses.append(M)
            names.append(name)
    # surface samples on the six faces
    n = 20_000
    pts = rng.uniform(LO, HI, (n, 3))
    face = rng.integers(0, 6, n)
    for f in range(6):
        ax, side = f // 2, f % 2
        pts[face == f, ax] = HI[ax] if side else LO[ax]
    return Scene(names, np.repeat(K[None], len(poses), 0), np.full(len(poses), w), np.full(len(poses), h),
                 np.array(poses), pts, texture(pts))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=300)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / ".out" / "smoke")
    args = ap.parse_args()
    work = args.out / "work"
    work.mkdir(parents=True, exist_ok=True)
    scene = build_scene(work)
    scene.save_npz(work / "scene.npz")
    t0 = time.perf_counter()
    result = train_remote(f"smoke-{uuid.uuid4().hex[:8]}", work / "images", work / "scene.npz", work, args.iters)
    wall = time.perf_counter() - t0
    print(json.dumps(result, indent=2))
    (args.out / "collision.glb").write_bytes((work / "collision.glb").read_bytes())
    comp = compress(work / "splat.ply", args.out, work)
    write_meta(args.out, comp.gaussian_count, 0.0, 1.0)
    lo, hi = (np.array(b) for b in mesh_bounds(work / "collision.glb"))
    ok = bool(np.all(np.abs(lo - LO) < 0.25) and np.all(np.abs(hi - HI) < 0.25))
    print(f"remote round trip {wall:.0f}s, gpu {result['gpu_seconds']:.0f}s on {result['gpu']}, "
          f"LOD counts {comp.lod_counts}, collision bounds {lo} .. {hi} -> {'OK' if ok else 'MISMATCH'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
