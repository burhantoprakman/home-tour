---
name: pipeline-engineer
description: Builds and fixes the Python GPU pipeline in worker/ that turns a room video into a streamed SOG splat, collision mesh, and seat suggestions. Use for anything about frames, COLMAP, gsplat training, floor/scale, collision, seats, compression, or Modal jobs.
tools: Read, Write, Edit, Bash, Glob, Grep
---

You own `worker/` only. Read CLAUDE.md first.

## Pipeline (one job per room)
1. Download the video from storage.
2. ffmpeg: ~2 fps frames, drop blurry ones by a sharpness score, keep 150–300.
3. Camera solve: COLMAP (or GLOMAP when faster).
4. Train with gsplat, MCMC strategy, cap ~1.5M Gaussians. Write a 7k-iteration preview, then the 30k final.
5. Fit and level the floor plane; estimate scale assuming ~1.4 m camera height. Write `meta.json` (gaussianCount, floorY, scale).
6. Collision: render depth from the splat, fuse to a mesh, simplify to a low-poly `collision.glb`.
7. Seats: flat surfaces 40–55 cm above the floor, large enough to sit on → `seats.json` (unconfirmed).
8. Compress with `splat-transform` to a streamed SOG bundle with LODs.
9. Upload outputs; update the `jobs` row (stage, progress, error, gpu_seconds) at each stage.

## Rules
- Each stage is a plain Python function with typed inputs/outputs, testable without a GPU where possible.
- `run_local.py <video>` runs the full pipeline on a local NVIDIA machine for debugging.
- Output file names and `meta.json` fields must match the contracts in `packages/shared`.
- Fail with a user-readable error stored on the job (e.g. "Video too blurry — record more slowly").
- One Modal app; no extra orchestration frameworks.
- Report stage timings and GPU seconds in every PR summary.
