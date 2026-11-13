"""Seat suggestions from the collision mesh -> seats.json (WorkerSeats in packages/shared).

The mesh is in the levelled metric frame (+Y up, floor y=0). A seat is a flat, up-facing
surface 40-55 cm above the floor that is big enough to sit on. Up-facing triangles in that
height band are rasterised onto a 5 cm top-down grid, grouped into connected patches, and each
patch big enough to sit on yields one seat per ~60 cm along its long side (a 3-seat couch ->
3 seats). Each seat faces away from its backrest (taller geometry right behind the patch), or
towards the room centre when there is none. Everything is written unconfirmed: the owner
confirms seats in the floor-plan editor (a coffee table at 45 cm will show up too).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MIN_HEIGHT_M = 0.40
MAX_HEIGHT_M = 0.55
MAX_TILT_DEG = 15.0
CELL_M = 0.05
MIN_WIDTH_M = 0.35  # short side of the patch
MIN_LENGTH_M = 0.40  # long side
MIN_AREA_M2 = 0.14
SEAT_PITCH_M = 0.6  # one seat per this much long side
BACKREST_PROBE_M = 0.35  # how far behind a patch edge to look for a backrest
BACKREST_MIN_RISE_M = 0.15  # backrest geometry is at least this much above the seat ...
BACKREST_MAX_RISE_M = 0.70  # ... and at most this much


@dataclass(frozen=True)
class Patch:
    centre: np.ndarray  # (2,) x, z
    height: float  # median y of the surface
    axis: np.ndarray  # (2,) unit long axis in x, z
    length: float
    width: float
    area: float


def triangle_arrays(vertices: np.ndarray, triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-triangle unit normals, areas, and the (T, 3, 3) corner positions."""
    v = np.asarray(vertices, dtype=np.float64)
    t = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    tri = v[t]
    cr = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(cr, axis=1)
    normals = cr / np.maximum(ln, 1e-12)[:, None]
    return normals, 0.5 * ln, tri


def _sample_triangles(tri: np.ndarray, spacing: float) -> np.ndarray:
    """Points on each triangle at most ~spacing apart (barycentric grid), (N, 3)."""
    out = [tri.mean(axis=1)]
    edge = np.max(np.linalg.norm(tri - np.roll(tri, 1, axis=1), axis=2), axis=1)
    steps = np.clip(np.ceil(edge / spacing).astype(int), 1, 200)
    for k in np.unique(steps):
        sel = tri[steps == k]
        ij = np.array([(i, j) for i in range(k + 1) for j in range(k + 1 - i)], dtype=np.float64) / k
        w = np.c_[1 - ij.sum(axis=1), ij]  # (S, 3) barycentric
        out.append(np.einsum("sk,tkd->tsd", w, sel).reshape(-1, 3))
    return np.vstack(out)


def _components(mask: np.ndarray) -> np.ndarray:
    """4-connected labels of a boolean grid (0 = background)."""
    labels = np.zeros(mask.shape, dtype=np.int32)
    n = 0
    H, W = mask.shape
    for i0, j0 in zip(*np.nonzero(mask)):
        if labels[i0, j0]:
            continue
        n += 1
        stack = [(i0, j0)]
        labels[i0, j0] = n
        while stack:
            i, j = stack.pop()
            for a, b in ((i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)):
                if 0 <= a < H and 0 <= b < W and mask[a, b] and not labels[a, b]:
                    labels[a, b] = n
                    stack.append((a, b))
    return labels


def _close(mask: np.ndarray) -> np.ndarray:
    """One-cell binary closing (fills pinholes from TSDF/decimation)."""
    def dilate(m: np.ndarray) -> np.ndarray:
        p = np.pad(m, 1)
        return p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]

    def erode(m: np.ndarray) -> np.ndarray:
        p = np.pad(m, 1)
        return p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]

    return mask | erode(dilate(mask))


def find_patches(vertices: np.ndarray, triangles: np.ndarray, *, cell: float = CELL_M) -> list[Patch]:
    normals, _, tri = triangle_arrays(vertices, triangles)
    cy = tri[:, :, 1].mean(axis=1)
    sel = (normals[:, 1] > math.cos(math.radians(MAX_TILT_DEG))) & (cy >= MIN_HEIGHT_M) & (cy <= MAX_HEIGHT_M)
    if not np.any(sel):
        return []
    pts = _sample_triangles(tri[sel], cell * 0.5)
    pts = pts[(pts[:, 1] >= MIN_HEIGHT_M - 0.02) & (pts[:, 1] <= MAX_HEIGHT_M + 0.02)]
    origin = pts[:, [0, 2]].min(axis=0) - cell
    ij = np.floor((pts[:, [0, 2]] - origin) / cell).astype(int)
    shape = tuple(ij.max(axis=0) + 2)
    occ = np.zeros(shape, dtype=bool)
    occ[ij[:, 0], ij[:, 1]] = True
    height = np.zeros(shape)
    np.add.at(height, (ij[:, 0], ij[:, 1]), pts[:, 1])
    count = np.zeros(shape)
    np.add.at(count, (ij[:, 0], ij[:, 1]), 1)
    labels = _components(_close(occ))
    out = []
    for lab in range(1, labels.max() + 1):
        cells = np.argwhere(labels == lab)
        area = len(cells) * cell * cell
        if area < MIN_AREA_M2:
            continue
        xz = origin + (cells + 0.5) * cell
        c = xz.mean(axis=0)
        if len(cells) >= 2:
            _, vecs = np.linalg.eigh(np.cov((xz - c).T))
            axis = vecs[:, 1]
        else:
            axis = np.array([1.0, 0.0])
        perp = np.array([-axis[1], axis[0]])
        u, w = (xz - c) @ axis, (xz - c) @ perp
        length = float(u.max() - u.min() + cell)
        width = float(w.max() - w.min() + cell)
        if width < MIN_WIDTH_M or length < MIN_LENGTH_M:
            continue
        # recentre on the oriented box (the mean is pulled by uneven sampling)
        c = c + axis * (u.max() + u.min()) / 2 + perp * (w.max() + w.min()) / 2
        hc = cells[count[cells[:, 0], cells[:, 1]] > 0]
        h = float(np.median(height[hc[:, 0], hc[:, 1]] / count[hc[:, 0], hc[:, 1]])) if len(hc) else MIN_HEIGHT_M
        out.append(Patch(c, h, axis, length, width, area))
    return out


def _yaw_facing(d: np.ndarray) -> float:
    """facingYaw (Seat contract: 0 faces -Z, direction (-sin, 0, -cos)) for an x,z direction."""
    return float(math.atan2(-d[0], -d[1]))


def _backrest_support(vertices_xyz: np.ndarray, p: Patch, side: np.ndarray, half_len: float) -> int:
    rel = vertices_xyz[:, [0, 2]] - p.centre
    along = rel @ p.axis
    out = rel @ side - p.width / 2
    dy = vertices_xyz[:, 1] - p.height
    return int(np.sum((np.abs(along) <= half_len) & (out > -0.05) & (out <= BACKREST_PROBE_M)
                      & (dy >= BACKREST_MIN_RISE_M) & (dy <= BACKREST_MAX_RISE_M)))


def detect_seats(vertices: np.ndarray, triangles: np.ndarray, room_centre_xz: np.ndarray | None = None) -> list[dict]:
    """Seat dicts matching the shared Seat contract (all confirmed: false)."""
    v = np.asarray(vertices, dtype=np.float64)
    if len(v) == 0:
        return []
    centre = (np.asarray(room_centre_xz, dtype=np.float64) if room_centre_xz is not None
              else (v[:, [0, 2]].min(axis=0) + v[:, [0, 2]].max(axis=0)) / 2)
    _, _, tri = triangle_arrays(v, triangles)
    probe = _sample_triangles(tri, 0.05)  # dense surface samples for the backrest test
    seats = []
    for p in sorted(find_patches(v, triangles), key=lambda q: (round(q.centre[0], 2), round(q.centre[1], 2))):
        perp = np.array([-p.axis[1], p.axis[0]])
        a = _backrest_support(probe, p, perp, p.length / 2)
        b = _backrest_support(probe, p, -perp, p.length / 2)
        if max(a, b) >= 3 and max(a, b) >= 2 * min(a, b):
            facing = -perp if a > b else perp
        else:
            to_c = centre - p.centre
            facing = perp if to_c @ perp >= 0 else -perp
        n = max(1, int(p.length // SEAT_PITCH_M))
        offsets = (np.arange(n) - (n - 1) / 2) * (p.length / n)
        for off in offsets:
            xz = p.centre + p.axis * off
            seats.append({
                "id": f"seat-{len(seats) + 1}",
                "position": [round(float(xz[0]), 3), round(p.height, 3), round(float(xz[1]), 3)],
                "facingYaw": round(_yaw_facing(facing), 4),
                "confirmed": False,
            })
    return seats


def read_glb_mesh(path: Path) -> tuple[np.ndarray, np.ndarray]:
    import open3d as o3d

    m = o3d.io.read_triangle_mesh(str(path))
    return np.asarray(m.vertices), np.asarray(m.triangles)


def write_seats(out_dir: Path, collision_glb: Path, room_centre_xz: np.ndarray | None = None) -> tuple[Path, list[dict]]:
    """Detect seats on collision.glb and write <out_dir>/seats.json."""
    from .meta import OUTPUT_FILES

    v, t = read_glb_mesh(collision_glb)
    seats = detect_seats(v, t, room_centre_xz)
    path = Path(out_dir) / OUTPUT_FILES["seats"]
    path.write_text(json.dumps(seats, indent=2) + "\n")
    return path, seats
