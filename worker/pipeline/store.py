"""Storage + jobs table access (Supabase REST/Storage over the stdlib, no SDK).

Mirrors packages/shared/src/job.ts:
  jobs   PATCH /rest/v1/jobs?id=eq.<id>   {status, stage, progress, error, gpu_seconds, stage_timings}
  rooms  PATCH /rest/v1/rooms?id=eq.<id>  {status, splat_url, collision_url, seats}
  files  GET  /storage/v1/object/authenticated/room-videos/<video_path>
         POST /storage/v1/object/room-files/rooms/<roomId>/<preview|final>/<file>  (x-upsert)
Credentials: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Modal secret `home-tour-supabase`).

LocalStore implements the same interface on a directory (Modal volume or a temp dir) for
dry runs and tests: "buckets" are folders, table rows are JSON files.
"""

from __future__ import annotations

import json
import mimetypes
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Protocol

# STORAGE_BUCKETS / roomOutputPrefix in packages/shared/src/job.ts
VIDEO_BUCKET = "room-videos"
FILES_BUCKET = "room-files"
SECRET_NAME = "home-tour-supabase"
CONTENT_TYPES = {".json": "application/json", ".glb": "model/gltf-binary", ".webp": "image/webp",
                 ".sog": "application/octet-stream", ".ply": "application/octet-stream"}
RETRIES = 3
TIMEOUT_S = 120


def room_output_prefix(room_id: str, variant: str) -> str:
    if variant not in ("preview", "final"):
        raise ValueError(f"variant must be preview or final, got {variant!r}")
    return f"rooms/{room_id}/{variant}"


def content_type(path: str) -> str:
    ext = Path(path).suffix.lower()
    return CONTENT_TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"


def job_row(*, status: str | None = None, stage: str | None = None, progress: float | None = None,
            error: str | None = None, gpu_seconds: float | None = None,
            stage_timings: dict[str, float] | None = None, clear_error: bool = False) -> dict[str, Any]:
    """Snake-case `jobs` columns for a PATCH (only the fields given)."""
    row: dict[str, Any] = {}
    if status is not None:
        row["status"] = status
    if stage is not None:
        row["stage"] = stage
    if progress is not None:
        row["progress"] = round(min(1.0, max(0.0, float(progress))), 4)
    if error is not None or clear_error:
        row["error"] = error
    if gpu_seconds is not None:
        row["gpu_seconds"] = round(float(gpu_seconds), 1)
    if stage_timings is not None:
        row["stage_timings"] = {k: round(float(v), 1) for k, v in stage_timings.items()}
    return row


class Store(Protocol):
    def download_video(self, video_path: str, dest: Path) -> Path: ...
    def upload_dir(self, local_dir: Path, prefix: str, names: list[str] | None = None) -> list[str]: ...
    def public_url(self, path: str) -> str: ...
    def update_job(self, job_id: str, row: dict[str, Any]) -> None: ...
    def update_room(self, room_id: str, row: dict[str, Any]) -> None: ...


def _files_under(local_dir: Path, names: list[str] | None) -> list[Path]:
    local_dir = Path(local_dir)
    if names is None:
        return sorted(p for p in local_dir.rglob("*") if p.is_file())
    out: list[Path] = []
    for n in names:
        p = local_dir / n
        out += sorted(q for q in p.rglob("*") if q.is_file()) if p.is_dir() else [p]
    return out


class StoreError(RuntimeError):
    pass


class SupabaseStore:
    def __init__(self, url: str, service_key: str, *, opener: Any = None) -> None:
        if not url or not service_key:
            raise StoreError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
        self.url = url.rstrip("/")
        self.key = service_key
        self._open = opener or urllib.request.urlopen

    @classmethod
    def from_env(cls) -> SupabaseStore:
        return cls(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        h.update(extra or {})
        return h

    def _request(self, method: str, path: str, *, body: bytes | None = None,
                 headers: dict[str, str] | None = None, stream_to: Path | None = None) -> bytes:
        req = urllib.request.Request(f"{self.url}{path}", data=body, method=method,
                                     headers=self._headers(headers))
        last: Exception | None = None
        for attempt in range(RETRIES):
            try:
                with self._open(req, timeout=TIMEOUT_S) as resp:
                    if stream_to is not None:
                        with Path(stream_to).open("wb") as f:
                            shutil.copyfileobj(resp, f, 1 << 20)
                        return b""
                    return resp.read()
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:300] if e.fp else ""
                last = StoreError(f"{method} {path} -> HTTP {e.code}: {detail}")
                if e.code < 500 and e.code != 429:
                    break  # client error: retrying won't help
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last = StoreError(f"{method} {path} -> {e}")
            if attempt + 1 < RETRIES:
                time.sleep(2 ** attempt)
        raise last or StoreError(f"{method} {path} failed")

    @staticmethod
    def _q(path: str) -> str:
        return urllib.parse.quote(path, safe="/")

    def download_video(self, video_path: str, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        self._request("GET", f"/storage/v1/object/authenticated/{VIDEO_BUCKET}/{self._q(video_path)}",
                      stream_to=dest)
        return dest

    def upload_file(self, local: Path, path: str) -> None:
        self._request("POST", f"/storage/v1/object/{FILES_BUCKET}/{self._q(path)}", body=Path(local).read_bytes(),
                      headers={"Content-Type": content_type(path), "x-upsert": "true",
                               "Cache-Control": "max-age=31536000"})

    def upload_dir(self, local_dir: Path, prefix: str, names: list[str] | None = None) -> list[str]:
        done = []
        for p in _files_under(local_dir, names):
            rel = p.relative_to(local_dir).as_posix()
            self.upload_file(p, f"{prefix}/{rel}")
            done.append(f"{prefix}/{rel}")
        return done

    def public_url(self, path: str) -> str:
        return f"{self.url}/storage/v1/object/public/{FILES_BUCKET}/{self._q(path)}"

    def _patch(self, table: str, row_id: str, row: dict[str, Any]) -> None:
        self._request("PATCH", f"/rest/v1/{table}?id=eq.{urllib.parse.quote(row_id)}",
                      body=json.dumps(row).encode(),
                      headers={"Content-Type": "application/json", "Prefer": "return=minimal"})

    def update_job(self, job_id: str, row: dict[str, Any]) -> None:
        self._patch("jobs", job_id, row)

    def update_room(self, room_id: str, row: dict[str, Any]) -> None:
        self._patch("rooms", room_id, row)


class LocalStore:
    """Same interface on a directory: <root>/<bucket>/<path>, <root>/<table>/<id>.json."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def download_video(self, video_path: str, dest: Path) -> Path:
        src = self.root / VIDEO_BUCKET / video_path
        if not src.is_file():
            raise StoreError(f"no video at {src}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        return dest

    def upload_dir(self, local_dir: Path, prefix: str, names: list[str] | None = None) -> list[str]:
        done = []
        for p in _files_under(local_dir, names):
            rel = p.relative_to(local_dir).as_posix()
            dst = self.root / FILES_BUCKET / prefix / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dst)
            done.append(f"{prefix}/{rel}")
        return done

    def public_url(self, path: str) -> str:
        return (self.root / FILES_BUCKET / path).as_uri()

    def _merge(self, table: str, row_id: str, row: dict[str, Any]) -> None:
        p = self.root / table / f"{row_id}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        cur = json.loads(p.read_text()) if p.exists() else {"id": row_id}
        cur.update(row)
        p.write_text(json.dumps(cur, indent=2))

    def read_row(self, table: str, row_id: str) -> dict[str, Any]:
        return json.loads((self.root / table / f"{row_id}.json").read_text())

    def update_job(self, job_id: str, row: dict[str, Any]) -> None:
        self._merge("jobs", job_id, row)

    def update_room(self, room_id: str, row: dict[str, Any]) -> None:
        self._merge("rooms", room_id, row)
