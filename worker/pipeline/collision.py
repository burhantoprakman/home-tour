"""Stage 5: depth maps -> TSDF -> low-poly collision.glb (floor-levelled metric frame).

Depth rendering lives in train.render_depths (GPU). Everything here is CPU/open3d, so it
runs in the Modal container after training and in local tests on synthetic depth.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import open3d as o3d

VOXEL_M = 0.03
SDF_TRUNC_M = 0.12
DEPTH_MAX_M = 6.0
TARGET_TRIANGLES = 20_000
MIN_COMPONENT_FRACTION = 0.01
# The camera-derived top of the room box never goes above this: a stray camera registered
# 12 m up made 13 m walls (job 9acd3d47). Taller rooms still get their sparse points' height.
MAX_CAMERA_TOP_M = 3.5
# Free-space carving (levelled metric frame). Whoever filmed walked the camera path, so a
# body-sized column around it is empty: floaters there (MCMC haze in front of the cameras,
# worst where poses are off) fuse into walls that trap the avatar at spawn (job 9acd3d47:
# 10x more Gaussians within 0.3 m of the path than newsalon2, and the whole centre blocked).
CARVE_RADIUS_M = 0.35  # around the camera (phone in hand ~ body)
CARVE_OFF_PATH_RADIUS_M = 0.2  # around cameras off the longest unbroken piece of the path
CARVE_JUMP_M = 0.8  # consecutive cameras further apart than this: the path is broken there
CARVE_MIN_Y_M = 0.10  # keep the floor and rugs
CARVE_TOP_M = 1.8  # up to head height
CARVE_CAMERA_Y_M = (1.0, 2.0)  # only cameras at a standing hand-held height (crouched shots can
# be held out over furniture; cameras far above it are mis-registered)
CARVE_MAX_STEP_M = 0.6  # also carve between consecutive cameras closer than this (no teleports)
CARVE_CELL_M = 0.05


@dataclass(frozen=True)
class CollisionStats:
    raw_triangles: int
    triangles: int
    vertices: int
    bounds_min: tuple[float, float, float]
    bounds_max: tuple[float, float, float]
    carved_triangles: int = 0  # removed from the camera path's free space


def fuse_tsdf(depths: list[np.ndarray], Ks: np.ndarray, w2cs: np.ndarray, *,
              voxel: float = VOXEL_M, trunc: float = SDF_TRUNC_M,
              depth_max: float = DEPTH_MAX_M) -> o3d.geometry.TriangleMesh:
    vol = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel, sdf_trunc=trunc,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.NoColor,
    )
    for depth, K, M in zip(depths, Ks, w2cs):
        h, w = depth.shape
        rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
            o3d.geometry.Image(np.zeros((h, w, 3), dtype=np.uint8)),
            o3d.geometry.Image(np.ascontiguousarray(depth, dtype=np.float32)),
            depth_scale=1.0, depth_trunc=depth_max, convert_rgb_to_intensity=False,
        )
        intr = o3d.camera.PinholeCameraIntrinsic(w, h, K[0, 0], K[1, 1], K[0, 2], K[1, 2])
        vol.integrate(rgbd, intr, np.asarray(M, dtype=np.float64))
    return vol.extract_triangle_mesh()


def path_pieces(cam_centres: np.ndarray, jump: float = CARVE_JUMP_M) -> list[np.ndarray]:
    """Indices of the time-ordered camera path, split wherever it teleports."""
    c = np.asarray(cam_centres, dtype=np.float64).reshape(-1, 3)
    if len(c) == 0:
        return []
    cuts = np.nonzero(np.linalg.norm(np.diff(c, axis=0), axis=1) > jump)[0] + 1
    return np.split(np.arange(len(c)), cuts)


def walked_columns(cam_centres: np.ndarray, *, radius: float = CARVE_RADIUS_M,
                   off_path_radius: float = CARVE_OFF_PATH_RADIUS_M,
                   camera_y: tuple[float, float] = CARVE_CAMERA_Y_M, max_step: float = CARVE_MAX_STEP_M,
                   cell: float = CARVE_CELL_M) -> tuple[np.ndarray, np.ndarray] | None:
    """Top-down grid of the space the person walked through: (mask (I, J), origin (2,) x/z).

    cam_centres in time order. A cell is marked within `radius` of a trusted camera (standing
    height, on the longest unbroken piece of the path) or of the straight step between two
    consecutive ones. Cameras on the other pieces may be placed up to ~1 m off (the solve broke
    the path there), so they only get `off_path_radius`: enough to clear the haze right in
    front of them without eating the couch next to them."""
    c = np.asarray(cam_centres, dtype=np.float64).reshape(-1, 3)
    ok = (c[:, 1] >= camera_y[0]) & (c[:, 1] <= camera_y[1])
    if not np.any(ok):
        return None
    pieces = path_pieces(c)
    main = max(pieces, key=len)
    r_cam = np.full(len(c), off_path_radius)
    r_cam[main] = radius
    xz, rr = [c[ok][:, [0, 2]]], [r_cam[ok]]
    for i in range(len(c) - 1):
        a, b = c[i], c[i + 1]
        step = float(np.linalg.norm((b - a)[[0, 2]]))
        if ok[i] and ok[i + 1] and 0 < step <= max_step:
            t = np.linspace(0, 1, int(np.ceil(step / cell)) + 1)[:, None]
            xz.append(a[[0, 2]] + t * (b - a)[[0, 2]])
            rr.append(np.full(len(t), min(r_cam[i], r_cam[i + 1])))
    pts, rad = np.vstack(xz), np.concatenate(rr)
    rmax = float(rad.max())
    origin = pts.min(axis=0) - rmax - cell
    shape = tuple(np.ceil((pts.max(axis=0) + rmax + cell - origin) / cell).astype(int) + 1)
    mask = np.zeros(shape, dtype=bool)
    for r in np.unique(rad):
        n = int(np.ceil(r / cell))
        di, dj = np.mgrid[-n:n + 1, -n:n + 1]
        disk = (di * di + dj * dj) * cell * cell <= r * r
        ij = np.unique(np.round((pts[rad == r] - origin) / cell).astype(int), axis=0)
        for a, b in zip(di[disk], dj[disk]):
            mask[ij[:, 0] + a, ij[:, 1] + b] = True
    return mask, origin


def in_walked_space(points: np.ndarray, columns: tuple[np.ndarray, np.ndarray] | None, *,
                    min_y: float = CARVE_MIN_Y_M, top: float = CARVE_TOP_M,
                    cell: float = CARVE_CELL_M) -> np.ndarray:
    """Mask of points inside the walked columns, between min_y and top."""
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    if columns is None:
        return np.zeros(len(p), dtype=bool)
    mask, origin = columns
    ij = np.round((p[:, [0, 2]] - origin) / cell).astype(int)
    inside = np.all((ij >= 0) & (ij < np.array(mask.shape)), axis=1)
    hit = np.zeros(len(p), dtype=bool)
    hit[inside] = mask[ij[inside, 0], ij[inside, 1]]
    return hit & (p[:, 1] > min_y) & (p[:, 1] < top)


def carve_walked_space(mesh: o3d.geometry.TriangleMesh, cam_centres: np.ndarray,
                       sample_m: float = 0.05) -> tuple[o3d.geometry.TriangleMesh, int]:
    """Remove every triangle that reaches into the space the person walked through
    (see walked_columns). Returns (mesh, triangles removed)."""
    cols = walked_columns(cam_centres)
    t = np.asarray(mesh.triangles)
    if cols is None or len(t) == 0:
        return mesh, 0
    tri = np.asarray(mesh.vertices)[t]
    hit = in_walked_space(tri.mean(axis=1), cols)
    # Barycentric grid per triangle, ~sample_m apart, grouped by subdivision count.
    edge = np.max(np.linalg.norm(tri - np.roll(tri, 1, axis=1), axis=2), axis=1)
    steps = np.clip(np.ceil(edge / sample_m).astype(int), 1, 200)
    for k in np.unique(steps):
        idx = np.nonzero(steps == k)[0]
        ij = np.array([(i, j) for i in range(k + 1) for j in range(k + 1 - i)], dtype=np.float64) / k
        w = np.c_[1 - ij.sum(axis=1), ij]  # (S, 3)
        pts = np.einsum("sk,tkd->tsd", w, tri[idx]).reshape(-1, 3)
        hit[idx] |= in_walked_space(pts, cols).reshape(len(idx), len(w)).any(axis=1)
    out = o3d.geometry.TriangleMesh(mesh)
    out.remove_triangles_by_mask(hit)
    out.remove_unreferenced_vertices()
    return out, int(hit.sum())


def simplify(mesh: o3d.geometry.TriangleMesh, target_triangles: int = TARGET_TRIANGLES,
             min_component_fraction: float = MIN_COMPONENT_FRACTION) -> o3d.geometry.TriangleMesh:
    mesh = mesh.remove_duplicated_vertices()
    n = len(mesh.triangles)
    if n == 0:
        return mesh
    # Drop floaters: connected pieces smaller than a fraction of the mesh.
    labels, counts, _ = mesh.cluster_connected_triangles()
    labels = np.asarray(labels)
    counts = np.asarray(counts)
    small = counts[labels] < max(1, int(min_component_fraction * n))
    mesh.remove_triangles_by_mask(small)
    mesh.remove_unreferenced_vertices()
    if len(mesh.triangles) > target_triangles:
        mesh = mesh.simplify_quadric_decimation(target_number_of_triangles=target_triangles)
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_unreferenced_vertices()
    mesh.compute_vertex_normals()
    return mesh


def write_glb(path: Path, positions: np.ndarray, indices: np.ndarray, normals: np.ndarray | None = None) -> None:
    """Minimal glTF 2.0 binary: one mesh, one primitive, data in the GLB BIN chunk.

    (Open3D 0.19's own .glb writer emits a base64 data-URI buffer and wrong index min/max,
    which its own Assimp reader rejects, so we don't use it.)
    """
    pos = np.ascontiguousarray(positions, dtype="<f4").reshape(-1, 3)
    idx = np.ascontiguousarray(indices, dtype="<u4").reshape(-1)
    parts = [idx.tobytes(), pos.tobytes()]
    if normals is not None:
        parts.append(np.ascontiguousarray(normals, dtype="<f4").reshape(-1, 3).tobytes())
    views, offset, blob = [], 0, b""
    for i, data in enumerate(parts):
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data),
                      "target": 34963 if i == 0 else 34962})
        pad = (-len(data)) % 4
        blob += data + b"\0" * pad
        offset += len(data) + pad
    accessors = [
        {"bufferView": 0, "componentType": 5125, "count": int(idx.size), "type": "SCALAR",
         "min": [int(idx.min())], "max": [int(idx.max())]},
        {"bufferView": 1, "componentType": 5126, "count": int(len(pos)), "type": "VEC3",
         "min": pos.min(axis=0).tolist(), "max": pos.max(axis=0).tolist()},
    ]
    attrs = {"POSITION": 1}
    if normals is not None:
        accessors.append({"bufferView": 2, "componentType": 5126, "count": int(len(pos)), "type": "VEC3"})
        attrs["NORMAL"] = 2
    gltf = {
        "asset": {"version": "2.0", "generator": "home-tour worker"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "collision"}],
        "meshes": [{"name": "collision", "primitives": [{"attributes": attrs, "indices": 0, "mode": 4}]}],
        "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accessors,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with Path(path).open("wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(blob), b"BIN\0") + blob)


def export_glb(mesh: o3d.geometry.TriangleMesh, path: Path) -> None:
    normals = np.asarray(mesh.vertex_normals) if mesh.has_vertex_normals() else None
    write_glb(path, np.asarray(mesh.vertices), np.asarray(mesh.triangles), normals)


def crop_box_from_points(points: np.ndarray, cam_centres: np.ndarray | None = None, margin: float = 0.5,
                         floor_margin: float = 0.2, above_cameras: float = 1.2,
                         max_camera_top: float = MAX_CAMERA_TOP_M) -> tuple[np.ndarray, np.ndarray]:
    """Robust room box: 1st-99th percentile of sparse points + margin, floor at y=0.

    The top is at least `above_cameras` over the highest camera (capped at max_camera_top):
    sparse points cluster on textured floors/furniture, so their percentile alone would slice
    the walls off.
    """
    lo = np.percentile(points, 1, axis=0) - margin
    hi = np.percentile(points, 99, axis=0) + margin
    lo[1] = -floor_margin
    if cam_centres is not None and len(cam_centres):
        hi[1] = max(hi[1], min(float(np.max(cam_centres[:, 1])) + above_cameras, max_camera_top))
        # The person stood everywhere the camera went: the box (and its closing walls) must
        # leave room around the path. giriskoridor started at the front door with few points
        # behind it, so a box wall crossed the path and the player spawned stuck.
        c = np.asarray(cam_centres, dtype=np.float64)
        for ax in (0, 2):
            lo[ax] = min(lo[ax], float(c[:, ax].min()) - margin)
            hi[ax] = max(hi[ax], float(c[:, ax].max()) + margin)
    return lo, hi


def convex_hull_2d(xy: np.ndarray) -> np.ndarray:
    """Counter-clockwise hull (Andrew's monotone chain), shape (H, 2)."""
    pts = np.unique(np.asarray(xy, dtype=np.float64), axis=0)
    if len(pts) < 3:
        return pts

    def cross(o: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
        return float((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]))

    def half(points: np.ndarray) -> list[np.ndarray]:
        out: list[np.ndarray] = []
        for q in points:
            while len(out) >= 2 and cross(out[-2], out[-1], q) <= 0:
                out.pop()
            out.append(q)
        return out

    lower, upper = half(pts), half(pts[::-1])
    return np.array(lower[:-1] + upper[:-1])


def add_floor(mesh: o3d.geometry.TriangleMesh, floor_xz: np.ndarray, y: float = 0.0) -> o3d.geometry.TriangleMesh:
    """Append a flat, up-facing floor polygon (convex hull of floor_xz) at height y.

    Walk-around captures barely see the floor under the camera path, so the fused mesh has
    a hole exactly where people walk; the levelled floor plane is known, so we fill it.
    """
    hull = convex_hull_2d(floor_xz)
    if len(hull) < 3:
        return mesh
    base = len(mesh.vertices)
    verts = np.c_[hull[:, 0], np.full(len(hull), y), hull[:, 1]]
    tris = np.array([[base, base + i, base + i + 1] for i in range(1, len(hull) - 1)])
    # Hull is convex, so every fan triangle has the same winding as the first; make it face +Y.
    a, b, c = verts[0], verts[1], verts[2]
    if np.cross(b - a, c - a)[1] < 0:
        tris = tris[:, [0, 2, 1]]
    out = o3d.geometry.TriangleMesh(mesh)
    out.vertices = o3d.utility.Vector3dVector(np.vstack([np.asarray(mesh.vertices), verts]))
    out.triangles = o3d.utility.Vector3iVector(np.vstack([np.asarray(mesh.triangles), tris]).astype(np.int32))
    out.compute_vertex_normals()
    return out


def add_box_walls(mesh: o3d.geometry.TriangleMesh, lo: np.ndarray, hi: np.ndarray) -> o3d.geometry.TriangleMesh:
    """Append four inward-facing walls on the box's x/z edges, from y=0 to the box top.

    TSDF walls have gaps (plain walls, doorways, glass); without these the capsule walks
    through a gap, off the edge of the floor fill, and falls.
    """
    x0, z0, x1, z1, top = float(lo[0]), float(lo[2]), float(hi[0]), float(hi[2]), float(hi[1])
    corners = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
    centre = np.array([(x0 + x1) / 2, top / 2, (z0 + z1) / 2])
    verts, tris = [], []
    base = len(mesh.vertices)
    for k in range(4):
        (ax, az), (bx, bz) = corners[k], corners[(k + 1) % 4]
        q = np.array([[ax, 0.0, az], [bx, 0.0, bz], [bx, top, bz], [ax, top, az]])
        i = base + 4 * k
        quad = [[i, i + 1, i + 2], [i, i + 2, i + 3]]
        n = np.cross(q[1] - q[0], q[2] - q[0])
        if np.dot(n, centre - q[0]) < 0:  # face into the room
            quad = [[a, c, b] for a, b, c in quad]
        verts.append(q)
        tris += quad
    out = o3d.geometry.TriangleMesh(mesh)
    out.vertices = o3d.utility.Vector3dVector(np.vstack([np.asarray(mesh.vertices), *verts]))
    out.triangles = o3d.utility.Vector3iVector(np.vstack([np.asarray(mesh.triangles), tris]).astype(np.int32))
    out.compute_vertex_normals()
    return out


def crop(mesh: o3d.geometry.TriangleMesh, lo: np.ndarray, hi: np.ndarray) -> o3d.geometry.TriangleMesh:
    box = o3d.geometry.AxisAlignedBoundingBox(np.asarray(lo, dtype=np.float64), np.asarray(hi, dtype=np.float64))
    return mesh.crop(box)


def build_collision(depths: list[np.ndarray], Ks: np.ndarray, w2cs: np.ndarray, out_path: Path,
                    target_triangles: int = TARGET_TRIANGLES,
                    box: tuple[np.ndarray, np.ndarray] | None = None,
                    cam_centres: np.ndarray | None = None) -> CollisionStats:
    """box: optional (lo, hi) crop, e.g. crop_box_from_points(scene.points, cams).
    cam_centres (in time order): if given, triangles in the space the person walked through
    are carved away (carve_walked_space) and a floor polygon at y=0 is added (frame is
    floor-levelled, so the floor is y=0). With a box it covers the box's x/z extent so the floor reaches the walls,
    and the box's sides are closed with walls so gaps can't lead off the floor; without one, the convex hull of the camera path and the low parts of the mesh."""
    raw = fuse_tsdf(depths, Ks, w2cs)
    raw_n = len(raw.triangles)
    if raw_n == 0:
        raise RuntimeError("TSDF fusion produced an empty mesh")
    if box is not None:
        raw = crop(raw, *box)
        if len(raw.triangles) == 0:
            raise RuntimeError("collision mesh is empty after cropping to the room box")
    carved = 0
    if cam_centres is not None:
        raw, carved = carve_walked_space(raw, cam_centres)
        if len(raw.triangles) == 0:
            raise RuntimeError("collision mesh is empty after carving the camera path")
    mesh = simplify(raw, target_triangles)
    if cam_centres is not None:
        # Decimation moves vertices, so a few merged triangles stretch back into the walked
        # space (giriskoridor: 30 of them blocked 35% of a narrow corridor). Carve again.
        mesh, recarved = carve_walked_space(mesh, cam_centres)
        carved += recarved
        mesh = close_room(mesh, cam_centres, box)
    export_glb(mesh, out_path)
    v = np.asarray(mesh.vertices)
    return CollisionStats(raw_n, len(mesh.triangles), len(v),
                          tuple(v.min(axis=0).round(3).tolist()), tuple(v.max(axis=0).round(3).tolist()), carved)


def close_room(mesh: o3d.geometry.TriangleMesh, cam_centres: np.ndarray,
               box: tuple[np.ndarray, np.ndarray] | None) -> o3d.geometry.TriangleMesh:
    """Add the y=0 floor (box extent, else hull of low geometry + cameras) and the box walls."""
    if box is not None:
        (x0, _, z0), (x1, _, z1) = box
        floor_xz = np.array([[x0, z0], [x1, z0], [x1, z1], [x0, z1]])
    else:
        v = np.asarray(mesh.vertices)
        floor_xz = np.vstack([v[v[:, 1] < 0.3][:, [0, 2]], np.asarray(cam_centres)[:, [0, 2]]])
    mesh = add_floor(mesh, floor_xz, 0.0)
    if box is not None:
        mesh = add_box_walls(mesh, *box)
    return mesh


def strip_room_closure(mesh: o3d.geometry.TriangleMesh, box: tuple[np.ndarray, np.ndarray],
                       eps: float = 1e-4) -> o3d.geometry.TriangleMesh:
    """Undo close_room on a published collision mesh: drop triangles lying exactly on y=0 or
    on the box's side planes (TSDF triangles never do)."""
    lo, hi = box
    tri = np.asarray(mesh.vertices)[np.asarray(mesh.triangles)]
    added = np.all(np.abs(tri[:, :, 1]) < eps, axis=1)
    for ax, val in ((0, lo[0]), (0, hi[0]), (2, lo[2]), (2, hi[2])):
        added |= np.all(np.abs(tri[:, :, ax] - val) < eps, axis=1)
    out = o3d.geometry.TriangleMesh(mesh)
    out.remove_triangles_by_mask(added)
    out.remove_unreferenced_vertices()
    return out


def recarve_collision(glb_in: Path, glb_out: Path, cam_centres: np.ndarray,
                      box: tuple[np.ndarray, np.ndarray]) -> CollisionStats:
    """Apply the camera-path carving to an already published collision.glb (CPU only, no
    depth maps needed): strip floor/walls, carve, drop the now-small pieces, close again."""
    m = o3d.io.read_triangle_mesh(str(glb_in))
    n0 = len(m.triangles)
    core, carved = carve_walked_space(strip_room_closure(m, box), cam_centres)
    mesh = close_room(simplify(core), cam_centres, box)
    export_glb(mesh, glb_out)
    v = np.asarray(mesh.vertices)
    return CollisionStats(n0, len(mesh.triangles), len(v),
                          tuple(v.min(axis=0).round(3).tolist()), tuple(v.max(axis=0).round(3).tolist()), carved)


def mesh_bounds(glb: Path) -> tuple[list[float], list[float]]:
    """(min, max) of a mesh file's vertices, e.g. collision.glb for compress()'s room box."""
    v = np.asarray(o3d.io.read_triangle_mesh(str(glb)).vertices)
    return v.min(axis=0).tolist(), v.max(axis=0).tolist()
