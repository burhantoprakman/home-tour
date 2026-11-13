"""Solved scene: pinhole cameras + sparse points, in one world frame.

This is what moves between stages (and to the GPU): `save_npz` / `load_npz` keep it as
plain numpy so the Modal side needs no COLMAP.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np


@dataclass
class Scene:
    image_names: list[str]  # file names inside the images dir
    K: np.ndarray  # (C, 3, 3) pinhole intrinsics
    width: np.ndarray  # (C,) int
    height: np.ndarray  # (C,) int
    w2c: np.ndarray  # (C, 4, 4) world-to-camera, OpenCV/COLMAP camera axes
    points: np.ndarray  # (P, 3) sparse points
    colors: np.ndarray  # (P, 3) uint8

    @property
    def num_cameras(self) -> int:
        return len(self.image_names)

    def camera_centres(self) -> np.ndarray:
        R = self.w2c[:, :3, :3]
        t = self.w2c[:, :3, 3]
        return -np.einsum("cji,cj->ci", R, t)  # -R^T t

    def save_npz(self, path: Path) -> None:
        np.savez(
            path, image_names=np.array(self.image_names), K=self.K, width=self.width,
            height=self.height, w2c=self.w2c, points=self.points, colors=self.colors,
        )

    @staticmethod
    def load_npz(path: Path) -> Scene:
        d = np.load(path)
        return Scene([str(x) for x in d["image_names"]], d["K"], d["width"], d["height"],
                     d["w2c"], d["points"], d["colors"])


def select_cameras(scene: Scene, keep: np.ndarray) -> Scene:
    """The scene with only the cameras where `keep` is True (points unchanged)."""
    k = np.asarray(keep, dtype=bool)
    return replace(scene, image_names=[n for n, m in zip(scene.image_names, k) if m], K=scene.K[k],
                   width=scene.width[k], height=scene.height[k], w2c=scene.w2c[k])


def apply_similarity(scene: Scene, s: float, R: np.ndarray, T: np.ndarray) -> Scene:
    """Map the world by x' = s R x + T. Camera frames are scaled too, so depths become metric."""
    w2c = scene.w2c.copy()
    Rc = scene.w2c[:, :3, :3]
    tc = scene.w2c[:, :3, 3]
    Rc_new = Rc @ R.T
    tc_new = s * tc - np.einsum("cij,j->ci", Rc_new, T)
    w2c[:, :3, :3] = Rc_new
    w2c[:, :3, 3] = tc_new
    pts = (s * (R @ scene.points.T)).T + T
    return replace(scene, w2c=w2c, points=pts)


def _quat_to_R(qw: float, qx: float, qy: float, qz: float) -> np.ndarray:
    q = np.array([qw, qx, qy, qz], dtype=np.float64)
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def _data_lines(path: Path) -> list[str]:
    return [ln for ln in path.read_text().splitlines() if ln.strip() and not ln.startswith("#")]


def read_colmap_text(model_dir: Path, *, max_reproj_error: float = 2.0, min_track: int = 3) -> Scene:
    """Parse a PINHOLE / SIMPLE_PINHOLE COLMAP text model (i.e. after image_undistorter)."""
    model_dir = Path(model_dir)
    cams: dict[int, tuple[np.ndarray, int, int]] = {}
    for ln in _data_lines(model_dir / "cameras.txt"):
        p = ln.split()
        cid, model, w, h = int(p[0]), p[1], int(p[2]), int(p[3])
        prm = [float(v) for v in p[4:]]
        if model == "PINHOLE":
            fx, fy, cx, cy = prm
        elif model == "SIMPLE_PINHOLE":
            fx = fy = prm[0]
            cx, cy = prm[1], prm[2]
        else:
            raise ValueError(f"camera {cid} is {model}; undistort to PINHOLE first")
        cams[cid] = (np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]]), w, h)

    names, Ks, ws, hs, w2cs = [], [], [], [], []
    lines = _data_lines(model_dir / "images.txt")
    # images.txt alternates a pose line and a 2D-points line; the points line may be empty,
    # which _data_lines drops, so parse pose lines by field count instead of by parity.
    for ln in lines:
        p = ln.split()
        if len(p) != 10 or not p[0].isdigit():
            continue
        try:
            qw, qx, qy, qz, tx, ty, tz = (float(v) for v in p[1:8])
            cid = int(p[8])
        except ValueError:
            continue
        if cid not in cams:
            continue
        M = np.eye(4)
        M[:3, :3] = _quat_to_R(qw, qx, qy, qz)
        M[:3, 3] = [tx, ty, tz]
        K, w, h = cams[cid]
        names.append(p[9])
        Ks.append(K)
        ws.append(w)
        hs.append(h)
        w2cs.append(M)
    order = np.argsort(names)

    pts, cols = [], []
    pts_file = model_dir / "points3D.txt"
    if pts_file.exists():
        for ln in _data_lines(pts_file):
            p = ln.split()
            err = float(p[7])
            track = (len(p) - 8) // 2
            if err > max_reproj_error or track < min_track:
                continue
            pts.append([float(p[1]), float(p[2]), float(p[3])])
            cols.append([int(p[4]), int(p[5]), int(p[6])])
    return Scene(
        image_names=[names[i] for i in order],
        K=np.array([Ks[i] for i in order]).reshape(-1, 3, 3),
        width=np.array([ws[i] for i in order], dtype=np.int64),
        height=np.array([hs[i] for i in order], dtype=np.int64),
        w2c=np.array([w2cs[i] for i in order]).reshape(-1, 4, 4),
        points=np.array(pts, dtype=np.float64).reshape(-1, 3),
        colors=np.array(cols, dtype=np.uint8).reshape(-1, 3),
    )
