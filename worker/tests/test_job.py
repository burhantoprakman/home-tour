import json

import open3d as o3d
import pytest

import pipeline.compress as compress_mod
from pipeline.collision import export_glb
from pipeline.compress import CompressResult
from pipeline.errors import PipelineError
from pipeline.job import GENERIC_ERROR, JobReporter, TrainHandle, follow_training
from pipeline.store import FILES_BUCKET, LocalStore, StoreError
from tests.test_seats import couch, room_with

JOB, ROOM = "job-1", "room-1"


@pytest.fixture
def fake_compress(monkeypatch):
    def fake(ply, out_dir, work_dir, *, debug_sog=False, box=None):
        lod = out_dir / "room_lod"
        lod.mkdir(parents=True, exist_ok=True)
        (lod / "lod-meta.json").write_text(json.dumps({"src": ply.parent.name, "box": box is not None}))
        return CompressResult(lod / "lod-meta.json", None, 1000, [1000, 500, 250])

    monkeypatch.setattr(compress_mod, "compress", fake)


def write_snapshot(root, variant, iters):
    d = root / variant
    d.mkdir(parents=True)
    (d / "splat.ply").write_bytes(b"ply")
    v, t = room_with(*couch())
    export_glb(o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(v), o3d.utility.Vector3iVector(t)),
               d / "collision.glb")
    (d / "done.json").write_text(json.dumps({"iters": iters}))


class FakeTraining:
    """Training that writes progress, then the preview, then finishes, one poll at a time."""

    def __init__(self, root):
        self.root = root
        self.polls = 0

    def wait(self, timeout):
        self.polls += 1
        if self.polls == 1:
            (self.root / "train_progress.json").write_text(json.dumps({"step": 3000, "iters": 30000}))
        elif self.polls == 2:
            write_snapshot(self.root, "preview", 7000)
        elif self.polls == 4:
            write_snapshot(self.root, "final", 30000)
            return {"gpu_seconds": 1234.5, "train": {"train_s": 1200}, "preview": {"iters": 7000}}
        return None


class RecordingStore(LocalStore):
    def __init__(self, root):
        super().__init__(root)
        self.job_rows = []
        self.room_rows = []

    def update_job(self, job_id, row):
        self.job_rows.append(dict(row))
        super().update_job(job_id, row)

    def update_room(self, room_id, row):
        self.room_rows.append(dict(row))
        super().update_room(room_id, row)


def test_follow_training_publishes_preview_then_final(tmp_path, fake_compress):
    root = tmp_path / "work"
    root.mkdir()
    store = RecordingStore(tmp_path / "store")
    rep = JobReporter(store, JOB, ROOM, log=lambda m: None)
    ft = FakeTraining(root)
    out = follow_training(root, TrainHandle(poll=lambda: None, wait=ft.wait), store, rep, scale=0.4)
    rep.done()

    # Room goes preview -> ready, with URLs into each variant's folder and the seats.
    assert [r["status"] for r in store.room_rows] == ["preview", "ready"]
    assert store.room_rows[0]["splat_url"].endswith(f"{FILES_BUCKET}/rooms/{ROOM}/preview/room_lod/lod-meta.json")
    assert store.room_rows[1]["collision_url"].endswith(f"rooms/{ROOM}/final/collision.glb")
    assert len(store.room_rows[1]["seats"]) == 3 and not store.room_rows[1]["seats"][0]["confirmed"]
    files = store.root / FILES_BUCKET / "rooms" / ROOM
    for variant in ("preview", "final"):
        for name in ("room_lod/lod-meta.json", "collision.glb", "seats.json", "meta.json"):
            assert (files / variant / name).exists(), (variant, name)
    assert json.loads((files / "final" / "meta.json").read_text()) == {"gaussianCount": 1000, "floorY": 0.0,
                                                                       "scale": 0.4}
    assert json.loads((files / "preview/room_lod/lod-meta.json").read_text())["src"] == "preview"

    # Job row: progress never goes backwards, preview status while training continues, then ready.
    progress = [r["progress"] for r in store.job_rows]
    assert progress == sorted(progress) and progress[-1] == 1.0
    statuses = [r["status"] for r in store.job_rows]
    assert statuses.index("preview") < statuses.index("ready")
    assert any(r["stage"] == "train" and r["status"] == "preview" for r in store.job_rows)
    final = store.read_row("jobs", JOB)
    assert final["stage"] == "done" and final["gpu_seconds"] == 1234.5
    assert {"train", "preview_seats", "preview_compress", "preview_upload", "final_upload",
            "publish_final"} <= set(final["stage_timings"])
    assert out["final"]["seats"] == 3 and out["preview"]["variant"] == "preview"


def test_fail_stores_user_message_and_failed_room(tmp_path):
    store = RecordingStore(tmp_path)
    rep = JobReporter(store, JOB, ROOM, log=lambda m: None)
    with pytest.raises(PipelineError):
        with rep.run_stage("frames"):
            raise PipelineError("Video too blurry. Record more slowly.", stage="frames")
    rep.fail(PipelineError("Video too blurry. Record more slowly.", stage="frames"))
    row = store.read_row("jobs", JOB)
    assert row["status"] == "failed" and row["stage"] == "frames"
    assert row["error"] == "Video too blurry. Record more slowly."
    assert store.room_rows[-1] == {"status": "failed"}


def test_fail_from_remote_stage_and_unknown_errors(tmp_path):
    store = RecordingStore(tmp_path)
    rep = JobReporter(store, JOB, ROOM, log=lambda m: None)
    rep.fail(PipelineError("Camera tracking failed.", stage="solve"))  # raised in prepare_room
    assert store.read_row("jobs", JOB)["stage"] == "solve"
    rep.fail(RuntimeError("CUDA out of memory"))
    assert store.read_row("jobs", JOB)["error"] == GENERIC_ERROR
    rep.fail(StoreError("HTTP 500"))
    assert "save" in store.read_row("jobs", JOB)["error"]


def test_reporting_errors_do_not_fail_the_job(tmp_path):
    class Broken(LocalStore):
        def update_job(self, job_id, row):
            raise StoreError("down")

    logs = []
    rep = JobReporter(Broken(tmp_path), JOB, ROOM, log=logs.append)
    with rep.run_stage("frames"):
        pass
    assert rep.stage == "frames" and rep.progress == pytest.approx(0.08)
    assert logs and "couldn't update job" in logs[0]


def test_reporter_state_round_trips():
    a = JobReporter(None, JOB, ROOM, log=lambda m: None)
    a.times.wall_s["frames"] = 80.0
    a.add_gpu("train", 5.0)
    a.status, a.stage, a.progress = "solving", "floor", 0.24
    b = JobReporter(None, JOB, ROOM).restore(a.state())
    assert b.state() == a.state() and b.gpu_seconds == 5.0
