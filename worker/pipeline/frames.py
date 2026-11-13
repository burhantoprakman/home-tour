"""Stage 1: video -> sharp still frames.

ffmpeg pulls candidates at >= 4 fps (more for short clips: about 2x the frames we want to
keep, up to 12 fps); we score each by Laplacian variance, keep the sharpest frame in each
window so the output averages ~2 fps (denser for short clips, sparser for long ones), drop
frames that are much blurrier than the rest, and cap at 500 (~4 min of walking). HDR (HLG/PQ) clips are pulled
as 16-bit RGB and tonemapped to sRGB in numpy (see hdr.py) before COLMAP sees them.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from . import hdr as hdr_mod
from .errors import PipelineError
from .hdr import HDR_TRANSFERS

STAGE = "frames"
MIN_CANDIDATE_FPS = 4.0
MAX_CANDIDATE_FPS = 12.0
OVERSAMPLE = 2.0  # candidates per kept frame, so each window has a choice
TARGET_FPS = 2.0
MIN_FRAMES = 150
MAX_FRAMES = 500  # was 300 (2.5 min); longer multi-height walks need the extra views
MAX_LONG_SIDE = 1920  # was 1600; training uses these frames as-is (2026-11-11)
# A window winner is dropped when it scores below this fraction of the median sharpness of
# its temporal neighbours (about +-1 s). Local, because Laplacian variance also tracks scene
# content: a sharp view of a blank wall scores far below a sharp bookshelf.
RELATIVE_BLUR_CUTOFF = 0.4
LOCAL_HALF_WINDOW = 8  # candidates either side; extract_frames passes ~1 s worth
# Median sharpness (Laplacian variance at 640 px) below this means the whole video is mush.
ABSOLUTE_BLUR_FLOOR = 8.0


@dataclass(frozen=True)
class FrameSet:
    frames_dir: Path
    names: list[str]  # kept frame file names, in time order
    sharpness: list[float]
    candidates: int
    duration_s: float


def sharpness(gray: np.ndarray) -> float:
    """Laplacian variance on a 640 px-wide copy, so scores are resolution independent."""
    if gray.ndim == 3:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    if w != 640:
        gray = cv2.resize(gray, (640, max(1, round(h * 640 / w))), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def target_count(duration_s: float) -> int:
    return int(np.clip(round(duration_s * TARGET_FPS), MIN_FRAMES, MAX_FRAMES))


def candidate_fps(duration_s: float) -> float:
    """Sampling rate for candidates: short clips are sampled densely to reach MIN_FRAMES."""
    if duration_s <= 0:
        return MIN_CANDIDATE_FPS
    want = OVERSAMPLE * target_count(duration_s) / duration_s
    return float(np.clip(want, MIN_CANDIDATE_FPS, MAX_CANDIDATE_FPS))


def select_frames(
    scores: list[float],
    target: int,
    *,
    min_frames: int = MIN_FRAMES,
    max_frames: int = MAX_FRAMES,
    relative_cutoff: float = RELATIVE_BLUR_CUTOFF,
    absolute_floor: float = ABSOLUTE_BLUR_FLOOR,
    local_half_window: int = LOCAL_HALF_WINDOW,
) -> list[int]:
    """Indices of the frames to keep (sorted). Raises PipelineError if too few are sharp."""
    n = len(scores)
    if n == 0:
        raise PipelineError("We couldn't read any frames from the video.", stage=STAGE)
    s = np.asarray(scores, dtype=np.float64)
    if float(np.median(s)) < absolute_floor:
        raise PipelineError(
            "Video too blurry. Record more slowly, with good light, and keep the phone steady.",
            stage=STAGE,
            detail=f"median sharpness {np.median(s):.1f} < {absolute_floor}",
        )
    # Best frame per window, so kept frames stay spread over the whole walk.
    n_windows = max(1, min(n, target))
    edges = np.linspace(0, n, n_windows + 1).round().astype(int)
    winners = [int(a + np.argmax(s[a:b])) for a, b in zip(edges[:-1], edges[1:]) if b > a]
    h = max(1, local_half_window)
    kept = [i for i in winners if s[i] >= relative_cutoff * float(np.median(s[max(0, i - h):i + h + 1]))]
    if len(kept) > max_frames:
        pick = np.linspace(0, len(kept) - 1, max_frames).round().astype(int)
        kept = [kept[i] for i in pick]
    if len(kept) < min_frames:
        raise PipelineError(
            f"Only {len(kept)} sharp frames found (need {min_frames}). Record a longer video "
            "(about 2 to 3 minutes), walking slowly around the whole room.",
            stage=STAGE,
            detail=f"{n} candidates, {len(winners)} window winners",
        )
    return kept


@dataclass(frozen=True)
class VideoInfo:
    duration_s: float
    transfer: str | None  # "hlg" / "pq" for HDR, None for SDR
    color_space: str | None


def probe_video(video: Path) -> VideoInfo:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "format=duration:stream=color_transfer,color_space", "-of", "json", str(video)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise PipelineError("We couldn't open this video file.", stage=STAGE, detail=out.stderr.strip())
    try:
        d = json.loads(out.stdout)
        duration = float(d["format"]["duration"])
    except (KeyError, ValueError) as e:
        raise PipelineError("We couldn't read the video's length.", stage=STAGE, detail=str(e)) from e
    stream = (d.get("streams") or [{}])[0]
    return VideoInfo(duration, HDR_TRANSFERS.get(stream.get("color_transfer", "")), stream.get("color_space"))


def _scale_filter(hdr: bool) -> str:
    # Long side capped at MAX_LONG_SIDE; ffmpeg applies the phone's rotation metadata itself.
    f = f"scale='if(gt(iw,ih),min({MAX_LONG_SIDE},iw),-2)':'if(gt(iw,ih),-2,min({MAX_LONG_SIDE},ih))'"
    if hdr:  # decode BT.2020 YUV to full-range 16-bit RGB; the transfer is undone in numpy
        f += ":in_color_matrix=bt2020:in_range=tv:out_range=pc:flags=area,format=rgb48le"
    return f


def _read_signal16(path: Path) -> np.ndarray:
    """16-bit PNG -> RGB float signal in [0, 1]."""
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None or img.dtype != np.uint16:
        raise PipelineError("We couldn't decode this HDR video.", stage=STAGE, detail=f"bad frame {path.name}")
    return img[..., ::-1].astype(np.float64) / 65535.0


def extract_frames(video: Path, work_dir: Path) -> FrameSet:
    """Extract candidates with ffmpeg, keep the sharp ones in work_dir/frames as 8-bit sRGB JPGs."""
    video = Path(video)
    if not video.is_file():
        raise PipelineError("Video file not found.", stage=STAGE, detail=str(video))
    vi = probe_video(video)
    duration = vi.duration_s
    hdr = vi.transfer is not None
    fps = candidate_fps(duration)
    cand_dir = work_dir / "candidates"
    frames_dir = work_dir / "frames"
    for d in (cand_dir, frames_dir):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    ext = "png" if hdr else "jpg"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
           "-vf", f"fps={fps:.3f},{_scale_filter(hdr)}"]
    cmd += ["-pix_fmt", "rgb48le"] if hdr else ["-q:v", "2"]
    cmd.append(str(cand_dir / f"%05d.{ext}"))
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise PipelineError("We couldn't decode this video.", stage=STAGE, detail=res.stderr.strip()[-500:])
    cands = sorted(cand_dir.glob(f"*.{ext}"))
    scores = []
    for p in cands:
        if hdr:  # score the (perceptual) HDR signal as 8-bit grey
            img = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
            gray = (cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) // 257).astype(np.uint8) if img is not None else None
        else:
            gray = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
        scores.append(sharpness(gray) if gray is not None else 0.0)
    kept = select_frames(scores, target_count(duration), local_half_window=max(1, round(fps)))
    names = []
    if hdr:
        # One exposure for the whole clip, from the median of per-frame median luminance.
        medians = [float(np.median(hdr_mod.luminance(hdr_mod.to_linear_709(_read_signal16(cands[i])[::4, ::4], vi.transfer))))
                   for i in kept]
        exposure = hdr_mod.exposure_for(float(np.median(medians)))
        for i in kept:
            lin = hdr_mod.to_linear_709(_read_signal16(cands[i]), vi.transfer)
            rgb8 = hdr_mod.tonemap_to_srgb8(lin, exposure)
            name = cands[i].with_suffix(".jpg").name
            cv2.imwrite(str(frames_dir / name), rgb8[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 95])
            names.append(name)
        print(f"[frames] HDR ({vi.transfer}, {vi.color_space}) tonemapped to sRGB, exposure x{exposure:.2f}",
              flush=True)
    else:
        for i in kept:
            name = cands[i].name
            shutil.move(str(cands[i]), frames_dir / name)
            names.append(name)
    shutil.rmtree(cand_dir, ignore_errors=True)
    print(f"[frames] {len(cands)} candidates at {fps:.1f} fps over {duration:.1f}s -> kept {len(names)} "
          f"(median sharpness {np.median([scores[i] for i in kept]):.0f})", flush=True)
    return FrameSet(frames_dir, names, [scores[i] for i in kept], len(cands), duration)
