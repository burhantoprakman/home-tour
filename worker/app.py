"""The one Modal app for the Home Tour pipeline (`modal deploy worker/app.py`).

Entry point (the web app spawns it after an upload; Step 2.3):
    modal.Function.from_name("home-tour-worker", "process_room").spawn(job_id, room_id, video_path)
  video_path: object path inside the `room-videos` Storage bucket.

Functions (CPU and GPU are split so GPU seconds only cover training):
  process_room  CPU x2   orchestrator: the only writer of the `jobs` row; follows training,
                         publishes the preview (7k) and the final (30k)
  prepare_room  CPU x8   download -> frames -> COLMAP solve -> floor/level/scale
  train_room    GPU      gsplat MCMC + depth render + TSDF collision, preview snapshot on the way
Working files live in the `home-tour-work` volume under /jobs/<job_id>/ (removed on success).

Secret `home-tour-supabase` (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) is attached to the CPU
functions. Pass dry_run=True to keep Supabase out of it: storage and table rows then go to
/work/_dryrun on the volume
(scripts/dry_run_modal.py does this end to end).
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import modal

APP_NAME = "home-tour-worker"
WORK_VOLUME = "home-tour-work"
WORK_MOUNT = "/work"
DRY_RUN_ROOT = f"{WORK_MOUNT}/_dryrun"
SECRET_NAME = "home-tour-supabase"
# Fallback list: Modal takes the first type with capacity (L40S queued ~9 min once). The
# gsplat build covers sm_80 (A100) and sm_89 (L40S).
GPUS = ["L40S", "A100"]
PREP_CPUS = 8
# Tries of prepare_room when a tool crashed because of the cloud machine (see PipelineError).
PREP_ATTEMPTS = 3
SPLAT_TRANSFORM_VERSION = "3.10.3"
NODE_VERSION = "22.11.0"
# COLMAP 4.x with global_mapper (GLOMAP); Ubuntu's apt colmap is 3.x.
COLMAP_VERSION = "4.2.1"  # same as the Mac (Homebrew) the solve was validated on

# CUDA 12.4 devel (nvcc needed to build gsplat's extension) + torch 2.5.1/cu124 + gsplat 1.5.3.
# gsplat's PyPI wheel is pure Python (it JIT-compiles CUDA on first use, i.e. on every cold
# container) and prebuilt CUDA wheels only exist for cp310, so we build the sdist here, once,
# at image build time (no GPU needed) for A100 (8.0) and L40S/L4 (8.9), then assert the
# compiled extension exists. The build is cached by Modal.
gpu_image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.12")
    .apt_install("git", "build-essential", "libgl1", "libegl1", "libgomp1", "libglib2.0-0", "libusb-1.0-0")
    .uv_pip_install("torch==2.5.1", extra_index_url="https://download.pytorch.org/whl/cu124")
    .uv_pip_install(
        "numpy==2.2.6",
        "opencv-python-headless==5.0.0.93",
        "open3d==0.19.0",
        "ninja",
        "jaxtyping",
        "rich",
        "setuptools",
        "wheel",
    )
    # CC/CXX: Modal's standalone Python names clang in sysconfig; the image has gcc (nvcc wants it).
    .env({"TORCH_CUDA_ARCH_LIST": "8.0;8.9", "MAX_JOBS": "4", "CC": "gcc", "CXX": "g++"})
    .run_commands(
        # plain pip (not uv) so a compiler error is shown in the build log instead of truncated
        "python -m pip install --no-build-isolation --no-binary gsplat gsplat==1.5.3 2>&1 | tail -n 80; "
        "python -c \"import importlib.util as u; assert u.find_spec('gsplat.csrc'), 'gsplat CUDA ext missing'\""
    )
    .add_local_python_source("pipeline")
)

# CPU stages: COLMAP 4.x + ffmpeg + Node/splat-transform + numpy/opencv/open3d.
cpu_image = (
    # conda-forge CPU build, pinned: the colmap/colmap dev image's incremental mapper stopped
    # after 4 frames on the self-calibration windows that 4.2.1 solves.
    modal.Image.micromamba(python_version="3.12")
    .micromamba_install(f"colmap={COLMAP_VERSION}=cpu*", channels=["conda-forge"])
    .apt_install("ffmpeg", "curl", "xz-utils", "libgl1", "libegl1", "libgomp1", "libglib2.0-0", "libusb-1.0-0")
    .run_commands(
        f"curl -fsSL https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz"
        " | tar -xJ -C /opt",
        f"ln -s /opt/node-v{NODE_VERSION}-linux-x64/bin/node /usr/local/bin/node",
        f"ln -s /opt/node-v{NODE_VERSION}-linux-x64/bin/npm /usr/local/bin/npm",
        f"npm install -g --prefix /opt/st @playcanvas/splat-transform@{SPLAT_TRANSFORM_VERSION}",
        f"colmap help | head -n 1 | grep -F {COLMAP_VERSION} && colmap global_mapper -h > /dev/null",
        "/opt/st/bin/splat-transform --version",
    )
    .uv_pip_install("numpy==2.2.6", "opencv-python-headless==5.0.0.93", "open3d==0.19.0")
    # Linux COLMAP matches safely with many threads (the 1-thread default is a macOS Homebrew bug).
    .env({"SPLAT_TRANSFORM": "/opt/st/bin/splat-transform", "COLMAP_MATCH_THREADS": str(PREP_CPUS)})
    .add_local_python_source("pipeline")
)

app = modal.App(APP_NAME)
work_volume = modal.Volume.from_name(WORK_VOLUME, create_if_missing=True)


def _secrets() -> list[modal.Secret]:
    # Always the same list: the container re-imports this module and must declare exactly the
    # dependencies the app was deployed with (a local-only branch crash-looped the deployment).
    # Dry runs still never touch Supabase: dry_run=True selects LocalStore.
    return [modal.Secret.from_name(SECRET_NAME, required_keys=["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])]


def _store(dry_run: bool):
    from pipeline.store import LocalStore, SupabaseStore

    return LocalStore(Path(DRY_RUN_ROOT)) if dry_run else SupabaseStore.from_env()


def _root(job_id: str) -> Path:
    return Path(WORK_MOUNT) / "jobs" / job_id


def _cpu_info() -> str:
    """CPU model and its widest SIMD level, to trace host-specific tool crashes."""
    try:
        text = Path("/proc/cpuinfo").read_text()
    except OSError:
        return "unknown"
    model = next((ln.split(":", 1)[1].strip() for ln in text.splitlines() if ln.startswith("model name")), "?")
    flags = next((ln.split(":", 1)[1].split() for ln in text.splitlines() if ln.startswith("flags")), [])
    simd = next((f for f in ("avx512f", "avx2", "avx", "sse4_2") if f in flags), "none")
    return f"{model} ({simd})"


def _gpu_name() -> str:
    import torch

    return torch.cuda.get_device_name(0)


@app.function(image=gpu_image, gpu=GPUS, timeout=3 * 60 * 60, volumes={WORK_MOUNT: work_volume})
def train_room(job_id: str, iters: int = 30_000, preview_iters: int | None = None,
               cap_max: int = 3_000_000, train_overrides: dict | None = None) -> dict:
    """Train /jobs/<job_id>/{scene.npz,images}; writes preview/ (if preview_iters) and final/
    (splat.ply, collision.glb, done.json) and train_result.json. Returns timings + GPU seconds."""
    from pipeline.job import train_room_on

    work_volume.reload()
    result = train_room_on(_root(job_id), iters, preview_iters, commit=work_volume.commit, cap_max=cap_max,
                           train_overrides=train_overrides)
    result["gpu"] = _gpu_name()
    return result


@app.function(image=cpu_image, cpu=PREP_CPUS, memory=16384, timeout=60 * 60,
              volumes={WORK_MOUNT: work_volume}, secrets=_secrets())
def prepare_room(job_id: str, room_id: str, video_path: str, reporter_state: dict, dry_run: bool = False,
                 incremental: bool = False) -> dict:
    """download -> frames -> solve -> floor into /jobs/<job_id>/. Reports to the job row;
    returns the reporter state (to continue in process_room) and solve info."""
    from pipeline.job import JobReporter

    print(f"[host] {_cpu_info()}", flush=True)
    store = _store(dry_run)
    rep = JobReporter(store, job_id, room_id).restore(reporter_state)
    root = _root(job_id)
    root.mkdir(parents=True, exist_ok=True)
    if dry_run:
        work_volume.reload()  # the video was uploaded to the volume by the dry-run script
    with rep.run_stage("download"):
        video = store.download_video(video_path, root / "cpu" / f"video{Path(video_path).suffix or '.mp4'}")
    from pipeline.job import prepare_scene

    from pipeline.errors import PipelineError

    try:
        info = prepare_scene(video, root, rep, incremental=incremental)
    except PipelineError as e:
        if e.retry_on_new_host:
            import modal.experimental

            # Retire this container so process_room's retry gets a fresh one.
            modal.experimental.stop_fetching_inputs()
        raise
    work_volume.commit()
    return {"reporter": rep.state(), "info": info}


@app.function(image=cpu_image, cpu=2, memory=8192, timeout=3 * 60 * 60,
              volumes={WORK_MOUNT: work_volume}, secrets=_secrets())
def process_room(job_id: str, room_id: str, video_path: str, *, dry_run: bool = False,
                 preview_iters: int = 7_000, final_iters: int = 30_000, incremental: bool = False,
                 keep_work: bool = False) -> dict:
    """The job entrypoint: video in Storage -> preview room (status 'preview') -> final room
    ('ready'). Failures set the job to 'failed' with a user-readable error."""
    from pipeline.errors import PipelineError
    from pipeline.job import JobReporter, TrainHandle, follow_training

    store = _store(dry_run)
    rep = JobReporter(store, job_id, room_id)
    root = _root(job_id)
    t0 = time.perf_counter()
    try:
        rep.send(clear_error=True)
        for attempt in range(1, PREP_ATTEMPTS + 1):
            try:
                prep = prepare_room.remote(job_id, room_id, video_path, rep.state(), dry_run, incremental)
                break
            except PipelineError as e:
                if not e.retry_on_new_host or attempt == PREP_ATTEMPTS:
                    raise
                print(f"[job] {e} -- retrying prep on a new machine ({attempt}/{PREP_ATTEMPTS})", flush=True)
        rep.restore(prep["reporter"])
        scale = float(prep["info"]["scale"])

        call = train_room.spawn(job_id, final_iters, preview_iters)

        def wait(timeout: float) -> dict | None:
            try:
                return call.get(timeout=timeout)
            except (modal.exception.FunctionTimeoutError, modal.exception.OutputExpiredError) as e:
                raise PipelineError("Training took too long and was stopped.", stage="train",
                                    detail=repr(e)) from e
            except (TimeoutError, modal.exception.TimeoutError):
                return None  # still training
            except PipelineError:
                raise
            except Exception as e:  # remote errors arrive as the original exception type
                raise PipelineError("Training on the GPU failed.", stage="train",
                                    detail=f"{type(e).__name__}: {e}") from e

        def poll() -> None:
            work_volume.commit()  # dry runs keep job rows on the volume; don't lose them
            work_volume.reload()

        out = follow_training(root, TrainHandle(poll=poll, wait=wait), store, rep, scale)
        rep.done()
        summary = {"job_id": job_id, "room_id": room_id, "prepare": prep["info"], **out,
                   "stage_timings": rep.times.wall_s, "gpu_seconds": rep.gpu_seconds,
                   "total_s": time.perf_counter() - t0}
        print(rep.times.summary())
        print(json.dumps(summary, indent=2, default=str))
        if not keep_work:
            shutil.rmtree(root, ignore_errors=True)
        work_volume.commit()
        return summary
    except BaseException as e:
        rep.fail(e)  # working files stay on the volume for debugging
        print(rep.times.summary())
        work_volume.commit()
        raise
