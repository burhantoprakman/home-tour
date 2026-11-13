import json
import re
from pathlib import Path

import pytest

from pipeline.meta import OUTPUT_FILES, make_meta, write_meta
from run_local import default_out_dir

SHARED = Path(__file__).resolve().parents[2] / "packages" / "shared" / "src" / "worker.ts"


def test_meta_shape(tmp_path):
    p = write_meta(tmp_path, 1_234_567, 0.0, 0.73)
    assert p.name == "meta.json"
    d = json.loads(p.read_text())
    assert set(d) == {"gaussianCount", "floorY", "scale"}
    assert isinstance(d["gaussianCount"], int) and d["gaussianCount"] == 1_234_567
    assert isinstance(d["floorY"], float) and isinstance(d["scale"], float)


@pytest.mark.parametrize("args", [(-1, 0.0, 1.0), (1.5, 0.0, 1.0), (True, 0.0, 1.0),
                                  (10, float("nan"), 1.0), (10, 0.0, 0.0), (10, 0.0, -2.0),
                                  (10, 0.0, float("inf"))])
def test_meta_rejects_invalid(args):
    with pytest.raises(ValueError):
        make_meta(*args)


def test_file_names_match_shared_contract():
    if not SHARED.exists():
        pytest.skip("packages/shared not present")
    src = SHARED.read_text()
    block = src[src.index("WORKER_OUTPUT_FILES"):src.index("} as const")]
    ts = dict(re.findall(r"(\w+):\s*'([^']+)'", block))
    assert ts == OUTPUT_FILES
    meta_block = src[src.index("WorkerMeta = z.object"):]
    meta_block = meta_block[:meta_block.index("});")]
    assert set(re.findall(r"(\w+):\s*z\.", meta_block)) == set(make_meta(0, 0.0, 1.0))


def test_step1_outputs():
    assert list(OUTPUT_FILES.values()) == ["room_lod/lod-meta.json", "collision.glb", "seats.json", "meta.json"]


def test_default_out_dir():
    assert default_out_dir(Path("/x/kitchen.mov")) == Path("/x/kitchen_out")
