import cv2
import numpy as np
import pytest

from pipeline.errors import PipelineError
from pipeline.frames import (MAX_CANDIDATE_FPS, MAX_FRAMES, MIN_CANDIDATE_FPS, MIN_FRAMES,
                             candidate_fps, select_frames, sharpness, target_count)


def _textured(seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = (rng.random((480, 640)) * 255).astype(np.uint8)
    return cv2.resize(cv2.resize(img, (160, 120)), (640, 480), interpolation=cv2.INTER_NEAREST)


def test_blur_lowers_sharpness():
    img = _textured()
    s0 = sharpness(img)
    s1 = sharpness(cv2.GaussianBlur(img, (0, 0), 3))
    s2 = sharpness(cv2.GaussianBlur(img, (0, 0), 8))
    assert s0 > s1 > s2


def test_sharpness_is_resolution_independent():
    img = _textured()
    big = cv2.resize(img, (1280, 960), interpolation=cv2.INTER_NEAREST)
    assert sharpness(big) == pytest.approx(sharpness(img), rel=0.35)


def test_sharpness_accepts_bgr():
    img = _textured()
    assert sharpness(cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)) == pytest.approx(sharpness(img))


def test_target_count_clamps():
    assert target_count(30) == MIN_FRAMES
    assert target_count(100) == 200
    assert target_count(600) == MAX_FRAMES


def test_select_drops_blurry_and_keeps_spread():
    rng = np.random.default_rng(1)
    scores = list(rng.uniform(80, 120, 800))
    blurry = set(range(0, 800, 7))
    for i in blurry:
        scores[i] = 5.0
    kept = select_frames(scores, 250)
    assert MIN_FRAMES <= len(kept) <= MAX_FRAMES
    assert kept == sorted(kept)
    assert not blurry & set(kept)
    # spread across the whole clip
    assert kept[0] < 20 and kept[-1] > 780


def test_select_picks_sharpest_in_window():
    scores = [10.0, 50.0] * 200  # 400 candidates, 200 windows of 2
    kept = select_frames(scores, 200)
    assert all(scores[i] == 50.0 for i in kept)
    assert len(kept) == 200


def test_select_caps_at_max():
    kept = select_frames([100.0] * 1000, 1000)
    assert len(kept) == MAX_FRAMES


def test_too_few_sharp_frames_is_user_readable():
    with pytest.raises(PipelineError) as e:
        select_frames([100.0] * 120, 150)
    assert "sharp frames" in e.value.user_message
    assert e.value.stage == "frames"


def test_all_blurry_video():
    with pytest.raises(PipelineError) as e:
        select_frames([2.0] * 600, 300)
    assert "blurry" in e.value.user_message.lower()


def test_candidate_fps_rises_for_short_clips():
    assert candidate_fps(120) == MIN_CANDIDATE_FPS
    assert candidate_fps(38.3) == pytest.approx(2 * 150 / 38.3)  # ~7.8 fps
    assert candidate_fps(5) == MAX_CANDIDATE_FPS
    # a 38 s clip yields enough candidates to keep the minimum
    assert 38.3 * candidate_fps(38.3) >= 2 * MIN_FRAMES - 1


def test_plain_wall_section_is_not_rejected_as_blurry():
    # a long low-texture stretch (sharp but plain wall) next to a textured one
    scores = [300.0] * 200 + [40.0] * 200
    kept = select_frames(scores, 200)
    assert sum(1 for i in kept if i >= 200) >= 95


def test_local_blur_dip_is_rejected():
    rng = np.random.default_rng(3)
    scores = list(rng.uniform(90, 110, 400))
    for i in range(0, 400, 2):  # every window gets one frame; make some windows all blurry
        if i % 20 == 0:
            scores[i] = scores[i + 1] = 10.0
    kept = select_frames(scores, 200, min_frames=0)
    assert all(scores[i] > 50 for i in kept)
    assert len(kept) == 180
