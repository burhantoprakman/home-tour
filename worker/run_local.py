"""Run the Step 1 pipeline for one room video.

    uv run python run_local.py <video> [--out DIR] [--iters N] [--stop-after STAGE]

Local (this machine): ffmpeg frames, COLMAP solve, floor fit/level/scale, splat-transform.
Remote (Modal GPU, worker/app.py): gsplat training, depth render, TSDF collision mesh.
Writes room_lod/lod-meta.json (+ chunk dirs), collision.glb, seats.json and meta.json into the output dir
(and room.sog, a single-file debug copy, with --debug-sog).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import uuid
from pathlib import Path

from pipeline.collision import mesh_bounds
from pipeline.colmap import solve
from pipeline.compress import compress
from pipeline.errors import PipelineError
from pipeline.floor import level_scene
from pipeline.frames import extract_frames
from pipeline.intrinsics import focal_35mm_from_video
from pipeline.meta import OUTPUT_FILES, write_meta
from pipeline.seats import write_seats
from pipeline.timing import StageTimes

STAGES = ("frames", "solve", "floor", "train", "seats", "compress", "meta")


def default_out_dir(video: Path) -> Path:
    return video.with_name(f"{video.stem}_out")


def modal_configured() -> bool:
    if os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET"):
        return True
    cfg = Path(os.environ.get("MODAL_CONFIG_PATH", Path.home() / ".modal.toml"))
    return cfg.exists() and "token_id" in cfg.read_text()


def train_remote(job_id: str, images_dir: Path, scene_npz: Path, work_dir: Path, iters: int) -> dict:
    """Upload inputs to the work volume, run app.train_room on a GPU, download outputs."""
    if not modal_configured():
        raise PipelineError("Modal is not set up on this machine. Run `modal setup`, then re-run.",
                            stage="train")
    import modal

    from app import app, train_room, work_volume

    root = f"/jobs/{job_id}"
    print(f"[train] uploading {len(list(images_dir.iterdir()))} images to volume as {root}", flush=True)
    with work_volume.batch_upload(force=True) as batch:
        batch.put_directory(str(images_dir), f"{root}/images")
        batch.put_file(str(scene_npz), f"{root}/scene.npz")
    try:
        try:
            with modal.enable_output(), app.run():
                result = train_room.remote(job_id, iters=iters)
        except Exception as e:  # remote errors arrive as the original exception type
            raise PipelineError("Training on the GPU failed.", stage="train",
                                detail=f"{type(e).__name__}: {e}") from e
        for name in ("splat.ply", "collision.glb"):
            with (work_dir / name).open("wb") as f:
                for chunk in work_volume.read_file(f"{root}/final/{name}"):
                    f.write(chunk)
    finally:
        try:
            work_volume.remove_file(root, recursive=True)
        except Exception as e:  # cleanup only; keep the real error
            print(f"[train] warning: couldn't remove {root} from the volume: {e}", flush=True)
    return result


def run(video: Path, out_dir: Path, iters: int, stop_after: str | None, keep_work: bool,
        debug_sog: bool = False, reuse_solve: bool = False, incremental: bool = False) -> int:
    times = StageTimes()
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "work"
    work.mkdir(exist_ok=True)

    scene_npz = work / "scene.npz"
    align_json = work / "alignment.json"
    if reuse_solve:
        align = json.loads(align_json.read_text()) if align_json.exists() else {}
        # Older runs didn't record images_dir; their undistorted images were in sfm/undistorted.
        und_images = Path(align.get("images_dir", work / "sfm" / "undistorted" / "images"))
        if not (scene_npz.exists() and align and und_images.is_dir()):
            raise PipelineError("Nothing to reuse: run without --reuse-solve first.", stage="floor",
                                detail=f"need {scene_npz}, {align_json}, {und_images}")
        scale = float(align["scale"])
        print(f"[reuse] levelled scene + alignment from {work} (scale {scale:.4f} m/unit)", flush=True)
    else:
        with times.stage("frames"):
            fs = extract_frames(video, work)
        if stop_after == "frames":
            print(times.summary())
            return 0

        with times.stage("solve"):
            sr = solve(fs.frames_dir, fs.names, work, prefer_global=not incremental,
                       focal_35mm=focal_35mm_from_video(video))
            scene, und_images = sr.scene, sr.images_dir
            print(f"[solve] used the {sr.mapper} mapper"
                  + (f" ({sr.fallback_reason})" if sr.fallback_reason else ""), flush=True)
        if stop_after == "solve":
            print(times.summary())
            return 0

        with times.stage("floor"):
            if len(scene.points) < 1000:  # the GPU trainer needs these to initialise; fail before upload
                raise PipelineError("The camera solve found too few 3D points. Record a room with more "
                                    "texture and light, moving slowly.", stage="floor",
                                    detail=f"{len(scene.points)} sparse points (< 1000)")
            scene, alignment, fit = level_scene(scene)
            scene.save_npz(scene_npz)
            scale = alignment.scale
            align_json.write_text(json.dumps({
                "scale": alignment.scale, "R": alignment.R.tolist(), "T": alignment.T.tolist(),
                "floor_inliers": fit.inliers, "camera_height_units": fit.camera_height,
                "images_dir": str(und_images), "mapper": sr.mapper,
            }, indent=2))
        if stop_after == "floor":
            print(times.summary())
            return 0

    job_id = f"local-{uuid.uuid4().hex[:12]}"
    with times.stage("train"):
        result = train_remote(job_id, und_images, scene_npz, work, iters)
    times.add_gpu("train", float(result["gpu_seconds"]))
    fin = result["final"]
    print(f"[train] remote: train {result['train']['train_s']:.0f}s, {json.dumps(fin['timings_s'])}, "
          f"gaussians {fin['gaussians_written']}, collision tris {fin['collision_triangles']}", flush=True)
    shutil.copyfile(work / "collision.glb", out_dir / OUTPUT_FILES["collision"])
    if stop_after == "train":
        print(times.summary())
        return 0

    with times.stage("seats"):
        # Levelled frame: the cameras' centroid is at x=z=0; seats without a backrest face it.
        _, seats = write_seats(out_dir, out_dir / OUTPUT_FILES["collision"], [0.0, 0.0])
    print(f"[seats] {len(seats)} suggested", flush=True)
    if stop_after == "seats":
        print(times.summary())
        return 0

    with times.stage("compress"):
        comp = compress(work / "splat.ply", out_dir, work, debug_sog=debug_sog,
                        box=mesh_bounds(work / "collision.glb"))
    print(f"[compress] streamed SOG LOD counts {comp.lod_counts}", flush=True)

    with times.stage("meta"):
        # The splat and collision mesh are already levelled (floor at y=0) and metric, so
        # floorY is 0 and scale records the metres-per-COLMAP-unit factor that was applied.
        write_meta(out_dir, comp.gaussian_count, 0.0, scale)

    missing = [OUTPUT_FILES[k] for k in OUTPUT_FILES if not (out_dir / OUTPUT_FILES[k]).exists()]
    if missing:
        raise PipelineError("Pipeline finished without all outputs.", stage="meta", detail=str(missing))
    if not keep_work:
        shutil.rmtree(work, ignore_errors=True)
    print(times.summary())
    print(f"done: {out_dir}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--out", type=Path, default=None, help="output dir (default: <video_stem>_out/)")
    ap.add_argument("--iters", type=int, default=30_000, help="gsplat training iterations (7000 = preview)")
    ap.add_argument("--stop-after", choices=STAGES[:-1], default=None,
                    help="stop after this stage (frames/solve/floor need no GPU)")
    ap.add_argument("--keep-work", action="store_true", help="keep <out>/work (frames, COLMAP, PLY)")
    ap.add_argument("--debug-sog", action="store_true", help="also write room.sog (single file, no LODs)")
    ap.add_argument("--reuse-solve", action="store_true",
                    help="skip frames/solve/floor and reuse <out>/work from an earlier --keep-work run")
    ap.add_argument("--incremental", action="store_true",
                    help="solve with COLMAP's incremental mapper only (slower; use when GLOMAP folds the room)")
    args = ap.parse_args(argv)
    out = args.out or default_out_dir(args.video)
    try:
        return run(args.video, out, args.iters, args.stop_after,
                   args.keep_work or args.stop_after is not None, args.debug_sog, args.reuse_solve,
                   args.incremental)
    except PipelineError as e:
        print(f"\nFAILED at {e.stage}: {e.user_message}", file=sys.stderr)
        if e.detail:
            print(f"  detail: {e.detail}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
