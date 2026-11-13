import io
import json
import re
import urllib.error
from pathlib import Path

import pytest

import pipeline.store as store_mod
from pipeline.store import (FILES_BUCKET, VIDEO_BUCKET, LocalStore, StoreError, SupabaseStore, content_type,
                            job_row, room_output_prefix)

JOB_TS = Path(__file__).resolve().parents[2] / "packages" / "shared" / "src" / "job.ts"
URL = "https://abc.supabase.co"
KEY = "service-key"


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class FakeOpener:
    """Stands in for urllib.request.urlopen: records requests, replays canned responses."""

    def __init__(self, responses=None):
        self.requests = []
        self.responses = list(responses or [])

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        r = self.responses.pop(0) if self.responses else b""
        if isinstance(r, Exception):
            raise r
        return FakeResp(r)


def http_error(code, body=b"nope"):
    return urllib.error.HTTPError("u", code, "err", {}, io.BytesIO(body))


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(store_mod.time, "sleep", lambda s: None)


def test_update_job_patches_row_with_service_key():
    op = FakeOpener()
    s = SupabaseStore(URL + "/", KEY, opener=op)
    s.update_job("j-1", job_row(status="training", stage="train", progress=0.5, gpu_seconds=12.34,
                                stage_timings={"frames": 83.04}))
    (req,) = op.requests
    assert req.get_method() == "PATCH"
    assert req.full_url == f"{URL}/rest/v1/jobs?id=eq.j-1"
    assert req.get_header("Apikey") == KEY and req.get_header("Authorization") == f"Bearer {KEY}"
    assert req.get_header("Prefer") == "return=minimal"
    assert json.loads(req.data) == {"status": "training", "stage": "train", "progress": 0.5,
                                    "gpu_seconds": 12.3, "stage_timings": {"frames": 83.0}}


def test_job_row_only_sends_given_fields_and_clamps_progress():
    assert job_row(progress=1.7) == {"progress": 1.0}
    assert job_row(clear_error=True) == {"error": None}
    assert job_row(error="Video too blurry") == {"error": "Video too blurry"}


def test_upload_dir_posts_each_file_with_upsert(tmp_path):
    (tmp_path / "room_lod" / "0_0").mkdir(parents=True)
    (tmp_path / "room_lod" / "lod-meta.json").write_text("{}")
    (tmp_path / "room_lod" / "0_0" / "means_l.webp").write_bytes(b"W")
    (tmp_path / "collision.glb").write_bytes(b"G")
    (tmp_path / "ignored.txt").write_text("x")
    op = FakeOpener()
    s = SupabaseStore(URL, KEY, opener=op)
    done = s.upload_dir(tmp_path, "rooms/r 1/final", ["room_lod", "collision.glb"])
    assert done == ["rooms/r 1/final/room_lod/0_0/means_l.webp", "rooms/r 1/final/room_lod/lod-meta.json",
                    "rooms/r 1/final/collision.glb"]
    urls = [r.full_url for r in op.requests]
    assert urls[0] == f"{URL}/storage/v1/object/{FILES_BUCKET}/rooms/r%201/final/room_lod/0_0/means_l.webp"
    assert [r.get_header("Content-type") for r in op.requests] == ["image/webp", "application/json",
                                                                   "model/gltf-binary"]
    assert all(r.get_method() == "POST" and r.get_header("X-upsert") == "true" for r in op.requests)
    assert op.requests[2].data == b"G"


def test_download_video_streams_to_file(tmp_path):
    op = FakeOpener([b"video-bytes"])
    s = SupabaseStore(URL, KEY, opener=op)
    out = s.download_video("u/room.mov", tmp_path / "in" / "v.mov")
    assert out.read_bytes() == b"video-bytes"
    assert op.requests[0].full_url == f"{URL}/storage/v1/object/authenticated/{VIDEO_BUCKET}/u/room.mov"


def test_retries_server_errors_then_succeeds():
    op = FakeOpener([http_error(503), urllib.error.URLError("reset"), b""])
    SupabaseStore(URL, KEY, opener=op).update_room("r", {"status": "ready"})
    assert len(op.requests) == 3


def test_client_errors_fail_fast_with_detail():
    op = FakeOpener([http_error(404, b'{"message":"bucket not found"}')])
    with pytest.raises(StoreError, match="HTTP 404.*bucket not found"):
        SupabaseStore(URL, KEY, opener=op).update_room("r", {"status": "ready"})
    assert len(op.requests) == 1


def test_missing_credentials():
    with pytest.raises(StoreError):
        SupabaseStore("", "")


def test_public_url_and_helpers():
    s = SupabaseStore(URL, KEY, opener=FakeOpener())
    assert s.public_url("rooms/r/final/collision.glb") == f"{URL}/storage/v1/object/public/{FILES_BUCKET}/rooms/r/final/collision.glb"
    assert room_output_prefix("r", "preview") == "rooms/r/preview"
    with pytest.raises(ValueError):
        room_output_prefix("r", "draft")
    assert content_type("a/b.glb") == "model/gltf-binary"


def test_local_store_round_trip(tmp_path):
    ls = LocalStore(tmp_path)
    (tmp_path / VIDEO_BUCKET / "u").mkdir(parents=True)
    (tmp_path / VIDEO_BUCKET / "u" / "v.mov").write_bytes(b"v")
    assert ls.download_video("u/v.mov", tmp_path / "dl" / "v.mov").read_bytes() == b"v"
    with pytest.raises(StoreError):
        ls.download_video("nope.mov", tmp_path / "x.mov")
    ls.update_job("j", {"status": "solving"})
    ls.update_job("j", {"progress": 0.1})
    assert ls.read_row("jobs", "j") == {"id": "j", "status": "solving", "progress": 0.1}
    src = tmp_path / "out"
    src.mkdir()
    (src / "meta.json").write_text("{}")
    assert ls.upload_dir(src, "rooms/r/final") == ["rooms/r/final/meta.json"]
    assert (tmp_path / FILES_BUCKET / "rooms/r/final/meta.json").exists()


def test_constants_match_shared_contract():
    if not JOB_TS.exists():
        pytest.skip("packages/shared not present")
    src = JOB_TS.read_text()
    assert f"videos: '{VIDEO_BUCKET}'" in src and f"files: '{FILES_BUCKET}'" in src
    assert "return `rooms/${roomId}/${variant}`;" in src
    from pipeline.job import FINAL_ITERS, JOB_STAGES, PREVIEW_ITERS

    assert f"PREVIEW_ITERS = {PREVIEW_ITERS:_}" in src and f"FINAL_ITERS = {FINAL_ITERS:_}" in src
    block = src[src.index("JobStage = z.enum(["):]
    block = block[:block.index("]);")]
    assert tuple(re.findall(r"'(\w+)'", block)) == JOB_STAGES
