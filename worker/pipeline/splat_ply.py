"""Standard 3DGS PLY (INRIA layout) read/write with numpy only.

Stored values are the raw optimiser parameters: log scales, logit opacity, unnormalised
wxyz quaternions, SH DC + rest (rest stored channel-major, as INRIA/gsplat do). This is
the layout splat-transform reads.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class Splats:
    means: np.ndarray  # (N, 3) float32
    scales: np.ndarray  # (N, 3) log scale
    quats: np.ndarray  # (N, 4) wxyz
    opacities: np.ndarray  # (N,) logit
    sh0: np.ndarray  # (N, 3)
    sh_rest: np.ndarray  # (N, K, 3), K = (deg+1)^2 - 1

    @property
    def count(self) -> int:
        return int(self.means.shape[0])

    def finite_mask(self) -> np.ndarray:
        parts = [self.means, self.scales, self.quats, self.opacities[:, None], self.sh0,
                 self.sh_rest.reshape(self.count, -1)]
        mask = np.ones(self.count, dtype=bool)
        for p in parts:
            mask &= np.isfinite(p).all(axis=1)
        mask &= np.linalg.norm(self.quats, axis=1) > 0
        return mask

    def subset(self, mask: np.ndarray) -> Splats:
        return Splats(self.means[mask], self.scales[mask], self.quats[mask],
                      self.opacities[mask], self.sh0[mask], self.sh_rest[mask])


def write_ply(path: Path, s: Splats) -> int:
    """Write finite Gaussians only; returns how many were written."""
    s = s.subset(s.finite_mask())
    n = s.count
    k = s.sh_rest.shape[1]
    # INRIA order for f_rest: all R coefficients, then G, then B.
    rest = np.transpose(s.sh_rest, (0, 2, 1)).reshape(n, 3 * k)
    cols = [s.means, s.sh0, rest, s.opacities[:, None], s.scales, s.quats]
    data = np.concatenate([np.asarray(c, dtype=np.float32) for c in cols], axis=1)
    names = (["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2"]
             + [f"f_rest_{i}" for i in range(3 * k)]
             + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    header = "ply\nformat binary_little_endian 1.0\n" f"element vertex {n}\n"
    header += "".join(f"property float {nm}\n" for nm in names) + "end_header\n"
    path = Path(path)
    with path.open("wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.astype("<f4").tobytes())
    return n


def read_ply_vertex_count(path: Path) -> int:
    with Path(path).open("rb") as f:
        for _ in range(200):
            line = f.readline().decode("ascii", errors="replace").strip()
            if line.startswith("element vertex"):
                return int(line.split()[-1])
            if line == "end_header":
                break
    raise ValueError(f"{path}: no 'element vertex' in PLY header")
