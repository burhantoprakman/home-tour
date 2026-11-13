/**
 * Just enough glTF 2.0 for the avatar build: read .gltf (+ .bin) or .glb, read accessors as
 * floats, and write a single-buffer GLB from parts. Not a general-purpose library.
 */
import { readFileSync } from 'node:fs';

export interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
}
export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
export interface GltfAnimation {
  name?: string;
  channels: { sampler: number; target: { node: number; path: string } }[];
  samplers: { input: number; output: number; interpolation?: string }[];
}
export interface GltfJson {
  nodes: GltfNode[];
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  materials?: {
    name?: string;
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number } };
  }[];
  textures?: { source: number }[];
  images?: { uri?: string }[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  accessors: GltfAccessor[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers: { uri?: string; byteLength: number }[];
  animations?: GltfAnimation[];
}

export interface Gltf {
  json: GltfJson;
  bin: Uint8Array;
  /** Directory of the file, for image uris. */
  dir: string;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGltf(path: string): Gltf {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const bytes = readFileSync(path);
  if (path.endsWith('.glb')) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
    const binLen = dv.getUint32(20 + jsonLen, true);
    const bin = bytes.subarray(28 + jsonLen, 28 + jsonLen + binLen);
    return { json: json as GltfJson, bin, dir };
  }
  const json = JSON.parse(new TextDecoder().decode(bytes)) as GltfJson;
  const uri = json.buffers[0]?.uri;
  if (!uri) throw new Error(`${path}: no buffer uri`);
  return { json, bin: readFileSync(`${dir}/${decodeURIComponent(uri)}`), dir };
}

/** Reads an accessor as floats (normalized integers are mapped to 0..1). */
export function readAccessor(g: Gltf, index: number): { data: Float32Array; n: number } {
  const acc = g.json.accessors[index];
  if (!acc || acc.bufferView === undefined) throw new Error(`bad accessor ${index}`);
  const bv = g.json.bufferViews[acc.bufferView];
  if (!bv) throw new Error(`bad bufferView ${acc.bufferView}`);
  const n = COMPONENTS[acc.type] ?? 1;
  const size =
    acc.componentType === 5126 || acc.componentType === 5125
      ? 4
      : acc.componentType === 5123
        ? 2
        : 1;
  const stride = bv.byteStride ?? size * n;
  const base = g.bin.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(g.bin.buffer);
  const out = new Float32Array(acc.count * n);
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < n; k++) {
      const o = base + i * stride + k * size;
      let v: number;
      if (acc.componentType === 5126) v = dv.getFloat32(o, true);
      else if (acc.componentType === 5125) v = dv.getUint32(o, true);
      else if (acc.componentType === 5123) v = dv.getUint16(o, true) / (acc.normalized ? 65535 : 1);
      else v = dv.getUint8(o) / (acc.normalized ? 255 : 1);
      out[i * n + k] = v;
    }
  }
  return { data: out, n };
}

// --- Column-major 4x4 matrices -----------------------------------------------------------------

export type Mat4 = Float64Array;

export function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  return out;
}

/** General 4x4 inverse (cofactor expansion). */
export function invert(m: Mat4): Mat4 {
  const a = (i: number) => m[i] ?? 0;
  const inv = new Float64Array(16);
  inv[0] =
    a(5) * a(10) * a(15) -
    a(5) * a(11) * a(14) -
    a(9) * a(6) * a(15) +
    a(9) * a(7) * a(14) +
    a(13) * a(6) * a(11) -
    a(13) * a(7) * a(10);
  inv[4] =
    -a(4) * a(10) * a(15) +
    a(4) * a(11) * a(14) +
    a(8) * a(6) * a(15) -
    a(8) * a(7) * a(14) -
    a(12) * a(6) * a(11) +
    a(12) * a(7) * a(10);
  inv[8] =
    a(4) * a(9) * a(15) -
    a(4) * a(11) * a(13) -
    a(8) * a(5) * a(15) +
    a(8) * a(7) * a(13) +
    a(12) * a(5) * a(11) -
    a(12) * a(7) * a(9);
  inv[12] =
    -a(4) * a(9) * a(14) +
    a(4) * a(10) * a(13) +
    a(8) * a(5) * a(14) -
    a(8) * a(6) * a(13) -
    a(12) * a(5) * a(10) +
    a(12) * a(6) * a(9);
  inv[1] =
    -a(1) * a(10) * a(15) +
    a(1) * a(11) * a(14) +
    a(9) * a(2) * a(15) -
    a(9) * a(3) * a(14) -
    a(13) * a(2) * a(11) +
    a(13) * a(3) * a(10);
  inv[5] =
    a(0) * a(10) * a(15) -
    a(0) * a(11) * a(14) -
    a(8) * a(2) * a(15) +
    a(8) * a(3) * a(14) +
    a(12) * a(2) * a(11) -
    a(12) * a(3) * a(10);
  inv[9] =
    -a(0) * a(9) * a(15) +
    a(0) * a(11) * a(13) +
    a(8) * a(1) * a(15) -
    a(8) * a(3) * a(13) -
    a(12) * a(1) * a(11) +
    a(12) * a(3) * a(9);
  inv[13] =
    a(0) * a(9) * a(14) -
    a(0) * a(10) * a(13) -
    a(8) * a(1) * a(14) +
    a(8) * a(2) * a(13) +
    a(12) * a(1) * a(10) -
    a(12) * a(2) * a(9);
  inv[2] =
    a(1) * a(6) * a(15) -
    a(1) * a(7) * a(14) -
    a(5) * a(2) * a(15) +
    a(5) * a(3) * a(14) +
    a(13) * a(2) * a(7) -
    a(13) * a(3) * a(6);
  inv[6] =
    -a(0) * a(6) * a(15) +
    a(0) * a(7) * a(14) +
    a(4) * a(2) * a(15) -
    a(4) * a(3) * a(14) -
    a(12) * a(2) * a(7) +
    a(12) * a(3) * a(6);
  inv[10] =
    a(0) * a(5) * a(15) -
    a(0) * a(7) * a(13) -
    a(4) * a(1) * a(15) +
    a(4) * a(3) * a(13) +
    a(12) * a(1) * a(7) -
    a(12) * a(3) * a(5);
  inv[14] =
    -a(0) * a(5) * a(14) +
    a(0) * a(6) * a(13) +
    a(4) * a(1) * a(14) -
    a(4) * a(2) * a(13) -
    a(12) * a(1) * a(6) +
    a(12) * a(2) * a(5);
  inv[3] =
    -a(1) * a(6) * a(11) +
    a(1) * a(7) * a(10) +
    a(5) * a(2) * a(11) -
    a(5) * a(3) * a(10) -
    a(9) * a(2) * a(7) +
    a(9) * a(3) * a(6);
  inv[7] =
    a(0) * a(6) * a(11) -
    a(0) * a(7) * a(10) -
    a(4) * a(2) * a(11) +
    a(4) * a(3) * a(10) +
    a(8) * a(2) * a(7) -
    a(8) * a(3) * a(6);
  inv[11] =
    -a(0) * a(5) * a(11) +
    a(0) * a(7) * a(9) +
    a(4) * a(1) * a(11) -
    a(4) * a(3) * a(9) -
    a(8) * a(1) * a(7) +
    a(8) * a(3) * a(5);
  inv[15] =
    a(0) * a(5) * a(10) -
    a(0) * a(6) * a(9) -
    a(4) * a(1) * a(10) +
    a(4) * a(2) * a(9) +
    a(8) * a(1) * a(6) -
    a(8) * a(2) * a(5);
  const det =
    a(0) * (inv[0] ?? 0) + a(1) * (inv[4] ?? 0) + a(2) * (inv[8] ?? 0) + a(3) * (inv[12] ?? 0);
  if (Math.abs(det) < 1e-20) throw new Error('singular matrix');
  for (let i = 0; i < 16; i++) inv[i] = (inv[i] ?? 0) / det;
  return inv;
}

/** Inverse bind matrices of a skin, by joint name. */
export function inverseBinds(g: Gltf): Map<string, Mat4> {
  const skin = g.json.skins?.[0];
  if (!skin || skin.inverseBindMatrices === undefined) throw new Error('no skin');
  const { data } = readAccessor(g, skin.inverseBindMatrices);
  const out = new Map<string, Mat4>();
  skin.joints.forEach((j, i) => {
    out.set(
      g.json.nodes[j]?.name ?? `#${j}`,
      Float64Array.from(data.subarray(i * 16, i * 16 + 16)),
    );
  });
  return out;
}

// --- GLB writer --------------------------------------------------------------------------------

/** Accumulates a single binary buffer plus bufferViews / accessors for a new glTF. */
export class GlbBuilder {
  readonly json: Record<string, unknown[]> & { accessors: unknown[]; bufferViews: unknown[] };
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  constructor() {
    this.json = { accessors: [], bufferViews: [] };
  }

  /** Appends raw bytes as a bufferView (4-byte aligned); returns its index. */
  view(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) this.push(new Uint8Array(pad));
    const view: Record<string, number> = {
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.byteLength,
    };
    if (target) view['target'] = target;
    this.push(bytes);
    return this.json.bufferViews.push(view) - 1;
  }

  /** Adds an accessor over a new bufferView. */
  accessor(
    array: Float32Array | Uint16Array | Uint32Array | Uint8Array,
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4',
    opts: { target?: number; minMax?: boolean } = {},
  ): number {
    const componentType =
      array instanceof Float32Array
        ? 5126
        : array instanceof Uint32Array
          ? 5125
          : array instanceof Uint16Array
            ? 5123
            : 5121;
    const n = COMPONENTS[type] ?? 1;
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const acc: Record<string, unknown> = {
      bufferView: this.view(bytes.slice(), opts.target),
      componentType,
      count: array.length / n,
      type,
    };
    if (opts.minMax) {
      const min = Array<number>(n).fill(Infinity);
      const max = Array<number>(n).fill(-Infinity);
      for (let i = 0; i < array.length; i++) {
        const k = i % n;
        const v = array[i] ?? 0;
        if (v < (min[k] ?? 0)) min[k] = v;
        if (v > (max[k] ?? 0)) max[k] = v;
      }
      acc['min'] = min;
      acc['max'] = max;
    }
    return this.json.accessors.push(acc) - 1;
  }

  private push(bytes: Uint8Array) {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
  }

  /** Serialises; `extra` holds the rest of the glTF JSON (nodes, meshes, ...). */
  build(extra: Record<string, unknown>): Uint8Array {
    const json = {
      asset: { version: '2.0', generator: 'home-tour build-avatars' },
      ...extra,
      ...this.json,
    };
    const binLen = Math.ceil(this.length / 4) * 4;
    (json as Record<string, unknown>)['buffers'] = [{ byteLength: binLen }];
    const text = new TextEncoder().encode(JSON.stringify(json));
    const jsonLen = Math.ceil(text.length / 4) * 4;
    const total = 12 + 8 + jsonLen + 8 + binLen;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLen, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.fill(0x20, 20, 20 + jsonLen);
    out.set(text, 20);
    const b = 20 + jsonLen;
    dv.setUint32(b, binLen, true);
    dv.setUint32(b + 4, 0x004e4942, true);
    let o = b + 8;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}
