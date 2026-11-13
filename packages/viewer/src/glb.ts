/**
 * Minimal GLB (binary glTF 2.0) reader and writer for collision meshes.
 *
 * The reader returns world-space triangles from every triangle primitive in the default scene.
 * It supports float positions, 8/16/32-bit indices, interleaved buffers and node TRS/matrix
 * transforms. Compressed meshes (Draco, meshopt) and quantized positions are rejected with a
 * clear error; the pipeline is expected to write plain meshes.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const MODE_TRIANGLES = 4;

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: unknown;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
}
interface GltfNode {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface Gltf {
  asset?: { version?: string };
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: GltfPrimitive[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
}

/** Triangle soup: 9 floats (3 xyz vertices) per triangle, world space. */
export interface TriangleSoup {
  positions: Float32Array;
  triangleCount: number;
}

type Mat4 = Float64Array;

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// Column-major multiply: out = a * b.
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x = qx ?? 0,
    y = qy ?? 0,
    z = qz ?? 0,
    w = qw ?? 1;
  const ax = sx ?? 1,
    ay = sy ?? 1,
    az = sz ?? 1;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * ax;
  m[1] = 2 * (x * y + z * w) * ax;
  m[2] = 2 * (x * z - y * w) * ax;
  m[4] = 2 * (x * y - z * w) * ay;
  m[5] = (1 - 2 * (x * x + z * z)) * ay;
  m[6] = 2 * (y * z + x * w) * ay;
  m[8] = 2 * (x * z + y * w) * az;
  m[9] = 2 * (y * z - x * w) * az;
  m[10] = (1 - 2 * (x * x + y * y)) * az;
  m[12] = tx ?? 0;
  m[13] = ty ?? 0;
  m[14] = tz ?? 0;
  m[15] = 1;
  return m;
}

function viewOf(gltf: Gltf, bin: DataView, accessor: GltfAccessor, elementSize: number) {
  if (accessor.sparse) throw new Error('collision.glb: sparse accessors are not supported');
  if (accessor.bufferView === undefined) throw new Error('collision.glb: accessor has no data');
  const bv = gltf.bufferViews?.[accessor.bufferView];
  if (!bv) throw new Error('collision.glb: missing bufferView');
  if (bv.buffer !== 0) throw new Error('collision.glb: external buffers are not supported');
  const offset = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = bv.byteStride ?? elementSize;
  return { offset: bin.byteOffset + offset, stride };
}

function readPositions(gltf: Gltf, bin: DataView, index: number): Float32Array {
  const acc = gltf.accessors?.[index];
  if (!acc) throw new Error('collision.glb: missing POSITION accessor');
  if (acc.type !== 'VEC3' || acc.componentType !== FLOAT) {
    throw new Error('collision.glb: POSITION must be float VEC3 (no quantization)');
  }
  const { offset, stride } = viewOf(gltf, bin, acc, 12);
  const out = new Float32Array(acc.count * 3);
  const dv = new DataView(bin.buffer);
  for (let i = 0; i < acc.count; i++) {
    const o = offset + i * stride;
    out[i * 3] = dv.getFloat32(o, true);
    out[i * 3 + 1] = dv.getFloat32(o + 4, true);
    out[i * 3 + 2] = dv.getFloat32(o + 8, true);
  }
  return out;
}

function readIndices(gltf: Gltf, bin: DataView, index: number): Uint32Array {
  const acc = gltf.accessors?.[index];
  if (!acc || acc.type !== 'SCALAR') throw new Error('collision.glb: bad indices accessor');
  const size =
    acc.componentType === UNSIGNED_BYTE
      ? 1
      : acc.componentType === UNSIGNED_SHORT
        ? 2
        : acc.componentType === UNSIGNED_INT
          ? 4
          : 0;
  if (!size) throw new Error('collision.glb: unsupported index type');
  const { offset, stride } = viewOf(gltf, bin, acc, size);
  const out = new Uint32Array(acc.count);
  const dv = new DataView(bin.buffer);
  for (let i = 0; i < acc.count; i++) {
    const o = offset + i * stride;
    out[i] =
      size === 1 ? dv.getUint8(o) : size === 2 ? dv.getUint16(o, true) : dv.getUint32(o, true);
  }
  return out;
}

/** Parses a GLB and returns all triangles of the default scene in world space. */
export function parseGlbTriangles(data: ArrayBuffer | Uint8Array): TriangleSoup {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('collision.glb: not a GLB file');
  }
  if (dv.getUint32(4, true) !== 2) throw new Error('collision.glb: only glTF 2.0 is supported');

  let gltf: Gltf | null = null;
  let bin: DataView | null = null;
  let offset = 12;
  const total = Math.min(dv.getUint32(8, true), bytes.byteLength);
  while (offset + 8 <= total) {
    const length = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) {
      gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length))) as Gltf;
    } else if (type === CHUNK_BIN) {
      bin = new DataView(bytes.buffer, bytes.byteOffset + start, length);
    }
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!gltf) throw new Error('collision.glb: missing JSON chunk');
  const unsupported = (gltf.extensionsRequired ?? []).filter((e) => e !== 'KHR_materials_unlit');
  if (unsupported.length) {
    throw new Error(`collision.glb: unsupported required extensions: ${unsupported.join(', ')}`);
  }
  const binView = bin ?? new DataView(new ArrayBuffer(0));
  const json = gltf;

  const chunks: Float32Array[] = [];
  let triangleCount = 0;

  const visit = (nodeIndex: number, parent: Mat4, depth: number) => {
    const node = json.nodes?.[nodeIndex];
    if (!node || depth > 64) return;
    const world = multiply(parent, nodeMatrix(node));
    const mesh = node.mesh === undefined ? undefined : json.meshes?.[node.mesh];
    for (const prim of mesh?.primitives ?? []) {
      if ((prim.mode ?? MODE_TRIANGLES) !== MODE_TRIANGLES) continue;
      const posIndex = prim.attributes['POSITION'];
      if (posIndex === undefined) continue;
      const pos = readPositions(json, binView, posIndex);
      const vertexCount = pos.length / 3;
      const idx =
        prim.indices === undefined
          ? Uint32Array.from({ length: vertexCount }, (_, i) => i)
          : readIndices(json, binView, prim.indices);
      const tris = Math.floor(idx.length / 3);
      const out = new Float32Array(tris * 9);
      for (let i = 0; i < tris * 3; i++) {
        const v = idx[i] ?? 0;
        if (v >= vertexCount) throw new Error('collision.glb: index out of range');
        const x = pos[v * 3] ?? 0,
          y = pos[v * 3 + 1] ?? 0,
          z = pos[v * 3 + 2] ?? 0;
        out[i * 3] =
          (world[0] ?? 0) * x + (world[4] ?? 0) * y + (world[8] ?? 0) * z + (world[12] ?? 0);
        out[i * 3 + 1] =
          (world[1] ?? 0) * x + (world[5] ?? 0) * y + (world[9] ?? 0) * z + (world[13] ?? 0);
        out[i * 3 + 2] =
          (world[2] ?? 0) * x + (world[6] ?? 0) * y + (world[10] ?? 0) * z + (world[14] ?? 0);
      }
      chunks.push(out);
      triangleCount += tris;
    }
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };

  const scene = json.scenes?.[json.scene ?? 0];
  let roots = scene?.nodes;
  if (!roots) {
    // No scene: treat every node that is nobody's child as a root.
    const childSet = new Set((json.nodes ?? []).flatMap((n) => n.children ?? []));
    roots = (json.nodes ?? []).map((_, i) => i).filter((i) => !childSet.has(i));
  }
  for (const root of roots) visit(root, identity(), 0);

  const positions = new Float32Array(triangleCount * 9);
  let o = 0;
  for (const c of chunks) {
    positions.set(c, o);
    o += c.length;
  }
  return { positions, triangleCount };
}

/** Writes an indexed triangle mesh as a single-node GLB (used for fixtures and tests). */
export function writeGlb(positions: Float32Array, indices: Uint32Array): Uint8Array {
  const posBytes = positions.byteLength;
  const idxBytes = indices.byteLength;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3;
    const v = positions[i] ?? 0;
    min[a] = Math.min(min[a] ?? v, v);
    max[a] = Math.max(max[a] ?? v, v);
  }
  const json = {
    asset: { version: '2.0', generator: 'home-tour viewer fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'collision' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: MODE_TRIANGLES }] }],
    buffers: [{ byteLength: posBytes + idxBytes }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: UNSIGNED_INT, count: indices.length, type: 'SCALAR' },
    ],
  };
  const jsonText = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(jsonText.length / 4) * 4;
  const binLen = Math.ceil((posBytes + idxBytes) / 4) * 4;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + jsonLen);
  out.set(jsonText, 20);
  const binStart = 20 + jsonLen;
  dv.setUint32(binStart, binLen, true);
  dv.setUint32(binStart + 4, CHUNK_BIN, true);
  out.set(new Uint8Array(positions.buffer, positions.byteOffset, posBytes), binStart + 8);
  out.set(new Uint8Array(indices.buffer, indices.byteOffset, idxBytes), binStart + 8 + posBytes);
  return out;
}
