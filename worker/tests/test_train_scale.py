import numpy as np
import pytest

from pipeline.train import camera_extent


def test_camera_extent_matches_max_spread_for_a_clean_path():
    ang = np.linspace(0, 2 * np.pi, 100, endpoint=False)
    c = np.c_[2 * np.cos(ang), np.full(100, 1.4), 2 * np.sin(ang)]
    assert camera_extent(c) == pytest.approx(1.1 * 2.0, rel=1e-6)


def test_camera_extent_ignores_a_stray_camera():
    ang = np.linspace(0, 2 * np.pi, 100, endpoint=False)
    c = np.c_[2 * np.cos(ang), np.full(100, 1.4), 2 * np.sin(ang)]
    c = np.vstack([c, [[-21.0, 12.0, -21.0]]])  # job 9acd3d47: 33 m out -> scene scale 35
    assert camera_extent(c) < 6.0  # was 1.1 x 33 m


def test_needle_penalty_defaults_are_on():
    from pipeline.train import TrainConfig
    cfg = TrainConfig()
    assert cfg.aniso_reg > 0 and cfg.max_aniso > 1


def test_needle_penalty_hits_needles_not_discs():
    torch = pytest.importorskip("torch")  # GPU image only; skipped on the Mac
    from pipeline.train import anisotropy_penalty
    log = lambda *s: torch.log(torch.tensor([s], dtype=torch.float32))
    assert anisotropy_penalty(log(0.01, 0.01, 0.01), 5.0).item() == 0.0  # sphere
    assert anisotropy_penalty(log(0.001, 0.1, 0.1), 5.0).item() == 0.0  # flat disc (wall)
    needle = log(0.01, 0.01, 0.5)
    assert anisotropy_penalty(needle, 5.0).item() == pytest.approx(np.log(50 / 5), rel=1e-5)
    needle.requires_grad_(True)
    anisotropy_penalty(needle, 5.0).backward()
    assert needle.grad[0, 2] > 0  # pushes the long axis shorter



def test_mcmc_noise_defaults_to_gsplat():
    from pipeline.train import TrainConfig

    assert TrainConfig().noise_lr == 5e5


def test_pose_opt_is_off_by_default():
    from pipeline.train import TrainConfig
    assert TrainConfig().pose_opt is False


def _w2c(yaw_deg: float, centre) -> np.ndarray:
    a = np.radians(yaw_deg)
    R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = -R @ np.asarray(centre, dtype=float)
    return M


def test_pose_correction_stats_reports_shift_and_rotation():
    from pipeline.train import pose_correction_stats
    before = np.stack([_w2c(0, [0, 1, 0]), _w2c(30, [1, 1, 0])])
    after = np.stack([_w2c(0, [0, 1, 0]), _w2c(32, [1, 1, 0.05])])
    s = pose_correction_stats(before, after)
    assert s["pose_shift_max"] == pytest.approx(0.05, abs=1e-9)
    assert s["pose_rot_max_deg"] == pytest.approx(2.0, abs=1e-6)
    assert pose_correction_stats(before, before)["pose_shift_max"] == pytest.approx(0.0, abs=1e-9)


def test_refine_viewmats_zero_delta_is_identity_and_moves_camera():
    torch = pytest.importorskip("torch")  # GPU image only; skipped on the Mac
    from pipeline.train import refine_viewmats
    vm = torch.tensor(np.stack([_w2c(20, [1, 1.4, -2])]), dtype=torch.float64)
    assert torch.allclose(refine_viewmats(vm, torch.zeros(1, 9, dtype=torch.float64)), vm, atol=1e-10)
    d = torch.zeros(1, 9, dtype=torch.float64)
    d[0, 2] = 0.1  # 10 cm along the camera's own +z (forward)
    c2w = torch.linalg.inv(refine_viewmats(vm, d))[0]
    fwd = torch.linalg.inv(vm)[0, :3, 2]
    assert torch.allclose(c2w[:3, 3], torch.tensor([1, 1.4, -2.0], dtype=torch.float64) + 0.1 * fwd, atol=1e-10)


def test_training_resolution_matches_extracted_frames():
    from pipeline.frames import MAX_LONG_SIDE
    from pipeline.train import TrainConfig
    assert TrainConfig().max_long_side == MAX_LONG_SIDE == 1920
