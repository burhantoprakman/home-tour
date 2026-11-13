/**
 * Quadric-error (Garland-Heckbert) mesh simplifier for the avatar build, half-edge collapse only:
 * a vertex is always merged into one of its neighbours and the survivor keeps its own attributes
 * (UVs, normals, skin weights), so nothing has to be interpolated.
 *
 * Vertices that share a position with another vertex (UV / normal seams) and vertices on
 * non-manifold edges are locked; open-border vertices may only slide along their border. That
 * keeps texture seams and hems intact at the cost of some reduction headroom.
 */

export interface DecimateResult {
  indices: Uint32Array;
  /** Triangles left. */
  triangles: number;
}

// Vertex kinds.
const INTERIOR = 0;
const BORDER = 1;
const LOCKED = 2;

/** Max cosine drop allowed between a triangle's normal before and after a collapse. */
const MIN_NORMAL_DOT = 0.3;
const BORDER_WEIGHT = 10;

/**
 * Simplifies an indexed triangle list down to at most `target` triangles (or as far as the
 * locked seams allow). `positions` holds 3 floats per vertex.
 */
export function decimate(
  positions: Float32Array,
  input: Uint32Array,
  target: number,
): DecimateResult {
  const vertexCount = positions.length / 3;
  const tris = Array.from(input);
  let triCount = tris.length / 3;
  const alive = new Uint8Array(triCount).fill(1);
  const px = (v: number) => positions[v * 3] ?? 0;
  const py = (v: number) => positions[v * 3 + 1] ?? 0;
  const pz = (v: number) => positions[v * 3 + 2] ?? 0;

  // --- Classification ---------------------------------------------------------------------
  const posKey = (v: number) =>
    `${Math.round(px(v) * 1e5)},${Math.round(py(v) * 1e5)},${Math.round(pz(v) * 1e5)}`;
  const byPos = new Map<string, number>();
  const sharedPos = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const k = posKey(v);
    const other = byPos.get(k);
    if (other === undefined) byPos.set(k, v);
    else sharedPos[v] = sharedPos[other] = 1;
  }

  const edgeKey = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);
  const edgeUse = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t * 3 + k] ?? 0;
      const b = tris[t * 3 + ((k + 1) % 3)] ?? 0;
      const key = edgeKey(a, b);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const kind = new Uint8Array(vertexCount);
  const borderEdges = new Uint8Array(vertexCount);
  for (const [key, uses] of edgeUse) {
    const a = Math.floor(key / vertexCount);
    const b = key % vertexCount;
    if (uses > 2) kind[a] = kind[b] = LOCKED;
    else if (uses === 1) {
      borderEdges[a] = (borderEdges[a] ?? 0) + 1;
      borderEdges[b] = (borderEdges[b] ?? 0) + 1;
    }
  }
  for (let v = 0; v < vertexCount; v++) {
    if (sharedPos[v] || kind[v] === LOCKED) kind[v] = LOCKED;
    else if (borderEdges[v] === 2) kind[v] = BORDER;
    else if ((borderEdges[v] ?? 0) > 0)
      kind[v] = LOCKED; // border corner / bow-tie
    else kind[v] = INTERIOR;
  }
  const isBorderEdge = (a: number, b: number) => edgeUse.get(edgeKey(a, b)) === 1;

  // --- Quadrics (10 floats each: a2 ab ac ad b2 bc bd c2 cd d2) -------------------------------
  const Q = new Float64Array(vertexCount * 10);
  const addPlane = (v: number, a: number, b: number, c: number, d: number, w: number) => {
    const o = v * 10;
    const q = [a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d];
    for (let i = 0; i < 10; i++) Q[o + i] = (Q[o + i] ?? 0) + (q[i] ?? 0) * w;
  };
  const normal = (a: number, b: number, c: number): [number, number, number, number] => {
    const ux = px(b) - px(a),
      uy = py(b) - py(a),
      uz = pz(b) - pz(a);
    const vx = px(c) - px(a),
      vy = py(c) - py(a),
      vz = pz(c) - pz(a);
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    return len > 0 ? [nx / len, ny / len, nz / len, len / 2] : [0, 0, 0, 0];
  };
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3] ?? 0,
      b = tris[t * 3 + 1] ?? 0,
      c = tris[t * 3 + 2] ?? 0;
    const [nx, ny, nz, area] = normal(a, b, c);
    if (area === 0) continue;
    const d = -(nx * px(a) + ny * py(a) + nz * pz(a));
    for (const v of [a, b, c]) addPlane(v, nx, ny, nz, d, area);
    // Border edges: a plane through the edge, perpendicular to the face, keeps the outline.
    for (let k = 0; k < 3; k++) {
      const e0 = tris[t * 3 + k] ?? 0;
      const e1 = tris[t * 3 + ((k + 1) % 3)] ?? 0;
      if (!isBorderEdge(e0, e1)) continue;
      const ex = px(e1) - px(e0),
        ey = py(e1) - py(e0),
        ez = pz(e1) - pz(e0);
      let bx = ey * nz - ez * ny,
        by = ez * nx - ex * nz,
        bz = ex * ny - ey * nx;
      const bl = Math.hypot(bx, by, bz);
      if (bl === 0) continue;
      bx /= bl;
      by /= bl;
      bz /= bl;
      const bd = -(bx * px(e0) + by * py(e0) + bz * pz(e0));
      const w = BORDER_WEIGHT * Math.hypot(ex, ey, ez) ** 2;
      addPlane(e0, bx, by, bz, bd, w);
      addPlane(e1, bx, by, bz, bd, w);
    }
  }
  const error = (v: number, x: number, y: number, z: number) => {
    const o = v * 10;
    const q = (i: number) => Q[o + i] ?? 0;
    return Math.abs(
      q(0) * x * x +
        2 * q(1) * x * y +
        2 * q(2) * x * z +
        2 * q(3) * x +
        q(4) * y * y +
        2 * q(5) * y * z +
        2 * q(6) * y +
        q(7) * z * z +
        2 * q(8) * z +
        q(9),
    );
  };

  // --- Adjacency --------------------------------------------------------------------------
  const vtris: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let t = 0; t < triCount; t++)
    for (let k = 0; k < 3; k++) vtris[tris[t * 3 + k] ?? 0]?.push(t);
  const neighbours = (v: number) => {
    const out = new Set<number>();
    for (const t of vtris[v] ?? [])
      for (let k = 0; k < 3; k++) {
        const u = tris[t * 3 + k] ?? 0;
        if (u !== v) out.add(u);
      }
    return out;
  };

  // --- Collapse queue (binary min-heap, lazily invalidated) ----------------------------------
  const version = new Uint32Array(vertexCount);
  const heap: { cost: number; from: number; to: number; ver: number }[] = [];
  const push = (e: { cost: number; from: number; to: number; ver: number }) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heap[p]?.cost ?? 0) <= e.cost) break;
      heap[i] = heap[p] as typeof e;
      i = p;
    }
    heap[i] = e;
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        let mc = last.cost;
        if (l < heap.length && (heap[l]?.cost ?? 0) < mc) {
          m = l;
          mc = heap[l]?.cost ?? 0;
        }
        if (r < heap.length && (heap[r]?.cost ?? 0) < mc) m = r;
        if (m === i) break;
        heap[i] = heap[m] as typeof last;
        i = m;
      }
      heap[i] = last;
    }
    return top;
  };
  const canMove = (from: number, to: number) => {
    const k = kind[from];
    if (k === LOCKED) return false;
    if (k === BORDER) return isBorderEdge(from, to);
    return true;
  };
  const queue = (v: number) => {
    if (kind[v] === LOCKED) return;
    for (const u of neighbours(v)) {
      if (!canMove(v, u)) continue;
      push({ cost: error(v, px(u), py(u), pz(u)), from: v, to: u, ver: version[v] ?? 0 });
    }
  };
  for (let v = 0; v < vertexCount; v++) queue(v);

  const valid = (from: number, to: number) => {
    // Link condition: the two vertices may only share the opposite corners of their shared
    // triangles, otherwise the collapse pinches the surface.
    const shared = (vtris[from] ?? []).filter((t) => triHas(tris, t, to)).length;
    if (shared === 0) return false;
    const nf = neighbours(from);
    let common = 0;
    for (const u of neighbours(to)) if (nf.has(u)) common++;
    if (common !== shared) return false;
    // No triangle may flip or degenerate.
    for (const t of vtris[from] ?? []) {
      if (triHas(tris, t, to)) continue;
      const a = tris[t * 3] ?? 0,
        b = tris[t * 3 + 1] ?? 0,
        c = tris[t * 3 + 2] ?? 0;
      const before = normal(a, b, c);
      const after = normal(a === from ? to : a, b === from ? to : b, c === from ? to : c);
      if (after[3] < 1e-12) return false;
      if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] < MIN_NORMAL_DOT)
        return false;
    }
    return true;
  };

  while (triCount > target && heap.length) {
    const e = pop();
    if (!e || e.ver !== version[e.from] || !vtris[e.from]?.length || !vtris[e.to]?.length) continue;
    if (!canMove(e.from, e.to) || !valid(e.from, e.to)) continue;
    const { from, to } = e;
    for (const t of vtris[from] ?? []) {
      if (triHas(tris, t, to)) {
        alive[t] = 0;
        triCount--;
        for (let k = 0; k < 3; k++) {
          const u = tris[t * 3 + k] ?? 0;
          if (u !== from) vtris[u] = (vtris[u] ?? []).filter((x) => x !== t);
        }
      } else {
        for (let k = 0; k < 3; k++) if (tris[t * 3 + k] === from) tris[t * 3 + k] = to;
        vtris[to]?.push(t);
      }
    }
    vtris[from] = [];
    for (let i = 0; i < 10; i++) Q[to * 10 + i] = (Q[to * 10 + i] ?? 0) + (Q[from * 10 + i] ?? 0);
    version[to] = (version[to] ?? 0) + 1;
    queue(to);
    for (const u of neighbours(to)) {
      version[u] = (version[u] ?? 0) + 1;
      queue(u);
    }
  }

  const out: number[] = [];
  for (let t = 0; t < alive.length; t++)
    if (alive[t]) out.push(tris[t * 3] ?? 0, tris[t * 3 + 1] ?? 0, tris[t * 3 + 2] ?? 0);
  return { indices: Uint32Array.from(out), triangles: out.length / 3 };
}

function triHas(tris: number[], t: number, v: number): boolean {
  return tris[t * 3] === v || tris[t * 3 + 1] === v || tris[t * 3 + 2] === v;
}
