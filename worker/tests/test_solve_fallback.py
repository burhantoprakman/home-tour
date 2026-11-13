import subprocess

import numpy as np
import pytest

import pipeline.colmap as colmap
from pipeline.errors import PipelineError
from tests.test_floor import _fold, _scramble, _synthetic_room

NAMES = [f"{i:05d}.jpg" for i in range(10)]


def fake_colmap(monkeypatch, tmp_path, *, global_registered, global_scene, inc_registered=10, inc_scene=None):
    """Stub COLMAP: mappers write a model dir whose images.bin header holds the registered count;
    _export returns the given synthetic scenes."""
    calls = []
    monkeypatch.setattr(colmap.shutil, "which", lambda name: "/usr/bin/colmap")

    def run(cmd, log):
        calls.append(cmd[1])
        if cmd[1] in ("global_mapper", "mapper"):
            out = cmd[cmd.index("--output_path") + 1]
            n = global_registered if cmd[1] == "global_mapper" else inc_registered
            d = colmap.Path(out) / "0"
            d.mkdir(parents=True, exist_ok=True)
            (d / "images.bin").write_bytes(int(n).to_bytes(8, "little"))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def export(frames_dir, model_dir, dst, log):
        scene = global_scene if model_dir.parent.name == "global" else inc_scene
        return scene, dst / "undistorted" / "images"

    monkeypatch.setattr(colmap, "_run", run)
    monkeypatch.setattr(colmap, "_export", export)
    monkeypatch.setattr(colmap, "focal_prior", lambda *a: (None, None))
    return calls


def scenes():
    rng = np.random.default_rng(7)
    clean, _ = _scramble(_synthetic_room(rng), rng)
    folded, _ = _scramble(_fold(_synthetic_room(rng)), rng)
    return clean, folded


def test_clean_global_solve_is_kept(monkeypatch, tmp_path):
    clean, _ = scenes()
    calls = fake_colmap(monkeypatch, tmp_path, global_registered=10, global_scene=clean)
    res = colmap.solve(tmp_path, NAMES, tmp_path / "work")
    assert res.mapper == "global" and res.fallback_reason is None
    assert "mapper" not in calls


def test_folded_global_solve_falls_back_to_incremental(monkeypatch, tmp_path):
    clean, folded = scenes()
    calls = fake_colmap(monkeypatch, tmp_path, global_registered=10, global_scene=folded, inc_scene=clean)
    res = colmap.solve(tmp_path, NAMES, tmp_path / "work")
    assert res.mapper == "incremental" and res.scene is clean
    assert res.fallback_reason.startswith("rejected: ") and "below the floor" in res.fallback_reason
    assert calls[-1] == "mapper"


def test_too_few_registered_falls_back(monkeypatch, tmp_path):
    clean, _ = scenes()
    fake_colmap(monkeypatch, tmp_path, global_registered=3, global_scene=clean, inc_scene=clean)
    res = colmap.solve(tmp_path, NAMES, tmp_path / "work")
    assert res.mapper == "incremental" and "registered 3/10" in res.fallback_reason


def test_incremental_only_and_failure(monkeypatch, tmp_path):
    clean, _ = scenes()
    calls = fake_colmap(monkeypatch, tmp_path, global_registered=10, global_scene=clean, inc_scene=clean)
    res = colmap.solve(tmp_path, NAMES, tmp_path / "work", prefer_global=False)
    assert res.mapper == "incremental" and "global_mapper" not in calls
    fake_colmap(monkeypatch, tmp_path, global_registered=2, global_scene=clean, inc_registered=2)
    with pytest.raises(PipelineError, match="only place 2 of 10"):
        colmap.solve(tmp_path, NAMES, tmp_path / "work2")


def test_match_threads_env(monkeypatch):
    monkeypatch.delenv("COLMAP_MATCH_THREADS", raising=False)
    assert colmap.match_threads() == 1
    monkeypatch.setenv("COLMAP_MATCH_THREADS", "8")
    assert colmap.match_threads() == 8
    monkeypatch.setenv("COLMAP_MATCH_THREADS", "lots")
    assert colmap.match_threads() == 1


def test_focal_prior_prefers_self_calibration_then_metadata(monkeypatch, tmp_path):
    from tests.test_intrinsics import make_db

    db = make_db(tmp_path / "d.db")
    monkeypatch.setattr(colmap, "self_calibrate", lambda *a, **k: 731.0)
    assert colmap.focal_prior(db, tmp_path, NAMES, tmp_path, tmp_path / "log", 14.0) == (731.0, "self-calibration")
    monkeypatch.setattr(colmap, "self_calibrate", lambda *a, **k: None)
    f, src = colmap.focal_prior(db, tmp_path, NAMES, tmp_path, tmp_path / "log", 14.0)
    assert src == "metadata" and f == pytest.approx(594.0, abs=0.1)
    assert colmap.focal_prior(db, tmp_path, NAMES, tmp_path, tmp_path / "log", None) == (None, None)


def test_prior_is_written_before_global_mapper(monkeypatch, tmp_path):
    clean, _ = scenes()
    fake_colmap(monkeypatch, tmp_path, global_registered=10, global_scene=clean)
    monkeypatch.setattr(colmap, "focal_prior", lambda *a: (731.0, "self-calibration"))
    written = []
    monkeypatch.setattr(colmap, "write_focal_prior", lambda db, f: written.append(f))
    res = colmap.solve(tmp_path, NAMES, tmp_path / "work")
    assert written == [731.0]
    assert (res.mapper, res.focal_prior, res.focal_source) == ("global", 731.0, "self-calibration")


def test_tool_crash_on_illegal_instruction_asks_for_a_new_host(tmp_path):
    log = tmp_path / "colmap.log"
    sigill = subprocess.CompletedProcess(["colmap"], -4, "", "")
    with pytest.raises(PipelineError) as e:
        colmap._check(sigill, "feature_extractor", log)
    assert e.value.retry_on_new_host
    other = subprocess.CompletedProcess(["colmap"], 1, "", "boom")
    with pytest.raises(PipelineError) as e:
        colmap._check(other, "feature_extractor", log)
    assert not e.value.retry_on_new_host


def _broken():
    from tests.test_floor import _break_path

    rng = np.random.default_rng(13)
    return _scramble(_break_path(_synthetic_room(rng)), rng)[0]


def test_broken_global_path_falls_back_to_a_clean_incremental(monkeypatch, tmp_path):
    clean, _ = scenes()
    calls = fake_colmap(monkeypatch, tmp_path, global_registered=10, global_scene=_broken(), inc_scene=clean)
    res = colmap.solve(tmp_path, NAMES, tmp_path / "work")
    assert res.mapper == "incremental" and res.scene is clean and calls[-1] == "mapper"
    assert "breaks into pieces" in res.fallback_reason


def test_keeps_the_global_solve_when_incremental_is_worse(monkeypatch, tmp_path):
    """Job 9acd3d47 shape: GLOMAP's path is broken, but the incremental solve is no better."""
    _, folded = scenes()
    broken = _broken()
    fake_colmap(monkeypatch, tmp_path, global_registered=10, global_scene=broken, inc_scene=folded)
    res = colmap.solve(tmp_path, NAMES, tmp_path / "work")
    assert res.mapper == "global" and res.scene is broken
    assert "incremental was worse" in res.fallback_reason
    fake_colmap(monkeypatch, tmp_path, global_registered=10, global_scene=broken, inc_scene=folded, inc_registered=2)
    res = colmap.solve(tmp_path, NAMES, tmp_path / "work2")
    assert res.mapper == "global" and "mapper registered 2" in res.fallback_reason
