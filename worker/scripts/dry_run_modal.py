"""End-to-end Modal job without Supabase: storage + table rows live on the work volume.

    uv run python scripts/dry_run_modal.py <video> [--preview-iters 3000] [--final-iters 7000]
                                                  [--incremental] [--out .out/dryrun]

Uploads the video to the volume (/_dryrun/room-videos/...), runs app.process_room with
dry_run=True in an ephemeral app (no `home-tour-supabase` secret attached), then downloads
the published files and the job/room rows to --out. Final iterations are capped at 7000
unless --allow-full is given (a 30k run costs ~45 GPU minutes).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import modal  # noqa: E402

from app import DRY_RUN_ROOT, WORK_MOUNT, app, process_room, work_volume  # noqa: E402
from pipeline.store import FILES_BUCKET, VIDEO_BUCKET  # noqa: E402

VOL_ROOT = "/" + DRY_RUN_ROOT.removeprefix(WORK_MOUNT).strip("/")


def download_tree(vol_dir: str, dest: Path) -> int:
    n = 0
    for entry in work_volume.listdir(vol_dir, recursive=True):
        if entry.type != modal.volume.FileEntryType.FILE:
            continue
        rel = entry.path.removeprefix(vol_dir.strip("/")).strip("/")
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("wb") as f:
            for chunk in work_volume.read_file(entry.path):
                f.write(chunk)
        n += 1
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--preview-iters", type=int, default=3000)
    ap.add_argument("--final-iters", type=int, default=7000)
    ap.add_argument("--incremental", action="store_true")
    ap.add_argument("--allow-full", action="store_true", help="allow --final-iters > 7000")
    ap.add_argument("--out", type=Path, default=Path(".out/dryrun"))
    ap.add_argument("--deployed", action="store_true",
                    help="spawn on the deployed app (`modal deploy app.py`); keeps running if this Mac drops")
    args = ap.parse_args(argv)
    if args.final_iters > 7000 and not args.allow_full:
        ap.error("--final-iters > 7000 needs --allow-full")

    job_id, room_id = str(uuid.uuid4()), str(uuid.uuid4())
    video_path = f"dry/{room_id}/{args.video.name}"
    print(f"job {job_id}, room {room_id}; uploading {args.video} ...", flush=True)
    with work_volume.batch_upload(force=True) as batch:
        batch.put_file(str(args.video), f"{VOL_ROOT}/{VIDEO_BUCKET}/{video_path}")

    t0 = time.perf_counter()
    try:
        kwargs = dict(dry_run=True, preview_iters=args.preview_iters, final_iters=args.final_iters,
                      incremental=args.incremental)
        if args.deployed:
            call = modal.Function.from_name(app.name, "process_room").spawn(job_id, room_id, video_path, **kwargs)
            print(f"spawned {call.object_id}", flush=True)
            summary = call.get()
        else:
            with modal.enable_output(), app.run(detach=True):  # keep going if this Mac sleeps
                summary = process_room.remote(job_id, room_id, video_path, **kwargs)
    finally:
        out = args.out / room_id
        out.mkdir(parents=True, exist_ok=True)
        for table, row_id in (("jobs", job_id), ("rooms", room_id)):
            try:
                data = b"".join(work_volume.read_file(f"{VOL_ROOT}/{table}/{row_id}.json"))
                (out / f"{table[:-1]}.json").write_bytes(data)
                print(f"{table[:-1]} row: {data.decode()}")
            except Exception as e:  # noqa: BLE001
                print(f"no {table} row: {e}")
    n = download_tree(f"{VOL_ROOT}/{FILES_BUCKET}/rooms/{room_id}", out)
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
    try:
        work_volume.remove_file(f"{VOL_ROOT}/{VIDEO_BUCKET}/{video_path}")
    except Exception:  # noqa: BLE001
        pass
    print(f"\nround trip {time.perf_counter() - t0:.0f}s; {n} files -> {out}")
    print(json.dumps({k: summary[k] for k in ("stage_timings", "gpu_seconds", "total_s")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
