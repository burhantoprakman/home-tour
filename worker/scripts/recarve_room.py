"""Re-carve an already built room's collision mesh along its camera path, then redo seats (CPU).

    uv run python scripts/recarve_room.py <scene.npz> <collision.glb> <out_dir>

Writes <out_dir>/collision.glb and <out_dir>/seats.json; the splat is unchanged. For rooms built
before collision.carve_walked_space existed, so they can be fixed without a GPU re-run.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline.collision import crop_box_from_points, recarve_collision  # noqa: E402
from pipeline.meta import OUTPUT_FILES  # noqa: E402
from pipeline.scene import Scene  # noqa: E402
from pipeline.seats import write_seats  # noqa: E402


def main(scene_npz: Path, glb: Path, out_dir: Path) -> None:
    scene = Scene.load_npz(scene_npz)
    cams = scene.camera_centres()
    box = crop_box_from_points(scene.points, cams)  # the box write_variant used
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / OUTPUT_FILES["collision"]
    stats = recarve_collision(glb, out, cams[np.argsort(scene.image_names, kind="stable")], box)
    _, seats = write_seats(out_dir, out, np.zeros(2))
    print(json.dumps({"collision": stats.__dict__, "seats": seats}, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
