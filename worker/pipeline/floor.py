"""Stage 3: find the floor, level it to y=0 (+Y up), and scale to metres.

RANSAC on sparse points for planes that (a) roughly face the "up" the cameras agree on and
(b) have the cameras above them; the plane with most support wins. Scale comes from
assuming the median camera height above that floor is ~1.4 m. The scene is then mapped by
a similarity so everything downstream (training, collision, SOG) is in the levelled metric
frame: +Y up, floor at y=0, origin under the cameras' centroid, longest room axis on X.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .errors import PipelineError
from .scene import Scene, apply_similarity, select_cameras

STAGE = "floor"
CAMERA_HEIGHT_M = 1.4
MAX_TILT_DEG = 30.0


@dataclass(frozen=True)
class FloorFit:
    normal: np.ndarray  # unit, pointing from the floor towards the cameras
    offset: float  # plane: normal . x + offset = 0
    inliers: int
    camera_height: float  # median camera height above floor, in input units


@dataclass(frozen=True)
class Alignment:
    scale: float  # metres per input unit
    R: np.ndarray  # (3, 3)
    T: np.ndarray  # (3,)  x' = scale * R x + T

    def apply(self, x: np.ndarray) -> np.ndarray:
        return (self.scale * (self.R @ np.asarray(x, dtype=np.float64).T)).T + self.T


def camera_up_hint(w2c: np.ndarray) -> np.ndarray:
    """Mean world direction of image-up (-Y in OpenCV camera axes) over all cameras."""
    up = -w2c[:, 1, :3]  # rows of R are camera axes in world coords: R^T e_y = R[1]
    v = up.sum(axis=0)
    n = np.linalg.norm(v)
    if n < 1e-9:
        raise PipelineError("Couldn't tell which way is up. Hold the phone upright while recording.", stage=STAGE)
    return v / n


def _plane_from(p: np.ndarray) -> tuple[np.ndarray, float] | None:
    n = np.cross(p[1] - p[0], p[2] - p[0])
    ln = np.linalg.norm(n)
    if ln < 1e-12:
        return None
    n /= ln
    return n, -float(n @ p[0])


def fit_floor(
    points: np.ndarray,
    cam_centres: np.ndarray,
    up_hint: np.ndarray,
    *,
    iters: int = 2000,
    seed: int = 0,
) -> FloorFit:
    pts = np.asarray(points, dtype=np.float64)
    cams = np.asarray(cam_centres, dtype=np.float64)
    if len(pts) < 50:
        raise PipelineError("Too few 3D points to find the floor. Make sure the floor is in view.",
                            stage=STAGE, detail=f"{len(pts)} points")
    # Scale-free inlier threshold: 1% of the robust scene extent.
    extent = float(np.linalg.norm(np.percentile(pts, 90, axis=0) - np.percentile(pts, 10, axis=0)))
    thresh = max(1e-6, 0.01 * extent)
    cos_tilt = np.cos(np.radians(MAX_TILT_DEG))
    rng = np.random.default_rng(seed)
    best: tuple[int, np.ndarray, float] | None = None
    for _ in range(iters):
        pl = _plane_from(pts[rng.choice(len(pts), 3, replace=False)])
        if pl is None:
            continue
        n, d = pl
        if n @ up_hint < 0:
            n, d = -n, -d
        if n @ up_hint < cos_tilt:
            continue
        cam_h = cams @ n + d
        if np.mean(cam_h > 0) < 0.9:  # cameras must be above it (rules out ceilings)
            continue
        count = int(np.sum(np.abs(pts @ n + d) < thresh))
        if best is None or count > best[0]:
            best = (count, n, d)
    if best is None or best[0] < 30:
        raise PipelineError("Couldn't find the floor. Tilt the camera down so the floor is in view "
                            "for part of the video.", stage=STAGE)
    _, n, d = best
    # Least-squares refine on inliers.
    inl = pts[np.abs(pts @ n + d) < thresh]
    c = inl.mean(axis=0)
    # Smallest-eigenvalue eigenvector of the 3x3 covariance (an SVD of the N x 3 inliers with
    # full_matrices would build an N x N matrix: minutes for 40k points).
    _, vecs = np.linalg.eigh(np.cov((inl - c).T))
    nrm = vecs[:, 0]
    n2 = nrm if nrm @ n > 0 else -nrm
    d2 = -float(n2 @ c)
    inliers = int(np.sum(np.abs(pts @ n2 + d2) < thresh))
    height = float(np.median(cams @ n2 + d2))
    if height <= 0:
        raise PipelineError("Couldn't find the floor below the camera path.", stage=STAGE)
    return FloorFit(n2, d2, inliers, height)


def _rotation_to_y(n: np.ndarray) -> np.ndarray:
    """Proper rotation taking unit vector n to +Y."""
    y = np.array([0.0, 1.0, 0.0])
    v = np.cross(n, y)
    c = float(n @ y)
    if np.linalg.norm(v) < 1e-12:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def alignment_from_floor(fit: FloorFit, points: np.ndarray, cam_centres: np.ndarray,
                         camera_height_m: float = CAMERA_HEIGHT_M) -> Alignment:
    s = camera_height_m / fit.camera_height
    R1 = _rotation_to_y(fit.normal)
    # Yaw: put the main horizontal axis of the points on X.
    xz = (R1 @ np.asarray(points, dtype=np.float64).T).T[:, [0, 2]]
    xz = xz - xz.mean(axis=0)
    _, _, vt = np.linalg.svd(xz, full_matrices=False)
    ax = vt[0]
    yaw = np.arctan2(ax[1], ax[0])  # angle of main axis from +X towards +Z
    cy, sy = np.cos(yaw), np.sin(yaw)
    # Rotation about Y by +yaw maps (cos, 0, sin) onto +X.
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    R = Ry @ R1
    # Translate: floor to y=0, camera centroid to x=z=0.
    floor_pt = -fit.offset * fit.normal  # a point on the plane
    T = -s * (R @ floor_pt)
    cam_c = (s * (R @ np.asarray(cam_centres).T)).T + T
    T = T - np.array([cam_c[:, 0].mean(), 0.0, cam_c[:, 2].mean()])
    return Alignment(s, R, T)


# Folded-solve check (on the levelled, metric scene). A real room has almost nothing below its
# floor and a handheld walk-through keeps the phone within ~1 m of height. On the newsalon
# video GLOMAP folded the room into a tilted copy: 48% of sparse points > 15 cm below the
# fitted floor and camera heights spread 4.4 m (5th-95th pct); the incremental solve of the
# same matches: 0.1% and 1.0 m.
BELOW_FLOOR_M = 0.15
MAX_BELOW_FLOOR_FRACTION = 0.05
MAX_CAMERA_HEIGHT_SPREAD_M = 2.0
# Broken path: a hand-held camera moves continuously, so consecutive frames (image names are
# frame numbers) are close. GLOMAP placed job 9acd3d47's video as 5 pieces: the window-side
# start (37 frames) 2-3 m up and 2.3 m / 46 deg away from the next frame, which shows the same
# couch; the largest jump-free piece held 52% of the cameras (newsalon2 80%, salon 97%).
# Training on that put the window side nowhere and filled the walkway with floaters.
PATH_JUMP_M = 0.6  # a step longer than this ...
PATH_JUMP_M_PER_FRAME = 0.3  # ... and faster than this per frame number is a teleport
MIN_MAIN_PATH_FRACTION = 0.7


@dataclass(frozen=True)
class SolveCheck:
    below_floor_fraction: float
    camera_height_spread_m: float
    floor_fraction: float
    problems: tuple[str, ...]
    main_path_fraction: float = 1.0

    @property
    def ok(self) -> bool:
        return not self.problems


def _frame_numbers(names: list[str]) -> np.ndarray:
    nums = []
    for i, n in enumerate(names):
        stem = n.rsplit("/", 1)[-1].split(".", 1)[0]
        nums.append(int(stem) if stem.isdigit() else i)
    return np.asarray(nums, dtype=np.int64)


def path_segments(levelled: Scene) -> list[np.ndarray]:
    """Camera indices (time order) split wherever the path teleports; metric frame."""
    if levelled.num_cameras == 0:
        return []
    frames = _frame_numbers(levelled.image_names)
    order = np.argsort(frames, kind="stable")
    c = levelled.camera_centres()[order]
    step = np.linalg.norm(np.diff(c, axis=0), axis=1)
    gap = np.maximum(1, np.diff(frames[order]))
    cuts = np.nonzero((step > PATH_JUMP_M) & (step / gap > PATH_JUMP_M_PER_FRAME))[0] + 1
    return np.split(order, cuts)


def main_path_fraction(levelled: Scene) -> float:
    segs = path_segments(levelled)
    return max(len(s) for s in segs) / levelled.num_cameras if segs else 0.0


def check_levelled(levelled: Scene, floor_inliers: int) -> SolveCheck:
    """Plausibility of a levelled metric scene (floor y=0); problems is empty when it looks fine."""
    p = levelled.points
    cam_y = levelled.camera_centres()[:, 1]
    below = float(np.mean(p[:, 1] < -BELOW_FLOOR_M)) if len(p) else 1.0
    spread = float(np.percentile(cam_y, 95) - np.percentile(cam_y, 5)) if len(cam_y) else 0.0
    problems = []
    if below > MAX_BELOW_FLOOR_FRACTION:
        problems.append(f"{below:.0%} of points are below the floor")
    if spread > MAX_CAMERA_HEIGHT_SPREAD_M:
        problems.append(f"camera heights spread {spread:.1f} m")
    main = main_path_fraction(levelled)
    if main < MIN_MAIN_PATH_FRACTION:
        problems.append(f"camera path breaks into pieces (largest {main:.0%})")
    return SolveCheck(below, spread, floor_inliers / max(1, len(p)), tuple(problems), main)


def check_solve(scene: Scene) -> SolveCheck:
    """Level a raw solve and check it (cheap: one RANSAC on the sparse points)."""
    try:
        lv, _, fit = level_scene(scene, quiet=True, drop_outliers=False)
    except PipelineError as e:
        return SolveCheck(1.0, 0.0, 0.0, (f"no floor: {e.user_message}",))
    return check_levelled(lv, fit.inliers)


# Mis-registered cameras (levelled metric frame). On job 9acd3d47 GLOMAP put 6 frames of a
# blank wall on a path flying 33 m away and 12 m up, plus 3 frames at floor level; the 5-95th
# percentile checks above didn't see them, but they set the trainer's scene scale (means LR and
# MCMC noise 8x too big: the Gaussians diffused out of the room) and the collision box's top
# (13 m walls). A hand-held phone stays between knee and just above head height.
CAMERA_Y_MIN_M = 0.2
CAMERA_Y_MAX_M = 3.0
CAMERA_FAR_FACTOR = 3.0  # horizontal distance from the median camera vs its 90th percentile
CAMERA_FAR_MIN_M = 3.0
MAX_DROPPED_CAMERA_FRACTION = 0.25


def outlier_cameras(cam_centres: np.ndarray) -> np.ndarray:
    """Mask of implausible camera positions in the levelled metric frame (floor y=0, +Y up)."""
    c = np.asarray(cam_centres, dtype=np.float64)
    bad = (c[:, 1] < CAMERA_Y_MIN_M) | (c[:, 1] > CAMERA_Y_MAX_M)
    good = c[~bad] if np.any(~bad) else c
    med = np.median(good[:, [0, 2]], axis=0)
    r = np.linalg.norm(c[:, [0, 2]] - med, axis=1)
    lim = max(CAMERA_FAR_MIN_M, CAMERA_FAR_FACTOR * float(np.percentile(r[~bad] if np.any(~bad) else r, 90)))
    return bad | (r > lim)


def drop_outlier_cameras(levelled: Scene, *, quiet: bool = False) -> Scene:
    """Remove mis-registered cameras; fails (user-readable) if too many of them are off."""
    bad = outlier_cameras(levelled.camera_centres())
    n = int(bad.sum())
    if n == 0:
        return levelled
    if n > MAX_DROPPED_CAMERA_FRACTION * len(bad):
        raise PipelineError("The camera path couldn't be worked out for much of the video. Record again, "
                            "moving slowly and keeping furniture or corners in view.", stage=STAGE,
                            detail=f"{n}/{len(bad)} cameras at implausible positions")
    if not quiet:
        names = [nm for nm, b in zip(levelled.image_names, bad) if b]
        print(f"[floor] dropped {n} mis-registered cameras: {', '.join(names[:12])}"
              + (" ..." if n > 12 else ""), flush=True)
    return select_cameras(levelled, ~bad)


def level_scene(scene: Scene, *, quiet: bool = False,
                drop_outliers: bool = True) -> tuple[Scene, Alignment, FloorFit]:
    cams = scene.camera_centres()
    fit = fit_floor(scene.points, cams, camera_up_hint(scene.w2c))
    al = alignment_from_floor(fit, scene.points, cams)
    out = apply_similarity(scene, al.scale, al.R, al.T)
    if not quiet:
        print(f"[floor] {fit.inliers} floor inliers, camera height {fit.camera_height:.3f} units "
              f"-> scale {al.scale:.4f} m/unit", flush=True)
    if drop_outliers:
        out = drop_outlier_cameras(out, quiet=quiet)
    return out, al, fit
