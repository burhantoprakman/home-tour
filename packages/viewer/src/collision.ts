/**
 * Collision mesh: a triangle soup with a uniform-grid broadphase, plus the narrow-phase math the
 * capsule controller and the camera need (capsule-vs-triangle contacts, downward and general ray
 * casts).
 * Pure math, no engine imports.
 */
import { parseGlbTriangles, type TriangleSoup } from './glb.ts';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface CollisionMesh {
  /** 9 floats per triangle (world space). */
  positions: Float32Array;
  /** 3 floats per triangle: unit geometric normal (winding order, may face either way). */
  normals: Float32Array;
  triangleCount: number;
  min: Vec3Like;
  cellSize: number;
  dims: [number, number, number];
  /** CSR layout: triangles of cell c are cellTris[cellStart[c] .. cellStart[c + 1]). */
  cellStart: Uint32Array;
  cellTris: Uint32Array;
  /** Scratch for de-duplicating triangles that span several cells during one query. */
  stamp: Uint32Array;
  stampValue: number;
}

const MAX_CELLS_PER_AXIS = 128;

export function buildCollisionMesh(soup: TriangleSoup, cellSize = 0.5): CollisionMesh {
  const { positions, triangleCount } = soup;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0,
      y = positions[i + 1] ?? 0,
      z = positions[i + 2] ?? 0;
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }
  if (triangleCount === 0) {
    min.x = min.y = min.z = 0;
    max.x = max.y = max.z = 0;
  }
  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
  const cell = Math.max(cellSize, extent / MAX_CELLS_PER_AXIS);
  const dims: [number, number, number] = [
    Math.max(1, Math.ceil((max.x - min.x) / cell)),
    Math.max(1, Math.ceil((max.y - min.y) / cell)),
    Math.max(1, Math.ceil((max.z - min.z) / cell)),
  ];
  const cellCount = dims[0] * dims[1] * dims[2];

  const normals = new Float32Array(triangleCount * 3);
  const ranges = new Int32Array(triangleCount * 6);
  const counts = new Uint32Array(cellCount + 1);
  const clampCell = (v: number, axis: 0 | 1 | 2) =>
    Math.min(dims[axis] - 1, Math.max(0, Math.floor(v / cell)));

  for (let t = 0; t < triangleCount; t++) {
    const o = t * 9;
    const ax = positions[o] ?? 0,
      ay = positions[o + 1] ?? 0,
      az = positions[o + 2] ?? 0;
    const bx = positions[o + 3] ?? 0,
      by = positions[o + 4] ?? 0,
      bz = positions[o + 5] ?? 0;
    const cx = positions[o + 6] ?? 0,
      cy = positions[o + 7] ?? 0,
      cz = positions[o + 8] ?? 0;
    const e1x = bx - ax,
      e1y = by - ay,
      e1z = bz - az;
    const e2x = cx - ax,
      e2y = cy - ay,
      e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    normals[t * 3] = nx;
    normals[t * 3 + 1] = ny;
    normals[t * 3 + 2] = nz;

    const r = t * 6;
    ranges[r] = clampCell(Math.min(ax, bx, cx) - min.x, 0);
    ranges[r + 1] = clampCell(Math.min(ay, by, cy) - min.y, 1);
    ranges[r + 2] = clampCell(Math.min(az, bz, cz) - min.z, 2);
    ranges[r + 3] = clampCell(Math.max(ax, bx, cx) - min.x, 0);
    ranges[r + 4] = clampCell(Math.max(ay, by, cy) - min.y, 1);
    ranges[r + 5] = clampCell(Math.max(az, bz, cz) - min.z, 2);
    forEachCell(ranges, r, dims, (c) => {
      counts[c + 1] = (counts[c + 1] ?? 0) + 1;
    });
  }
  for (let c = 0; c < cellCount; c++) counts[c + 1] = (counts[c + 1] ?? 0) + (counts[c] ?? 0);
  const cellStart = counts;
  const cellTris = new Uint32Array(cellStart[cellCount] ?? 0);
  const fill = cellStart.slice(0, cellCount);
  for (let t = 0; t < triangleCount; t++) {
    forEachCell(ranges, t * 6, dims, (c) => {
      const at = fill[c] ?? 0;
      cellTris[at] = t;
      fill[c] = at + 1;
    });
  }

  return {
    positions,
    normals,
    triangleCount,
    min,
    cellSize: cell,
    dims,
    cellStart,
    cellTris,
    stamp: new Uint32Array(triangleCount),
    stampValue: 0,
  };
}

function forEachCell(
  ranges: Int32Array,
  r: number,
  dims: [number, number, number],
  fn: (cell: number) => void,
) {
  const x0 = ranges[r] ?? 0,
    y0 = ranges[r + 1] ?? 0,
    z0 = ranges[r + 2] ?? 0;
  const x1 = ranges[r + 3] ?? 0,
    y1 = ranges[r + 4] ?? 0,
    z1 = ranges[r + 5] ?? 0;
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) fn(x + dims[0] * (y + dims[1] * z));
}

export function loadCollisionMesh(glb: ArrayBuffer | Uint8Array): CollisionMesh {
  return buildCollisionMesh(parseGlbTriangles(glb));
}

/** Calls fn once for each triangle whose grid cells overlap the box. */
export function queryBox(
  mesh: CollisionMesh,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  fn: (tri: number) => void,
): void {
  const { dims, cellSize: s, min } = mesh;
  const x0 = Math.max(0, Math.floor((minX - min.x) / s));
  const y0 = Math.max(0, Math.floor((minY - min.y) / s));
  const z0 = Math.max(0, Math.floor((minZ - min.z) / s));
  const x1 = Math.min(dims[0] - 1, Math.floor((maxX - min.x) / s));
  const y1 = Math.min(dims[1] - 1, Math.floor((maxY - min.y) / s));
  const z1 = Math.min(dims[2] - 1, Math.floor((maxZ - min.z) / s));
  if (x0 > x1 || y0 > y1 || z0 > z1) return;
  mesh.stampValue++;
  if (mesh.stampValue === 0xffffffff) {
    mesh.stamp.fill(0);
    mesh.stampValue = 1;
  }
  const stampValue = mesh.stampValue;
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = x + dims[0] * (y + dims[1] * z);
        const end = mesh.cellStart[c + 1] ?? 0;
        for (let i = mesh.cellStart[c] ?? 0; i < end; i++) {
          const t = mesh.cellTris[i] ?? 0;
          if (mesh.stamp[t] === stampValue) continue;
          mesh.stamp[t] = stampValue;
          fn(t);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Narrow phase. Small mutable vectors avoid per-frame allocations on phones.

export interface Vec3Mut {
  x: number;
  y: number;
  z: number;
}

const v = (): Vec3Mut => ({ x: 0, y: 0, z: 0 });

function triVertex(mesh: CollisionMesh, t: number, k: 0 | 1 | 2, out: Vec3Mut) {
  const o = t * 9 + k * 3;
  out.x = mesh.positions[o] ?? 0;
  out.y = mesh.positions[o + 1] ?? 0;
  out.z = mesh.positions[o + 2] ?? 0;
}

const dot = (a: Vec3Like, b: Vec3Like) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestPointOnTriangle(
  p: Vec3Like,
  a: Vec3Like,
  b: Vec3Like,
  c: Vec3Like,
  out: Vec3Mut,
): Vec3Mut {
  const abx = b.x - a.x,
    aby = b.y - a.y,
    abz = b.z - a.z;
  const acx = c.x - a.x,
    acy = c.y - a.y,
    acz = c.z - a.z;
  const apx = p.x - a.x,
    apy = p.y - a.y,
    apz = p.z - a.z;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(out, a.x, a.y, a.z);
  const bpx = p.x - b.x,
    bpy = p.y - b.y,
    bpz = p.z - b.z;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(out, b.x, b.y, b.z);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return set(out, a.x + abx * t, a.y + aby * t, a.z + abz * t);
  }
  const cpx = p.x - c.x,
    cpy = p.y - c.y,
    cpz = p.z - c.z;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(out, c.x, c.y, c.z);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return set(out, a.x + acx * t, a.y + acy * t, a.z + acz * t);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(out, b.x + (c.x - b.x) * t, b.y + (c.y - b.y) * t, b.z + (c.z - b.z) * t);
  }
  const denom = 1 / (va + vb + vc);
  const sv = vb * denom,
    sw = vc * denom;
  return set(out, a.x + abx * sv + acx * sw, a.y + aby * sv + acy * sw, a.z + abz * sv + acz * sw);
}

function set(out: Vec3Mut, x: number, y: number, z: number): Vec3Mut {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Closest points between segments p1q1 and p2q2 (Ericson 5.1.9). Returns squared distance. */
function closestSegmentSegment(
  p1: Vec3Like,
  q1: Vec3Like,
  p2: Vec3Like,
  q2: Vec3Like,
  c1: Vec3Mut,
  c2: Vec3Mut,
): number {
  const d1x = q1.x - p1.x,
    d1y = q1.y - p1.y,
    d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x,
    d2y = q2.y - p2.y,
    d2z = q2.z - p2.z;
  const rx = p1.x - p2.x,
    ry = p1.y - p2.y,
    rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  set(c1, p1.x + d1x * s, p1.y + d1y * s, p1.z + d1z * s);
  set(c2, p2.x + d2x * t, p2.y + d2y * t, p2.z + d2z * t);
  const dx = c1.x - c2.x,
    dy = c1.y - c2.y,
    dz = c1.z - c2.z;
  return dx * dx + dy * dy + dz * dz;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

const ta = v(),
  tb = v(),
  tc = v(),
  tmpA = v(),
  tmpB = v(),
  tn = v();

/**
 * Closest points between segment pq and triangle t. Writes the segment point to onSeg and the
 * triangle point to onTri, returns the squared distance (0 if the segment crosses the triangle).
 */
export function closestSegmentTriangle(
  mesh: CollisionMesh,
  t: number,
  p: Vec3Like,
  q: Vec3Like,
  onSeg: Vec3Mut,
  onTri: Vec3Mut,
): number {
  triVertex(mesh, t, 0, ta);
  triVertex(mesh, t, 1, tb);
  triVertex(mesh, t, 2, tc);
  set(tn, mesh.normals[t * 3] ?? 0, mesh.normals[t * 3 + 1] ?? 0, mesh.normals[t * 3 + 2] ?? 0);

  // Segment crossing the triangle plane inside the triangle -> distance 0.
  const dp = dot(tn, p) - dot(tn, ta);
  const dq = dot(tn, q) - dot(tn, ta);
  if ((dp <= 0 && dq >= 0) || (dp >= 0 && dq <= 0)) {
    const denom = dp - dq;
    const s = denom !== 0 ? dp / denom : 0;
    set(tmpA, p.x + (q.x - p.x) * s, p.y + (q.y - p.y) * s, p.z + (q.z - p.z) * s);
    closestPointOnTriangle(tmpA, ta, tb, tc, tmpB);
    const dx = tmpA.x - tmpB.x,
      dy = tmpA.y - tmpB.y,
      dz = tmpA.z - tmpB.z;
    if (dx * dx + dy * dy + dz * dz < 1e-10) {
      set(onSeg, tmpA.x, tmpA.y, tmpA.z);
      set(onTri, tmpB.x, tmpB.y, tmpB.z);
      return 0;
    }
  }

  // Otherwise the closest pair involves a segment endpoint vs the face, or the segment vs an edge.
  let best = pointCandidate(p, Infinity, onSeg, onTri);
  best = pointCandidate(q, best, onSeg, onTri);
  best = edgeCandidate(p, q, ta, tb, best, onSeg, onTri);
  best = edgeCandidate(p, q, tb, tc, best, onSeg, onTri);
  best = edgeCandidate(p, q, tc, ta, best, onSeg, onTri);
  return best;
}

function pointCandidate(e: Vec3Like, best: number, onSeg: Vec3Mut, onTri: Vec3Mut): number {
  closestPointOnTriangle(e, ta, tb, tc, tmpB);
  const dx = e.x - tmpB.x,
    dy = e.y - tmpB.y,
    dz = e.z - tmpB.z;
  const d = dx * dx + dy * dy + dz * dz;
  if (d >= best) return best;
  set(onSeg, e.x, e.y, e.z);
  set(onTri, tmpB.x, tmpB.y, tmpB.z);
  return d;
}

function edgeCandidate(
  p: Vec3Like,
  q: Vec3Like,
  e0: Vec3Like,
  e1: Vec3Like,
  best: number,
  onSeg: Vec3Mut,
  onTri: Vec3Mut,
): number {
  const d = closestSegmentSegment(p, q, e0, e1, tmpA, tmpB);
  if (d >= best) return best;
  set(onSeg, tmpA.x, tmpA.y, tmpA.z);
  set(onTri, tmpB.x, tmpB.y, tmpB.z);
  return d;
}

export interface RayHit {
  distance: number;
  triangle: number;
  /** |normal.y| of the hit triangle; 1 = flat floor. */
  upness: number;
}

/**
 * Casts a ray straight down from (x, y, z) for up to maxDistance and returns the nearest hit
 * whose triangle is at least minUpness flat (two-sided), or null.
 */
export function raycastDown(
  mesh: CollisionMesh,
  x: number,
  y: number,
  z: number,
  maxDistance: number,
  minUpness: number,
): RayHit | null {
  let best: RayHit | null = null;
  const pos = mesh.positions;
  queryBox(mesh, x, y - maxDistance, z, x, y, z, (t) => {
    const ny = mesh.normals[t * 3 + 1] ?? 0;
    const upness = Math.abs(ny);
    if (upness < minUpness) return;
    const o = t * 9;
    // 2D point-in-triangle test in XZ, then interpolate height on the plane.
    const ax = pos[o] ?? 0,
      ay = pos[o + 1] ?? 0,
      az = pos[o + 2] ?? 0;
    const bx = pos[o + 3] ?? 0,
      bz = pos[o + 5] ?? 0;
    const cx = pos[o + 6] ?? 0,
      cz = pos[o + 8] ?? 0;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) return;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    const eps = -1e-6;
    if (l1 < eps || l2 < eps || l3 < eps) return;
    const nx = mesh.normals[t * 3] ?? 0,
      nz = mesh.normals[t * 3 + 2] ?? 0;
    // Plane: n . (p - a) = 0  ->  hy = ay - (nx (x - ax) + nz (z - az)) / ny
    const hy = ay - (nx * (x - ax) + nz * (z - az)) / ny;
    const dist = y - hy;
    if (dist < 0 || dist > maxDistance) return;
    if (!best || dist < best.distance) best = { distance: dist, triangle: t, upness };
  });
  return best;
}

/**
 * Casts a ray from (ox, oy, oz) along the unit direction (dx, dy, dz) for up to maxDistance and
 * returns the nearest triangle hit (either side), or null. Walks the grid cells the ray crosses
 * (3D DDA, Amanatides & Woo) and tests their triangles with Moller-Trumbore, stopping at the
 * first cell whose far boundary lies beyond the best hit. A ray lying in a triangle's plane
 * does not hit it; a ray through a shared edge or vertex does.
 */
export function raycast(
  mesh: CollisionMesh,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): RayHit | null {
  const { dims, cellSize: s, min } = mesh;
  // Clip the ray against the grid box.
  const o = [ox - min.x, oy - min.y, oz - min.z] as const;
  const d = [dx, dy, dz] as const;
  let t0 = 0;
  let t1 = maxDistance;
  for (let a = 0; a < 3; a++) {
    const lo = 0;
    const hi = dims[a as 0 | 1 | 2] * s;
    if (Math.abs(d[a] ?? 0) < 1e-12) {
      if ((o[a] ?? 0) < lo || (o[a] ?? 0) > hi) return null;
      continue;
    }
    let ta = (lo - (o[a] ?? 0)) / (d[a] ?? 1);
    let tb = (hi - (o[a] ?? 0)) / (d[a] ?? 1);
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }

  // Starting cell and per-axis stepping.
  const cell = [0, 0, 0];
  const step = [0, 0, 0];
  const tMax = [Infinity, Infinity, Infinity];
  const tDelta = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    const p = (o[a] ?? 0) + (d[a] ?? 0) * t0;
    const n = dims[a as 0 | 1 | 2];
    const c = Math.min(n - 1, Math.max(0, Math.floor(p / s)));
    cell[a] = c;
    const da = d[a] ?? 0;
    if (da > 1e-12) {
      step[a] = 1;
      tMax[a] = ((c + 1) * s - (o[a] ?? 0)) / da;
      tDelta[a] = s / da;
    } else if (da < -1e-12) {
      step[a] = -1;
      tMax[a] = (c * s - (o[a] ?? 0)) / da;
      tDelta[a] = -s / da;
    }
  }

  mesh.stampValue++;
  if (mesh.stampValue === 0xffffffff) {
    mesh.stamp.fill(0);
    mesh.stampValue = 1;
  }
  const stampValue = mesh.stampValue;
  let best: RayHit | null = null;
  let bestT = maxDistance;
  for (;;) {
    const c = (cell[0] ?? 0) + dims[0] * ((cell[1] ?? 0) + dims[1] * (cell[2] ?? 0));
    const end = mesh.cellStart[c + 1] ?? 0;
    for (let i = mesh.cellStart[c] ?? 0; i < end; i++) {
      const t = mesh.cellTris[i] ?? 0;
      if (mesh.stamp[t] === stampValue) continue;
      mesh.stamp[t] = stampValue;
      const hit = rayTriangle(mesh, t, ox, oy, oz, dx, dy, dz);
      if (hit >= 0 && hit <= bestT) {
        bestT = hit;
        best = { distance: hit, triangle: t, upness: Math.abs(mesh.normals[t * 3 + 1] ?? 0) };
      }
    }
    // Advance to the next cell along the axis whose boundary comes first.
    const a =
      (tMax[0] ?? 0) < (tMax[1] ?? 0)
        ? (tMax[0] ?? 0) < (tMax[2] ?? 0)
          ? 0
          : 2
        : (tMax[1] ?? 0) < (tMax[2] ?? 0)
          ? 1
          : 2;
    const next = tMax[a] ?? Infinity;
    // Every triangle that could hit before `next` has been tested (triangles are listed in all
    // the cells they overlap).
    if (next > bestT || next > t1) break;
    cell[a] = (cell[a] ?? 0) + (step[a] ?? 0);
    if ((cell[a] ?? 0) < 0 || (cell[a] ?? 0) >= dims[a as 0 | 1 | 2]) break;
    tMax[a] = next + (tDelta[a] ?? Infinity);
  }
  return best;
}

/** Moller-Trumbore, two-sided. Returns the ray parameter of the hit, or -1. */
function rayTriangle(
  mesh: CollisionMesh,
  t: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const p = mesh.positions;
  const o = t * 9;
  const ax = p[o] ?? 0,
    ay = p[o + 1] ?? 0,
    az = p[o + 2] ?? 0;
  const e1x = (p[o + 3] ?? 0) - ax,
    e1y = (p[o + 4] ?? 0) - ay,
    e1z = (p[o + 5] ?? 0) - az;
  const e2x = (p[o + 6] ?? 0) - ax,
    e2y = (p[o + 7] ?? 0) - ay,
    e2z = (p[o + 8] ?? 0) - az;
  const px = dy * e2z - dz * e2y,
    py = dz * e2x - dx * e2z,
    pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1; // parallel to the triangle's plane
  const inv = 1 / det;
  const sx = ox - ax,
    sy = oy - ay,
    sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  const EPS = 1e-7;
  if (u < -EPS || u > 1 + EPS) return -1;
  const qx = sy * e1z - sz * e1y,
    qy = sz * e1x - sx * e1z,
    qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -EPS || u + v > 1 + EPS) return -1;
  const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return dist >= 0 ? dist : -1;
}
