"""One room job, as plain functions the Modal app (app.py) wires together.

  prepare_room   CPU  download video -> frames -> solve (GLOMAP, folded check, incremental
                      fallback) -> floor/level/scale -> <root>/scene.npz + images
  train_room     GPU  gsplat to FINAL_ITERS; at PREVIEW_ITERS it writes <root>/preview/
                      (splat.ply, collision.glb, done.json); at the end <root>/final/
  publish        CPU  collision.glb -> seats.json; splat.ply -> streamed SOG; meta.json;
                      upload to rooms/<roomId>/<preview|final>/; room status preview|ready

JobReporter is the only writer of the `jobs` row (one container at a time), so its PATCHes
never race. Progress: download .00-.02, frames -.08, solve -.22, floor -.24, train -.97
(the preview is published while training continues), publish_final -1.0.
"""

from __future__ import annotations

import json
import shutil
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .errors import PipelineError
from .store import Store, StoreError, job_row, room_output_prefix
from .timing import StageTimes

# PREVIEW_ITERS / FINAL_ITERS in packages/shared/src/job.ts
PREVIEW_ITERS = 7_000
FINAL_ITERS = 30_000
PROGRESS = {
    "download": (0.0, 0.02), "frames": (0.02, 0.08), "solve": (0.08, 0.22), "floor": (0.22, 0.24),
    "train": (0.24, 0.97), "publish_final": (0.97, 1.0),
}
STATUS_FOR_STAGE = {"download": "solving", "frames": "solving", "solve": "solving", "floor": "solving",
                    "train": "training"}
# JobStage in packages/shared/src/job.ts
JOB_STAGES = ("queued", "download", "frames", "solve", "floor", "train", "publish_preview", "publish_final", "done")
GENERIC_ERROR = "Something went wrong while building this room. Please try again."
UPLOAD_NAMES = ["room_lod", "collision.glb", "seats.json", "meta.json"]


def user_message(err: BaseException) -> str:
    if isinstance(err, PipelineError):
        return err.user_message
    if isinstance(err, StoreError):
        return "We couldn't save this room's files. Please try again."
    return GENERIC_ERROR


@dataclass
class JobReporter:
    """Writes stage, progress, status, timings and GPU seconds to the `jobs` row.

    Reporting never fails the job: a store error is printed and the pipeline carries on.
    """

    store: Store
    job_id: str
    room_id: str
    times: StageTimes = field(default_factory=StageTimes)
    status: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    log: Callable[[str], None] = print

    @property
    def gpu_seconds(self) -> float:
        return self.times.total_gpu_s

    def state(self) -> dict[str, Any]:
        """Picklable state, to hand the job over to another container."""
        return {"wall_s": dict(self.times.wall_s), "gpu_s": dict(self.times.gpu_s), "status": self.status,
                "stage": self.stage, "progress": self.progress}

    def restore(self, st: dict[str, Any]) -> JobReporter:
        self.times.wall_s.update(st["wall_s"])
        self.times.gpu_s.update(st["gpu_s"])
        self.status, self.stage, self.progress = st["status"], st["stage"], st["progress"]
        return self

    def send(self, **extra: Any) -> None:
        row = job_row(status=self.status, stage=self.stage, progress=self.progress,
                      gpu_seconds=self.gpu_seconds, stage_timings=self.times.wall_s, **extra)
        try:
            self.store.update_job(self.job_id, row)
        except Exception as e:  # noqa: BLE001 - reporting must not kill the job
            self.log(f"[job] warning: couldn't update job {self.job_id}: {e}")

    def set_room(self, row: dict[str, Any]) -> None:
        try:
            self.store.update_room(self.room_id, row)
        except Exception as e:  # noqa: BLE001
            self.log(f"[job] warning: couldn't update room {self.room_id}: {e}")

    def set_progress(self, p: float, *, status: str | None = None) -> None:
        self.progress = max(self.progress, min(1.0, p))
        if status is not None:
            self.status = status
        self.send()

    def stage_progress(self, name: str, frac: float) -> None:
        a, b = PROGRESS[name]
        self.set_progress(a + (b - a) * min(1.0, max(0.0, frac)))

    @contextmanager
    def run_stage(self, name: str) -> Iterator[None]:
        self.stage = name
        if name in STATUS_FOR_STAGE and self.status not in ("preview",):
            self.status = STATUS_FOR_STAGE[name]
        if name in PROGRESS:
            self.progress = max(self.progress, PROGRESS[name][0])
        self.send(clear_error=True)
        with self.times.stage(name):
            yield
        if name in PROGRESS:
            self.progress = max(self.progress, PROGRESS[name][1])
        self.send()

    def add_gpu(self, name: str, seconds: float) -> None:
        self.times.add_gpu(name, seconds)

    def fail(self, err: BaseException) -> None:
        self.status = "failed"
        # A failure inside another container (prepare_room) carries the stage it failed in.
        if isinstance(err, PipelineError) and err.stage in JOB_STAGES:
            self.stage = err.stage
        msg = user_message(err)
        self.log(f"[job] FAILED at {self.stage}: {err!r}")
        self.send(error=msg)
        self.set_room({"status": "failed"})

    def done(self) -> None:
        self.status, self.stage, self.progress = "ready", "done", 1.0
        self.send()


# ---- CPU: video -> levelled scene ------------------------------------------------------------

def prepare_scene(video: Path, root: Path, rep: JobReporter, *, incremental: bool = False) -> dict[str, Any]:
    """frames -> solve -> floor. Writes root/scene.npz and root/images/; returns solve info."""
    from .colmap import solve
    from .floor import level_scene
    from .frames import extract_frames
    from .intrinsics import focal_35mm_from_video

    work = root / "cpu"
    work.mkdir(parents=True, exist_ok=True)
    with rep.run_stage("frames"):
        fs = extract_frames(video, work)
    with rep.run_stage("solve"):
        sr = solve(fs.frames_dir, fs.names, work, prefer_global=not incremental,
                   focal_35mm=focal_35mm_from_video(video))
    with rep.run_stage("floor"):
        if len(sr.scene.points) < 1000:
            raise PipelineError("The camera solve found too few 3D points. Record a room with more "
                                "texture and light, moving slowly.", stage="floor",
                                detail=f"{len(sr.scene.points)} sparse points (< 1000)")
        scene, alignment, fit = level_scene(sr.scene)
        scene.save_npz(root / "scene.npz")
        images = root / "images"
        shutil.rmtree(images, ignore_errors=True)
        shutil.copytree(sr.images_dir, images)
        info = {"scale": alignment.scale, "mapper": sr.mapper, "fallback_reason": sr.fallback_reason,
                "focal_prior": sr.focal_prior, "focal_source": sr.focal_source,
                "frames": len(fs.names), "cameras": scene.num_cameras, "points": len(scene.points),
                "floor_inliers": fit.inliers}
        (root / "prepare.json").write_text(json.dumps(info, indent=2))
    shutil.rmtree(work, ignore_errors=True)  # frames + COLMAP db: not needed downstream
    return info


# ---- GPU: train with a preview snapshot ------------------------------------------------------

def write_variant(dst: Path, splats: Any, scene: Any) -> dict[str, Any]:
    """splat.ply + collision.glb for one snapshot (GPU: depth render; CPU: TSDF)."""
    from .collision import build_collision, crop_box_from_points
    from .splat_ply import write_ply
    from .train import render_depths

    dst.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    n = write_ply(dst / "splat.ply", splats)
    depths, Ks = render_depths(splats, scene)
    t1 = time.perf_counter()
    cams = scene.camera_centres()
    in_time = cams[np.argsort(scene.image_names, kind="stable")]  # names are frame numbers
    col = build_collision(depths, Ks, scene.w2c, dst / "collision.glb",
                          box=crop_box_from_points(scene.points, cams), cam_centres=in_time)
    t2 = time.perf_counter()
    info = {"gaussians_written": n, "collision_triangles": col.triangles, "carved_triangles": col.carved_triangles,
            "timings_s": {"depth_render": t1 - t0, "tsdf_mesh": t2 - t1}}
    (dst / "done.json").write_text(json.dumps(info))
    return info


def train_room_on(root: Path, iters: int, preview_iters: int | None,
                  commit: Callable[[], None] = lambda: None, cap_max: int = 3_000_000,
                  train_overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    """GPU body: train to `iters`, snapshotting root/preview at preview_iters, then root/final."""
    from .scene import Scene
    from .train import TrainConfig, train_gaussians

    t0 = time.perf_counter()
    scene = Scene.load_npz(root / "scene.npz")
    progress = root / "train_progress.json"
    preview: dict[str, Any] = {}

    def on_log(done: int, total: int) -> None:
        progress.write_text(json.dumps({"step": done, "iters": total, "gpu_s": time.perf_counter() - t0}))
        commit()

    def on_snapshot(step: int, splats: Any) -> None:
        preview.update(write_variant(root / "preview", splats, scene))
        preview["gpu_s_at_preview"] = time.perf_counter() - t0
        preview["iters"] = step
        (root / "preview" / "done.json").write_text(json.dumps(preview))
        commit()

    snaps = [preview_iters] if preview_iters and preview_iters < iters else []
    splats, stats = train_gaussians(scene, root / "images", TrainConfig(iters=iters, cap_max=cap_max,
                                                                      **(train_overrides or {})),
                                    snapshots=snaps, on_snapshot=on_snapshot, on_log=on_log)
    final = write_variant(root / "final", splats, scene)
    result = {"train": stats, "preview": preview or None, "final": final,
              "gpu_seconds": time.perf_counter() - t0}
    (root / "train_result.json").write_text(json.dumps(result, indent=2))
    commit()
    return result


# ---- CPU: publish one variant ----------------------------------------------------------------

def publish(variant: str, root: Path, store: Store, rep: JobReporter, scale: float) -> dict[str, Any]:
    """collision -> seats -> compress -> meta -> upload for root/<variant>; updates the room."""
    from .collision import mesh_bounds
    from .compress import compress
    from .meta import OUTPUT_FILES, write_meta
    from .seats import write_seats

    src = root / variant
    out = root / f"{variant}_out"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    t = rep.times
    with t.stage(f"{variant}_seats"):
        shutil.copyfile(src / "collision.glb", out / OUTPUT_FILES["collision"])
        # The levelled frame puts the cameras' centroid at x=z=0: seats without a backrest face it.
        _, seats = write_seats(out, out / OUTPUT_FILES["collision"], np.zeros(2))
    with t.stage(f"{variant}_compress"):
        comp = compress(src / "splat.ply", out, src, box=mesh_bounds(out / OUTPUT_FILES["collision"]))
    write_meta(out, comp.gaussian_count, 0.0, scale)
    missing = [OUTPUT_FILES[k] for k in OUTPUT_FILES if not (out / OUTPUT_FILES[k]).exists()]
    if missing:
        raise PipelineError("Pipeline finished without all outputs.", stage=f"publish_{variant}",
                            detail=str(missing))
    prefix = room_output_prefix(rep.room_id, variant)
    with t.stage(f"{variant}_upload"):
        uploaded = store.upload_dir(out, prefix, UPLOAD_NAMES)
    status = "preview" if variant == "preview" else "ready"
    rep.set_room({
        "status": status,
        "splat_url": store.public_url(f"{prefix}/{OUTPUT_FILES['splat']}"),
        "collision_url": store.public_url(f"{prefix}/{OUTPUT_FILES['collision']}"),
        "seats": seats,
    })
    return {"variant": variant, "files": len(uploaded), "seats": len(seats),
            "gaussians": comp.gaussian_count, "lod_counts": comp.lod_counts}


# ---- Orchestration (runs in one CPU container; GPU work is a callable) -----------------------

@dataclass
class TrainHandle:
    """What the orchestrator needs from a running GPU training call."""
    poll: Callable[[], None]  # refresh the view of root (volume reload)
    wait: Callable[[float], dict[str, Any] | None]  # result, or None if not finished after timeout s


def follow_training(root: Path, handle: TrainHandle, store: Store, rep: JobReporter, scale: float,
                    poll_s: float = 15.0) -> dict[str, Any]:
    """While the GPU trains: mirror train progress to the job, publish the preview once its
    snapshot lands, then publish the final. Returns {train, preview, final} info."""
    published_preview: dict[str, Any] | None = None
    result = None
    with rep.run_stage("train"):
        while result is None:
            result = handle.wait(poll_s)
            handle.poll()
            prog = root / "train_progress.json"
            if prog.exists():
                try:
                    p = json.loads(prog.read_text())
                    rep.stage_progress("train", p["step"] / max(1, p["iters"]))
                except (ValueError, KeyError):
                    pass
            if published_preview is None and (root / "preview" / "done.json").exists():
                prev = json.loads((root / "preview" / "done.json").read_text())
                if "iters" in prev:  # written last by on_snapshot
                    published_preview = publish("preview", root, store, rep, scale)
                    rep.status = "preview"
                    rep.send()
    rep.add_gpu("train", float(result["gpu_seconds"]))
    if published_preview is None and result.get("preview"):
        published_preview = publish("preview", root, store, rep, scale)
    with rep.run_stage("publish_final"):
        final = publish("final", root, store, rep, scale)
    return {"train": result["train"], "preview": published_preview, "final": final}
