import json

import numpy as np
import pytest

from pipeline.compress import check_kept, compress, splat_transform_bin
from pipeline.errors import PipelineError
from pipeline.meta import OUTPUT_FILES
from pipeline.splat_ply import Splats, read_ply_vertex_count, write_ply


def _splats(n: int, rng) -> Splats:
    return Splats(
        means=rng.uniform(-2, 2, (n, 3)).astype(np.float32),
        scales=np.full((n, 3), -4.0, np.float32),
        quats=np.tile([1.0, 0, 0, 0], (n, 1)).astype(np.float32),
        opacities=np.full(n, 2.0, np.float32),
        sh0=rng.normal(0, 1, (n, 3)).astype(np.float32),
        sh_rest=rng.normal(0, 0.1, (n, 15, 3)).astype(np.float32),
    )


def test_write_ply_drops_nonfinite(tmp_path):
    s = _splats(100, np.random.default_rng(0))
    s.means[3, 0] = np.nan
    s.quats[7] = 0
    assert write_ply(tmp_path / "a.ply", s) == 98
    assert read_ply_vertex_count(tmp_path / "a.ply") == 98


def _have_splat_transform() -> bool:
    try:
        splat_transform_bin()
        return True
    except PipelineError:
        return False


@pytest.mark.skipif(not _have_splat_transform(), reason="splat-transform not installed")
def test_compress_writes_sog_and_lods(tmp_path):
    ply = tmp_path / "splat.ply"
    write_ply(ply, _splats(20_000, np.random.default_rng(1)))
    out = tmp_path / "out"
    res = compress(ply, out, tmp_path)
    assert res.lod_meta == out / OUTPUT_FILES["splat"]
    assert not (out / "room.sog").exists() and res.sog is None
    assert res.gaussian_count == 20_000
    meta = json.loads(res.lod_meta.read_text())
    assert meta["lodLevels"] == 3
    assert res.lod_counts == [20_000, 10_000, 5_000]


@pytest.mark.skipif(not _have_splat_transform(), reason="splat-transform not installed")
def test_compress_debug_sog(tmp_path):
    ply = tmp_path / "splat.ply"
    write_ply(ply, _splats(5_000, np.random.default_rng(2)))
    res = compress(ply, tmp_path / "out", tmp_path, debug_sog=True)
    assert res.sog is not None and res.sog.stat().st_size > 0


@pytest.mark.skipif(not _have_splat_transform(), reason="splat-transform not installed")
def test_splat_is_stored_unrotated(tmp_path):
    """A Gaussian at (1, 2, 3) in our +Y-up frame stays at (1, 2, 3): PlayCanvas applies no flip."""
    import subprocess

    s = _splats(2_000, np.random.default_rng(4))
    s.means[:] = np.array([1.0, 2.0, 3.0], np.float32) + np.random.default_rng(5).normal(0, 0.01, (2_000, 3))
    ply = tmp_path / "splat.ply"
    write_ply(ply, s)
    res = compress(ply, tmp_path / "out", tmp_path)
    csv = tmp_path / "lod0.csv"
    subprocess.run([splat_transform_bin(), "-w", "-q", str(res.lod_meta), "-L", "0", str(csv)], check=True)
    rows = np.genfromtxt(csv, delimiter=",", names=True)
    assert rows["x"].mean() == pytest.approx(1.0, abs=0.01)
    assert rows["y"].mean() == pytest.approx(2.0, abs=0.01)
    assert rows["z"].mean() == pytest.approx(3.0, abs=0.01)


@pytest.mark.skipif(not _have_splat_transform(), reason="splat-transform not installed")
def test_compress_drops_haze_and_splats_outside_the_room(tmp_path):
    rng = np.random.default_rng(6)
    s = _splats(4_000, rng)
    s.means[:] = rng.uniform(0.2, 1.8, (4_000, 3))  # inside the box
    s.means[:500, 1] = -1.0  # under the floor
    s.means[500:1000, 0] = 9.0  # outside the room
    s.opacities[1000:1500] = -6.0  # ~0.25% opaque
    s.scales[1500:2000, 0] = np.log(3.0)  # 3 m wide
    ply = tmp_path / "splat.ply"
    write_ply(ply, s)
    res = compress(ply, tmp_path / "out", tmp_path, box=([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]))
    assert res.gaussian_count == 2_000


@pytest.mark.skipif(not _have_splat_transform(), reason="splat-transform not installed")
def test_room_box_is_in_data_space(tmp_path):
    """The box is given in our frame; Gaussians at (1.5, 1, 0) are kept, mirrored (-1.5, 1, 0) dropped."""
    s = _splats(2_000, np.random.default_rng(7))
    s.means[:] = np.array([1.5, 1.0, 0.0], np.float32) + np.random.default_rng(8).normal(0, 0.05, (2_000, 3))
    s.means[1_000:, 0] -= 3.0
    ply = tmp_path / "splat.ply"
    write_ply(ply, s)
    res = compress(ply, tmp_path / "out", tmp_path, box=([0.0, 0.0, -1.0], [2.0, 2.0, 1.0]))
    assert res.gaussian_count == 1_000


def test_check_kept_fails_a_nearly_empty_room():
    check_kept(1_500_000, 660_000)
    with pytest.raises(PipelineError) as e:
        check_kept(1_490_127, 2_081)  # job 9acd3d47's preview
    assert "mostly empty" in e.value.user_message
    assert "2081 of 1490127" in e.value.detail


@pytest.mark.skipif(not _have_splat_transform(), reason="splat-transform not installed")
def test_compress_refuses_to_publish_an_empty_room(tmp_path):
    rng = np.random.default_rng(9)
    s = _splats(4_000, rng)
    s.means[:] = rng.uniform(20, 40, (4_000, 3))  # diverged: everything far outside the room
    s.means[:100] = rng.uniform(0.2, 1.8, (100, 3))
    ply = tmp_path / "splat.ply"
    write_ply(ply, s)
    with pytest.raises(PipelineError, match="mostly empty"):
        compress(ply, tmp_path / "out", tmp_path, box=([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]))
    assert not (tmp_path / "out" / OUTPUT_FILES["splat"]).exists()


def test_gpu_device_comes_from_env(monkeypatch):
    from pipeline.compress import gpu_args

    monkeypatch.delenv("SPLAT_TRANSFORM_GPU", raising=False)
    assert gpu_args() == []
    monkeypatch.setenv("SPLAT_TRANSFORM_GPU", "cpu")
    assert gpu_args() == ["-g", "cpu"]


def test_a_hanging_splat_transform_fails_the_stage(monkeypatch, tmp_path):
    import pipeline.compress as c

    hang = tmp_path / "st"
    hang.write_text("#!/bin/sh\nsleep 30\n")
    hang.chmod(0o755)
    monkeypatch.setenv("SPLAT_TRANSFORM", str(hang))
    with pytest.raises(PipelineError) as e:
        c._st(["in.ply", "out.json"], timeout_s=0.5)
    assert e.value.stage == "compress" and "too long" in e.value.user_message


@pytest.mark.skipif(not _have_splat_transform(), reason="splat-transform not installed")
def test_compress_on_cpu(tmp_path, monkeypatch):
    monkeypatch.setenv("SPLAT_TRANSFORM_GPU", "cpu")
    ply = tmp_path / "splat.ply"
    write_ply(ply, _splats(5_000, np.random.default_rng(3)))
    res = compress(ply, tmp_path / "out", tmp_path)
    assert res.lod_counts == [5_000, 2_500, 1_250]
