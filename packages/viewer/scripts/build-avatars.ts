/**
 * Builds public/avatars/*.glb from the downloaded Quaternius CC0 packs (see
 * public/avatars/SOURCES.md for exactly which files). Each output GLB holds one body on the
 * shared 65-joint rig, its textures (downscaled JPEG) and the five clips the viewer plays:
 * idle, walk, sitDown, sit, standUp.
 *
 * What it does per body:
 *  - merges the parts (base body + eyes/brows + hair) into one skinned mesh with one primitive
 *    per material, re-binding every part to the target skeleton's bind pose
 *  - dresses the base body: each triangle is assigned a clothing slot (skin, shirt/dress,
 *    trousers, shoes) from the bone it follows, so hems sit at bone boundaries (elbow, waist,
 *    knee, ankle); cloth areas are smoothed (Taubin) so muscle relief reads as fabric
 *  - adds a generated A-line skirt to dresses, skinned to pelvis and thighs
 *  - (fantasy-outfit bodies only) removes skin hidden under separate clothing meshes
 *  - drops attributes the viewer does not use (extra UV sets, vertex colours)
 *  - simplifies the mesh to at most MAX_TRIANGLES (scripts/avatars/decimate.ts)
 *  - copies the clips from the animation library, keeping rotations for every bone but
 *    translation only for root and pelvis (so each body keeps its own bone lengths), with the
 *    pelvis height scaled to the body's leg length
 *
 * Run (macOS; uses `sips` for the textures):
 *   node scripts/build-avatars.ts <dir with the two extracted packs> <scratch dir>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildCollisionMesh, raycast } from '../src/collision.ts';
import { decimate } from './avatars/decimate.ts';
import {
  GlbBuilder,
  invert,
  inverseBinds,
  mul,
  readAccessor,
  readGltf,
  type Gltf,
  type Mat4,
} from './avatars/gltf.ts';

const MAX_TRIANGLES = 9_900;

const [, , packs, scratch] = argv;
if (!packs || !scratch) {
  console.error('usage: node scripts/build-avatars.ts <packs dir> <scratch dir>');
  exit(1);
}
const outDir = fileURLToPath(new URL('../public/avatars/', import.meta.url));

const UAL = `${packs}/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb`;
const UBC = `${packs}/Universal Base Characters[Standard]`;
const BASE = `${UBC}/Base Characters/Godot - UE`;
const HAIR = `${UBC}/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)`;
const SKIN_TEX = `${UBC}/Base Characters/Textures`;

/** Clip name in the library -> name in our GLB. */
const CLIPS: Record<string, string> = {
  Idle_Loop: 'idle',
  Walk_Loop: 'walk',
  Sitting_Enter: 'sitDown',
  Sitting_Idle_Loop: 'sit',
  Sitting_Exit: 'standUp',
};

interface Slot {
  /** Texture file (resized to `size` px JPEG); `color` multiplies it, or is the flat colour. */
  texture?: string;
  size?: number;
  color?: [number, number, number];
  /** Output material name (default: the slot name). Several slots may share `Tint`. */
  material?: string;
  /** Roughness (default 0.85). */
  roughness?: number;
}
interface Part {
  file: string;
  /** Node names to take (default: every skinned mesh node). */
  nodes?: string[];
  /** Keep only the head and neck (for heads cut from a full base body). */
  headOnly?: boolean;
  /**
   * Bone name -> slot: dresses a base body. A triangle goes to the slot of the bone its corners
   * follow (bones not listed keep the material's slot), unless a hem plane covers that bone.
   */
  regions?: Record<string, string>;
}
/** Rest-pose (T-pose) joint positions, metres, in the skeleton file's frame (+Y up, +Z front). */
interface Rig {
  at(bone: string): number[];
}
/**
 * A straight hem between two slots: for triangles on `bones`, the side of the plane
 * dot(n, p) = d decides the slot (`above` where dot(n, p) >= d), and the vertices on the
 * boundary are snapped onto the plane so the edge is a clean line, not a zig-zag.
 */
interface Hem {
  bones: string[];
  n: number[];
  d: number;
  above: string;
  below: string;
}
/** A-line skirt from the hips to just below the knee, skinned to pelvis and thighs. */
interface Skirt {
  slot: string;
  /** Hem radius over the hip radius, sideways and front/back. */
  flare: [number, number];
  /** Hem height: fraction of the way from the hips (0) to the knees (1); >1 is below the knee. */
  length: number;
}
interface Body {
  id: string;
  /** File whose skeleton (rest pose + inverse binds) the body is bound to. */
  skeleton: string;
  parts: Part[];
  /** Source material name -> output material. The material named `Tint` gets the player colour. */
  materials: Record<string, string>;
  slots: Record<string, Slot>;
  /** Hem planes for dressed parts (see Part.regions). */
  hems?: (rig: Rig) => Hem[];
  /** Slots smoothed so the body's muscle relief reads as fabric (Taubin, boundary locked). */
  smooth?: Record<string, number>;
  /** Slots pushed out along their normals by this much (metres, tapered to 0 at the hems). */
  inflate?: Record<string, number>;
  /** Straight trouser legs: below the knee the slot is pushed out to at least `radius` m. */
  straightLegs?: { slot: string; radius: number };
  skirt?: Skirt;
  /** Slots left out of simplification (generated, already low-poly). */
  keep?: string[];
}

type Rgb = [number, number, number];
const SIDES = ['l', 'r'];
const bones = (...names: string[]) =>
  names.flatMap((n) => (n.endsWith('_') ? SIDES.map((s) => n + s) : [n]));
const regions = (map: Record<string, string[]>): Record<string, string> =>
  Object.fromEntries(Object.entries(map).flatMap(([slot, list]) => list.map((b) => [b, slot])));
/** Everything below the elbow on the rig: forearm, hand and finger bones. */
const HANDS = SIDES.flatMap((s) => [
  `lowerarm_${s}`,
  `hand_${s}`,
  ...['index', 'middle', 'pinky', 'ring', 'thumb'].flatMap((f) =>
    ['01', '02', '03', '04_leaf'].map((k) => `${f}_${k}_${s}`),
  ),
]);

/**
 * A modern home outfit on a Quaternius base body (shared rig, CC0). Men: a short-sleeved shirt
 * (takes the player colour), trousers and shoes. Women: a sleeveless knee-length A-line dress
 * (takes the player colour) and flat shoes. Hems are straight planes on the T-pose rig.
 */
const modern = (o: {
  sex: 'Male' | 'Female';
  hair: string[];
  hairTexture: string;
  // The hair textures are grey; Quaternius' engine shaders colour them, we bake a colour in.
  hairColor: Rgb;
  skin: 'Light' | 'Dark';
  trousers?: Rgb;
  shoes: Rgb;
}): Body => {
  const male = o.sex === 'Male';
  const file = `${BASE}/Superhero_${o.sex}_FullBody.gltf`;
  const skinTex = male
    ? o.skin === 'Light'
      ? `${SKIN_TEX}/T_Superhero_Male_Ligh.png`
      : `${BASE}/T_Superhero_Male_Dark.png`
    : `${SKIN_TEX}/T_Superhero_Female_${o.skin}_BaseColor.png`;
  const body = male
    ? regions({
        Skin: ['Head', 'neck_01', ...HANDS],
        Tint: bones('spine_01', 'spine_02', 'spine_03', 'clavicle_', 'upperarm_'),
        Trousers: bones('pelvis', 'thigh_', 'calf_'),
        Shoes: bones('foot_', 'ball_', 'ball_leaf_'),
      })
    : regions({
        Skin: ['Head', 'neck_01', ...HANDS, ...bones('upperarm_', 'calf_')],
        Tint: bones('spine_01', 'spine_02', 'spine_03', 'clavicle_', 'pelvis', 'thigh_'),
        Shoes: bones('foot_', 'ball_', 'ball_leaf_'),
      });
  const cloth: Slot = { color: [0.93, 0.93, 0.93], roughness: 0.9 };
  const UP = [0, 1, 0];
  const unit = (v: number[]) => {
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  };
  const dotp = (a: number[], b: number[]) => a.reduce((t, x, i) => t + x * (b[i] ?? 0), 0);
  /** Plane across the upper arm at `f` of the way from shoulder to elbow (+`offset` metres). */
  const armPlane = (rig: Rig, side: string, f: number, offset: number) => {
    const a = rig.at(`upperarm_${side}`),
      b = rig.at(`lowerarm_${side}`);
    const n = unit(b.map((x, i) => x - (a[i] ?? 0)));
    return {
      n,
      d:
        dotp(
          n,
          a.map((x, i) => x + f * ((b[i] ?? 0) - x)),
        ) + offset,
    };
  };
  const height = (rig: Rig, bone: string) => rig.at(bone)[1] ?? 0;
  const hems = (rig: Rig): Hem[] =>
    male
      ? [
          // Shirt to the top of the hips, trousers to the ankle, short sleeves, round collar.
          {
            bones: bones('spine_01', 'pelvis', 'thigh_'),
            n: UP,
            d: height(rig, 'spine_01') - 0.04,
            above: 'Tint',
            below: 'Trousers',
          },
          {
            bones: bones('calf_', 'foot_', 'ball_', 'ball_leaf_'),
            n: UP,
            d: height(rig, 'foot_l') + 0.03,
            above: 'Trousers',
            below: 'Shoes',
          },
          ...SIDES.map((side) => ({
            bones: bones(`clavicle_${side}`, `upperarm_${side}`, `lowerarm_${side}`),
            ...armPlane(rig, side, 0.55, 0),
            above: 'Skin',
            below: 'Tint',
          })),
          {
            bones: bones('neck_01', 'spine_03', 'Head'),
            n: UP,
            d: height(rig, 'neck_01') - 0.025,
            above: 'Skin',
            below: 'Tint',
          },
        ]
      : [
          // Sleeveless top, scoop neck, bare lower legs, flat shoes. The skirt covers the knee.
          ...SIDES.map((side) => ({
            bones: bones(`clavicle_${side}`, `upperarm_${side}`),
            ...armPlane(rig, side, 0, 0.02),
            above: 'Skin',
            below: 'Tint',
          })),
          {
            bones: bones('neck_01', 'spine_03', 'Head'),
            n: UP,
            d: height(rig, 'neck_01') - 0.06,
            above: 'Skin',
            below: 'Tint',
          },
          {
            bones: bones('thigh_', 'calf_'),
            n: UP,
            d: height(rig, 'calf_l'),
            above: 'Tint',
            below: 'Skin',
          },
          {
            bones: bones('calf_', 'foot_', 'ball_', 'ball_leaf_'),
            n: UP,
            d: height(rig, 'foot_l') + 0.025,
            above: 'Skin',
            below: 'Shoes',
          },
        ];
  return {
    id: '',
    skeleton: file,
    parts: [
      { file, nodes: [`Super${male ? 'H' : 'h'}ero_${o.sex}`], regions: body },
      { file, nodes: ['Eyes', 'Eyebrows'] },
      ...o.hair.map((h) => ({ file: `${HAIR}/${h}.gltf` })),
    ],
    materials: {
      [`MI_Superhero_${o.sex}`]: 'Skin',
      MI_Hair_1: 'Hair',
      MI_Hair_2: 'Hair',
      MI_Eyes: 'Eyes',
    },
    slots: {
      Skin: { texture: skinTex, size: 512 },
      Tint: cloth,
      ...(male
        ? { Trousers: { color: o.trousers ?? [0.17, 0.19, 0.24], roughness: 0.9 } }
        : { Skirt: { ...cloth, material: 'Tint' } }),
      Shoes: { color: o.shoes, roughness: 0.6 },
      Hair: { texture: `${HAIR}/${o.hairTexture}`, size: 256, color: o.hairColor },
      Eyes: { texture: `${BASE}/T_Eye_Brown.png`, size: 64 },
    },
    hems,
    ...(male ? { straightLegs: { slot: 'Trousers', radius: 0.068 } } : {}),
    smooth: male ? { Tint: 40, Trousers: 40, Shoes: 40 } : { Tint: 30, Shoes: 40 },
    inflate: male ? { Tint: 0.016, Trousers: 0.022, Shoes: 0.014 } : { Tint: 0.008, Shoes: 0.01 },
    ...(male
      ? {}
      : { skirt: { slot: 'Skirt', flare: [1.3, 1.45], length: 1.08 }, keep: ['Skirt'] }),
  };
};

const BODIES: Body[] = [
  {
    id: 'mannequin',
    skeleton: UAL,
    parts: [{ file: UAL, nodes: ['Mannequin'] }],
    materials: { M_Main: 'Tint', M_Joints: 'Joints' },
    slots: { Tint: { color: [0.8, 0.8, 0.8] }, Joints: { color: [0.25, 0.25, 0.28] } },
  },
  {
    ...modern({
      sex: 'Male',
      hair: ['Hair_SimpleParted'],
      hairTexture: 'T_Hair_1_BaseColor.png',
      hairColor: [0.42, 0.27, 0.15],
      skin: 'Light',
      trousers: [0.17, 0.19, 0.24], // dark navy
      shoes: [0.07, 0.05, 0.04], // dark brown leather
    }),
    id: 'villager-m',
  },
  {
    ...modern({
      sex: 'Female',
      hair: ['Hair_Long'],
      hairTexture: 'T_Hair_2_BaseColor.png',
      hairColor: [0.36, 0.18, 0.09],
      skin: 'Light',
      shoes: [0.42, 0.11, 0.14], // burgundy flats
    }),
    id: 'villager-f',
  },
  {
    ...modern({
      sex: 'Male',
      hair: ['Hair_Buzzed', 'Hair_Beard'],
      hairTexture: 'T_Hair_1_BaseColor.png',
      hairColor: [0.2, 0.14, 0.1],
      skin: 'Dark',
      trousers: [0.62, 0.55, 0.43], // beige chinos
      shoes: [0.13, 0.13, 0.14], // dark trainers
    }),
    id: 'villager-m-beard',
  },
];

// ---------------------------------------------------------------------------------------------

interface Geometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  joints: number[];
  weights: number[];
  indices: number[];
}
const emptyGeometry = (): Geometry => ({
  positions: [],
  normals: [],
  uvs: [],
  joints: [],
  weights: [],
  indices: [],
});

const cache = new Map<string, Gltf>();
const load = (file: string) => {
  let g = cache.get(file);
  if (!g) cache.set(file, (g = readGltf(file)));
  return g;
};

function jointNames(g: Gltf): string[] {
  const skin = g.json.skins?.[0];
  if (!skin) throw new Error('no skin');
  return skin.joints.map((j) => g.json.nodes[j]?.name ?? `#${j}`);
}

function transformPoint(m: Mat4, x: number, y: number, z: number, w: number): number[] {
  const e = (i: number) => m[i] ?? 0;
  return [
    e(0) * x + e(4) * y + e(8) * z + e(12) * w,
    e(1) * x + e(5) * y + e(9) * z + e(13) * w,
    e(2) * x + e(6) * y + e(10) * z + e(14) * w,
  ];
}

/** Appends one part's primitives to the per-material geometry, re-bound to the target rig. */
function addPart(
  body: Body,
  part: Part,
  joints: string[],
  targetBind: Map<string, Mat4>,
  out: Map<string, Geometry>,
  hems: Hem[] = [],
) {
  const g = load(part.file);
  const srcNames = jointNames(g);
  const srcIbm = inverseBinds(g);
  // Source bind -> target bind, per source joint index.
  const rebind = srcNames.map((name) => {
    const tb = targetBind.get(name);
    const ib = srcIbm.get(name);
    if (!tb || !ib) throw new Error(`${part.file}: joint ${name} missing in target rig`);
    return mul(tb, ib);
  });
  const remap = srcNames.map((name) => joints.indexOf(name));
  const headJoints = new Set(['Head', 'neck_01'].map((n) => srcNames.indexOf(n)));

  for (const node of g.json.nodes) {
    if (node.mesh === undefined || node.skin === undefined) continue;
    if (part.nodes && !part.nodes.includes(node.name ?? '')) continue;
    const mesh = g.json.meshes?.[node.mesh];
    for (const prim of mesh?.primitives ?? []) {
      const matName = g.json.materials?.[prim.material ?? -1]?.name ?? '';
      const slot = body.materials[matName];
      if (!slot) throw new Error(`${part.file}: no output material for ${matName}`);
      const attr = (name: string) => {
        const i = prim.attributes[name];
        if (i === undefined) throw new Error(`${part.file}: primitive without ${name}`);
        return readAccessor(g, i).data;
      };
      const pos = attr('POSITION');
      const nrm = attr('NORMAL');
      const uv = attr('TEXCOORD_0');
      const jnt = attr('JOINTS_0');
      const wgt = attr('WEIGHTS_0');
      const idx =
        prim.indices === undefined
          ? Float32Array.from({ length: pos.length / 3 }, (_, i) => i)
          : readAccessor(g, prim.indices).data;
      const count = pos.length / 3;

      const keep = new Uint8Array(count).fill(1);
      if (part.headOnly) {
        for (let v = 0; v < count; v++) {
          let best = 0;
          for (let k = 1; k < 4; k++)
            if ((wgt[v * 4 + k] ?? 0) > (wgt[v * 4 + best] ?? 0)) best = k;
          keep[v] = headJoints.has(jnt[v * 4 + best] ?? -1) ? 1 : 0;
        }
      }

      // Each vertex in the target bind pose (positions, normals, remapped joints, weights).
      const P = new Float64Array(count * 3),
        N = new Float64Array(count * 3),
        J = new Uint8Array(count * 4),
        W = new Float64Array(count * 4);
      const dominant = new Int32Array(count); // source joint index with the largest weight
      for (let v = 0; v < count; v++) {
        const m = new Float64Array(16);
        let wsum = 0;
        let best = 0;
        for (let k = 0; k < 4; k++) {
          const w = wgt[v * 4 + k] ?? 0;
          if (w > (wgt[v * 4 + best] ?? 0)) best = k;
          const r = rebind[jnt[v * 4 + k] ?? 0];
          if (!w || !r) continue;
          for (let i = 0; i < 16; i++) m[i] = (m[i] ?? 0) + (r[i] ?? 0) * w;
          wsum += w;
        }
        dominant[v] = jnt[v * 4 + best] ?? 0;
        if (wsum === 0) m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const p = transformPoint(
          m,
          pos[v * 3] ?? 0,
          pos[v * 3 + 1] ?? 0,
          pos[v * 3 + 2] ?? 0,
          wsum || 1,
        );
        const n = transformPoint(m, nrm[v * 3] ?? 0, nrm[v * 3 + 1] ?? 0, nrm[v * 3 + 2] ?? 0, 0);
        const nl = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) || 1;
        for (let k = 0; k < 3; k++) {
          P[v * 3 + k] = (p[k] ?? 0) / (wsum || 1);
          N[v * 3 + k] = (n[k] ?? 0) / nl;
        }
        for (let k = 0; k < 4; k++) {
          const w = wgt[v * 4 + k] ?? 0;
          J[v * 4 + k] = w ? Math.max(0, remap[jnt[v * 4 + k] ?? 0] ?? 0) : 0;
          W[v * 4 + k] = wsum ? w / wsum : k === 0 ? 1 : 0;
        }
      }

      // Slot per triangle: the material's slot or, on a dressed part, the region of the bone its
      // corners follow; where a hem plane covers that bone, the side of the plane decides.
      const boneOf = (v: number) => srcNames[dominant[v] ?? 0] ?? '';
      const hemFor = (bone: string) =>
        part.regions ? hems.findIndex((h) => h.bones.includes(bone)) : -1;
      const field = (h: Hem, x: number, y: number, z: number) =>
        (h.n[0] ?? 0) * x + (h.n[1] ?? 0) * y + (h.n[2] ?? 0) * z - h.d;
      const triSlot: string[] = [];
      const triHem: number[] = [];
      for (let t = 0; t < idx.length; t += 3) {
        const tri = [idx[t] ?? 0, idx[t + 1] ?? 0, idx[t + 2] ?? 0];
        let target = slot,
          hemIndex = -1;
        if (part.regions) {
          const bonesOf = tri.map(boneOf);
          const major = bonesOf[1] === bonesOf[2] ? (bonesOf[1] ?? '') : (bonesOf[0] ?? '');
          hemIndex = hemFor(major);
          if (hemIndex < 0) hemIndex = bonesOf.map(hemFor).find((i) => i >= 0) ?? -1;
          const hem = hems[hemIndex];
          if (hem) {
            const c = [0, 1, 2].map(
              (k) => tri.reduce((sum, v) => sum + (P[v * 3 + k] ?? 0), 0) / 3,
            );
            target = field(hem, c[0] ?? 0, c[1] ?? 0, c[2] ?? 0) >= 0 ? hem.above : hem.below;
          } else {
            target = part.regions[major] ?? slot;
          }
        }
        triSlot.push(target);
        triHem.push(hemIndex);
      }
      // Snap hem vertices onto their plane (welded by position, so UV seams stay closed).
      if (part.regions && hems.length) {
        const key = (v: number) =>
          [0, 1, 2].map((k) => Math.round((P[v * 3 + k] ?? 0) * 1e5)).join(',');
        const sides = new Map<string, Map<number, Set<string>>>(); // key -> hem -> slots
        for (let t = 0; t < idx.length; t += 3) {
          const h = triHem[t / 3] ?? -1;
          if (h < 0) continue;
          for (let k = 0; k < 3; k++) {
            const kv = key(idx[t + k] ?? 0);
            let m = sides.get(kv);
            if (!m) sides.set(kv, (m = new Map()));
            let set = m.get(h);
            if (!set) m.set(h, (set = new Set()));
            set.add(triSlot[t / 3] ?? '');
          }
        }
        const snapped = new Map<string, number[]>();
        for (let v = 0; v < count; v++) {
          const kv = key(v);
          let done = snapped.get(kv);
          if (!done) {
            const p = [P[v * 3] ?? 0, P[v * 3 + 1] ?? 0, P[v * 3 + 2] ?? 0];
            for (const [h, set] of sides.get(kv) ?? []) {
              const hem = hems[h];
              if (!hem || !set.has(hem.above) || !set.has(hem.below)) continue;
              const f = field(hem, p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
              for (let k = 0; k < 3; k++) p[k] = (p[k] ?? 0) - f * (hem.n[k] ?? 0);
            }
            snapped.set(kv, (done = p));
          }
          for (let k = 0; k < 3; k++) P[v * 3 + k] = done[k] ?? 0;
        }
      }

      const indexIn = new Map<string, Map<number, number>>();
      const vertexIn = (target: string, v: number): number => {
        const geo = out.get(target) ?? emptyGeometry();
        out.set(target, geo);
        let map = indexIn.get(target);
        if (!map) indexIn.set(target, (map = new Map()));
        let i = map.get(v);
        if (i === undefined) {
          i = geo.positions.length / 3;
          map.set(v, i);
          geo.positions.push(P[v * 3] ?? 0, P[v * 3 + 1] ?? 0, P[v * 3 + 2] ?? 0);
          geo.normals.push(N[v * 3] ?? 0, N[v * 3 + 1] ?? 0, N[v * 3 + 2] ?? 0);
          geo.uvs.push(uv[v * 2] ?? 0, uv[v * 2 + 1] ?? 0);
          for (let k = 0; k < 4; k++) {
            geo.joints.push(J[v * 4 + k] ?? 0);
            geo.weights.push(W[v * 4 + k] ?? 0);
          }
        }
        return i;
      };
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] ?? 0,
          b = idx[t + 1] ?? 0,
          c = idx[t + 2] ?? 0;
        if (!(keep[a] && keep[b] && keep[c])) continue;
        const target = triSlot[t / 3] ?? slot;
        if (!body.slots[target]) throw new Error(`${part.file}: no slot ${target}`);
        const tri = [vertexIn(target, a), vertexIn(target, b), vertexIn(target, c)];
        out.get(target)?.indices.push(...tri);
      }
    }
  }
}

/**
 * Removes skin triangles covered by clothes: from the triangle's centre and each corner, a ray
 * along the vertex normal must hit the clothes within HIDDEN_GAP. Hidden skin only costs budget
 * and, once both surfaces are simplified, pokes through the sleeves.
 */
const HIDDEN_GAP = 0.04;
function cullHidden(skin: Geometry, cloth: Geometry) {
  const mesh = buildCollisionMesh(
    {
      positions: Float32Array.from(
        cloth.indices.flatMap((v) => [0, 1, 2].map((k) => cloth.positions[v * 3 + k] ?? 0)),
      ),
      triangleCount: cloth.indices.length / 3,
    },
    0.05,
  );
  const covered = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const len = Math.hypot(nx, ny, nz) || 1;
    const [dx, dy, dz] = [nx / len, ny / len, nz / len];
    return (
      raycast(mesh, x + dx * 1e-3, y + dy * 1e-3, z + dz * 1e-3, dx, dy, dz, HIDDEN_GAP) !== null
    );
  };
  const kept: number[] = [];
  const p = (v: number, k: number) => skin.positions[v * 3 + k] ?? 0;
  const n = (v: number, k: number) => skin.normals[v * 3 + k] ?? 0;
  for (let t = 0; t < skin.indices.length; t += 3) {
    const tri = [skin.indices[t] ?? 0, skin.indices[t + 1] ?? 0, skin.indices[t + 2] ?? 0];
    const corners = tri.every((v) => covered(p(v, 0), p(v, 1), p(v, 2), n(v, 0), n(v, 1), n(v, 2)));
    const c = [0, 1, 2].map((k) => tri.reduce((s, v) => s + p(v, k), 0) / 3);
    const cn = [0, 1, 2].map((k) => tri.reduce((s, v) => s + n(v, k), 0));
    const centre = covered(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, cn[0] ?? 0, cn[1] ?? 0, cn[2] ?? 0);
    if (!(corners && centre)) kept.push(...tri);
  }
  skin.indices = kept;
}

/**
 * Taubin smoothing (shrink-free) of one slot's surface, so the base body's muscle relief under
 * a shirt or trousers reads as fabric, then pushes it out by `inflate` metres so it sits like
 * cloth over the body (shoes get their volume this way). Vertices on the slot's open boundary
 * (its hems, where it meets skin or another garment) stay put and the push fades in over the
 * next two rings, so the seams between slots do not crack.
 */
function smoothSlot(geo: Geometry, iterations: number, inflate = 0) {
  const count = geo.positions.length / 3;
  const key = (v: number) =>
    [0, 1, 2].map((k) => Math.round((geo.positions[v * 3 + k] ?? 0) * 1e5)).join(',');
  const weld = new Map<string, number>();
  const id = new Int32Array(count);
  for (let v = 0; v < count; v++) {
    const k = key(v);
    let w = weld.get(k);
    if (w === undefined) weld.set(k, (w = weld.size));
    id[v] = w;
  }
  const n = weld.size;
  const pos = new Float64Array(n * 3);
  for (let v = 0; v < count; v++)
    for (let k = 0; k < 3; k++) pos[(id[v] ?? 0) * 3 + k] = geo.positions[v * 3 + k] ?? 0;
  const edgeUse = new Map<string, number>();
  const nbrs: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < geo.indices.length; t += 3) {
    const tri = [0, 1, 2].map((k) => id[geo.indices[t + k] ?? 0] ?? 0);
    for (let k = 0; k < 3; k++) {
      const a = tri[k] ?? 0,
        b = tri[(k + 1) % 3] ?? 0;
      nbrs[a]?.add(b);
      nbrs[b]?.add(a);
      const e = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUse.set(e, (edgeUse.get(e) ?? 0) + 1);
    }
  }
  const locked = new Uint8Array(n);
  for (const [e, c] of edgeUse) {
    if (c !== 1) continue;
    for (const v of e.split(',')) locked[Number(v)] = 1;
  }
  const step = (factor: number) => {
    const next = Float64Array.from(pos);
    for (let v = 0; v < n; v++) {
      const list = nbrs[v];
      if (locked[v] || !list?.size) continue;
      for (let k = 0; k < 3; k++) {
        let avg = 0;
        for (const u of list) avg += pos[u * 3 + k] ?? 0;
        avg /= list.size;
        next[v * 3 + k] = (pos[v * 3 + k] ?? 0) + factor * (avg - (pos[v * 3 + k] ?? 0));
      }
    }
    pos.set(next);
  };
  for (let i = 0; i < iterations; i++) {
    step(0.5);
    step(-0.53);
  }
  if (inflate) {
    // Rings from the boundary: 0 on it, then 1, 2, ... (capped at 3).
    const ring = new Uint8Array(n).fill(3);
    for (let v = 0; v < n; v++) if (locked[v]) ring[v] = 0;
    for (let r = 1; r < 3; r++)
      for (let v = 0; v < n; v++)
        if ((ring[v] ?? 3) > r && [...(nbrs[v] ?? [])].some((u) => ring[u] === r - 1)) ring[v] = r;
    const nrm = new Float64Array(n * 3);
    for (let v = 0; v < count; v++)
      for (let k = 0; k < 3; k++)
        nrm[(id[v] ?? 0) * 3 + k] =
          (nrm[(id[v] ?? 0) * 3 + k] ?? 0) + (geo.normals[v * 3 + k] ?? 0);
    for (let v = 0; v < n; v++) {
      const l = Math.hypot(nrm[v * 3] ?? 0, nrm[v * 3 + 1] ?? 0, nrm[v * 3 + 2] ?? 0) || 1;
      const push = (inflate * Math.min(ring[v] ?? 3, 3)) / 3;
      for (let k = 0; k < 3; k++)
        pos[v * 3 + k] = (pos[v * 3 + k] ?? 0) + ((nrm[v * 3 + k] ?? 0) / l) * push;
    }
  }
  for (let v = 0; v < count; v++)
    for (let k = 0; k < 3; k++) geo.positions[v * 3 + k] = pos[(id[v] ?? 0) * 3 + k] ?? 0;
}

/**
 * Trousers instead of leggings: every vertex of the slot that follows a shin (calf bone) is
 * pushed away from the knee-ankle line to at least `radius`, so the leg hangs straight. The
 * cuff ends up a little wider than the shoe top, as real trousers do.
 */
function straightenLegs(
  opt: { slot: string; radius: number },
  slots: Map<string, Geometry>,
  joints: string[],
  rig: Rig,
) {
  const geo = slots.get(opt.slot);
  if (!geo) return;
  let moved = 0;
  for (const side of SIDES) {
    const calf = joints.indexOf(`calf_${side}`);
    const a = rig.at(`calf_${side}`),
      b = rig.at(`foot_${side}`);
    const ab = b.map((x, i) => x - (a[i] ?? 0));
    const len2 = ab.reduce((t, x) => t + x * x, 0);
    for (let v = 0; v < geo.positions.length / 3; v++) {
      let best = 0;
      for (let k = 1; k < 4; k++)
        if ((geo.weights[v * 4 + k] ?? 0) > (geo.weights[v * 4 + best] ?? 0)) best = k;
      if (geo.joints[v * 4 + best] !== calf) continue;
      const p = [0, 1, 2].map((k) => geo.positions[v * 3 + k] ?? 0);
      const t = Math.min(
        1,
        Math.max(0, p.reduce((s, x, i) => s + (x - (a[i] ?? 0)) * (ab[i] ?? 0), 0) / len2),
      );
      const c = a.map((x, i) => x + t * (ab[i] ?? 0));
      const r = p.map((x, i) => x - (c[i] ?? 0));
      const len = Math.hypot(...r);
      // Full effect from a little below the knee down; blend in over the top of the shin.
      const want = opt.radius * Math.min(1, t / 0.2) + len * (1 - Math.min(1, t / 0.2));
      if (len > 1e-6 && len < want) {
        for (let k = 0; k < 3; k++)
          geo.positions[v * 3 + k] = (c[k] ?? 0) + ((r[k] ?? 0) / len) * want;
        moved++;
      }
    }
  }
  console.log(`  ${opt.slot}: ${moved} shin vertices pushed out to ${opt.radius} m`);
}

/**
 * Generates an A-line skirt (rings of a flared tube) from the hips to the hem, in the bind
 * pose, around the body's own hip cross-section so nothing pokes through at rest. Skinned to
 * the pelvis at the waist, blending towards the thigh on each side lower down, so it follows
 * the legs when walking and sitting.
 */
function addSkirt(
  skirt: Skirt,
  slots: Map<string, Geometry>,
  joints: string[],
  targetBind: Map<string, Mat4>,
) {
  const at = (bone: string): number[] => {
    const m = targetBind.get(bone);
    if (!m) throw new Error(`skirt: no bone ${bone}`);
    return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
  };
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - (b[i] ?? 0));
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
  const axis = (v: number[]) => {
    const i = v.map(Math.abs).indexOf(Math.max(...v.map(Math.abs)));
    return [0, 1, 2].map((k) => (k === i ? Math.sign(v[i] ?? 1) : 0));
  };
  // Body frame from the rig: up (pelvis -> head), side (towards thigh_l), front (heel -> toe).
  const up = axis(sub(at('Head'), at('pelvis')));
  const side = axis(sub(at('thigh_l'), at('thigh_r')));
  const fwd = axis(sub(at('ball_l'), at('foot_l')));
  if (new Set([up, side, fwd].map((a) => a.indexOf(a.find((x) => x !== 0) ?? 1))).size !== 3)
    throw new Error('skirt: could not find the body axes');
  const hip = dot(at('thigh_l'), up);
  const knee = dot(at('calf_l'), up);
  const top = dot(at('spine_01'), up) - 0.03; // natural waist
  const hem = hip - skirt.length * (hip - knee);

  // Torso/hip/thigh vertices of the body, in (side, up, front) coordinates.
  const hipBones = new Set(
    ['pelvis', 'spine_01', 'thigh_l', 'thigh_r'].map((b) => joints.indexOf(b)),
  );
  const pts: number[][] = [];
  for (const geo of slots.values()) {
    for (let v = 0; v < geo.positions.length / 3; v++) {
      let best = 0;
      for (let k = 1; k < 4; k++)
        if ((geo.weights[v * 4 + k] ?? 0) > (geo.weights[v * 4 + best] ?? 0)) best = k;
      if (!hipBones.has(geo.joints[v * 4 + best] ?? -1)) continue;
      const p = [0, 1, 2].map((k) => geo.positions[v * 3 + k] ?? 0);
      pts.push([dot(p, side), dot(p, up), dot(p, fwd)]);
    }
  }
  /** Extents of the body at height h: [left, right, front, back] and the centre. */
  const section = (h: number) => {
    const near = pts.filter((p) => Math.abs((p[1] ?? 0) - h) < 0.025);
    if (near.length < 8) return null;
    const cs = near.reduce((s, p) => s + (p[0] ?? 0), 0) / near.length;
    const cf = near.reduce((s, p) => s + (p[2] ?? 0), 0) / near.length;
    const ext = [
      Math.max(...near.map((p) => (p[0] ?? 0) - cs)),
      Math.max(...near.map((p) => cs - (p[0] ?? 0))),
      Math.max(...near.map((p) => (p[2] ?? 0) - cf)),
      Math.max(...near.map((p) => cf - (p[2] ?? 0))),
    ];
    return { cs, cf, ext };
  };
  const topSec = section(top);
  if (!topSec) throw new Error('skirt: no body at hip height');
  let widest = topSec.ext;
  for (let h = top; h > hip - 0.15; h -= 0.01) {
    const s = section(h);
    if (s) widest = widest.map((r, i) => Math.max(r, s.ext[i] ?? 0));
  }
  const hemExt = widest.map((r, i) => r * (i < 2 ? skirt.flare[0] : skirt.flare[1]));

  const RINGS = 9,
    SEGS = 32;
  const pelvis = joints.indexOf('pelvis'),
    thighL = joints.indexOf('thigh_l'),
    thighR = joints.indexOf('thigh_r'),
    calfL = joints.indexOf('calf_l'),
    calfR = joints.indexOf('calf_r');
  const geo = slots.get(skirt.slot) ?? emptyGeometry();
  slots.set(skirt.slot, geo);
  const base = geo.positions.length / 3;
  for (let r = 0; r < RINGS; r++) {
    const t = r / (RINGS - 1);
    const h = top + (hem - top) * t;
    const ease = Math.pow(t, 0.75);
    const body = section(h);
    const ext = topSec.ext.map((e, i) => {
      const want = e * 1.01 + 0.006 + ((hemExt[i] ?? e) - e * 1.04) * ease;
      // Never inside the body at this height (hips are wider than the waist).
      return Math.max(want, (body?.ext[i] ?? 0) * 1.05 + 0.008);
    });
    const leg = 0.85 * Math.pow(t, 1.2);
    for (let sgm = 0; sgm < SEGS; sgm++) {
      const a = (sgm / SEGS) * Math.PI * 2;
      const cx = Math.cos(a),
        cz = Math.sin(a);
      const x = cx * (cx >= 0 ? (ext[0] ?? 0) : (ext[1] ?? 0));
      const z = cz * (cz >= 0 ? (ext[2] ?? 0) : (ext[3] ?? 0));
      const s = topSec.cs + x,
        f = topSec.cf + z;
      for (let k = 0; k < 3; k++) {
        geo.positions.push(s * (side[k] ?? 0) + h * (up[k] ?? 0) + f * (fwd[k] ?? 0));
        // Outward normal of the ellipse, tilted up by the flare (the cone widens downwards).
        geo.normals.push(cx * (side[k] ?? 0) + cz * (fwd[k] ?? 0) + 0.25 * (up[k] ?? 0));
      }
      geo.uvs.push(sgm / SEGS, t);
      const sideT = Math.min(1, Math.max(0, (x / Math.max(ext[0] ?? 0, ext[1] ?? 0) + 0.4) / 0.8));
      const left = sideT * sideT * (3 - 2 * sideT);
      // Below the knee the cloth follows the shin, so it drapes down from the knees when seated
      // instead of sticking out over the lap.
      const shin = Math.min(1, Math.max(0, (knee + 0.03 - h) / 0.06));
      const calf = left >= 0.5 ? calfL : calfR;
      geo.joints.push(pelvis, thighL, thighR, calf);
      geo.weights.push(1 - leg, leg * (1 - shin) * left, leg * (1 - shin) * (1 - left), leg * shin);
    }
  }
  for (let r = 0; r < RINGS - 1; r++) {
    for (let sgm = 0; sgm < SEGS; sgm++) {
      const a = base + r * SEGS + sgm,
        b = base + r * SEGS + ((sgm + 1) % SEGS);
      const c = a + SEGS,
        d = b + SEGS;
      geo.indices.push(a, b, c, b, d, c); // counter-clockwise seen from outside
    }
  }
  // The body inside the skirt is never seen and would poke through when the legs move.
  const inside = new Set(
    ['pelvis', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r'].map((b) => joints.indexOf(b)),
  );
  let hidden = 0;
  for (const [name, g] of slots) {
    if (name === skirt.slot) continue;
    const dom = (v: number) => {
      let best = 0;
      for (let k = 1; k < 4; k++)
        if ((g.weights[v * 4 + k] ?? 0) > (g.weights[v * 4 + best] ?? 0)) best = k;
      return g.joints[v * 4 + best] ?? -1;
    };
    const kept: number[] = [];
    for (let t = 0; t < g.indices.length; t += 3) {
      const tri = [g.indices[t] ?? 0, g.indices[t + 1] ?? 0, g.indices[t + 2] ?? 0];
      const h =
        tri.reduce(
          (sum, v) =>
            sum +
            dot(
              [0, 1, 2].map((k) => g.positions[v * 3 + k] ?? 0),
              up,
            ),
          0,
        ) / 3;
      if (h < top - 0.03 && h > hem + 0.015 && tri.every((v) => inside.has(dom(v)))) hidden++;
      else kept.push(...tri);
    }
    g.indices = kept;
  }
  console.log(
    `  skirt: ${hidden} body tris inside removed; hips ${(hip - knee).toFixed(2)} m above the knee, hem ${hemExt.map((x) => x.toFixed(2)).join('/')} m`,
  );
}

/** Drops vertices no triangle uses; returns typed arrays. */
function compact(geo: Geometry, indices: ArrayLike<number>) {
  const map = new Map<number, number>();
  const order: number[] = [];
  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] ?? 0;
    let n = map.get(v);
    if (n === undefined) {
      n = order.length;
      map.set(v, n);
      order.push(v);
    }
    outIdx[i] = n;
  }
  const pick = (src: number[], n: number, Arr: Float32ArrayConstructor | Uint8ArrayConstructor) => {
    const out = new Arr(order.length * n);
    order.forEach((v, i) => {
      for (let k = 0; k < n; k++) out[i * n + k] = src[v * n + k] ?? 0;
    });
    return out;
  };
  return {
    positions: pick(geo.positions, 3, Float32Array) as Float32Array,
    normals: pick(geo.normals, 3, Float32Array) as Float32Array,
    uvs: pick(geo.uvs, 2, Float32Array) as Float32Array,
    joints: pick(geo.joints, 4, Uint8Array) as Uint8Array,
    weights: pick(geo.weights, 4, Float32Array) as Float32Array,
    indices: outIdx,
  };
}

/**
 * Recomputes vertex normals from the simplified surface. The survivors of a collapse keep their
 * original normals, which no longer match the coarser faces and shade them as dark facets.
 * Faces are averaged over every vertex at the same position (so UV seams stay smooth), but only
 * faces within ~65 degrees of the original normal count, which keeps intended hard edges.
 */
function smoothNormals(positions: Float32Array, normals: Float32Array, indices: Uint32Array) {
  const key = (v: number) =>
    `${Math.round((positions[v * 3] ?? 0) * 1e5)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e5)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e5)}`;
  const faces = new Map<string, number[]>(); // position -> area-weighted face normals (xyz...)
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] ?? 0, indices[t + 1] ?? 0, indices[t + 2] ?? 0];
    const p = (v: number, k: number) => positions[v * 3 + k] ?? 0;
    const ux = p(b, 0) - p(a, 0),
      uy = p(b, 1) - p(a, 1),
      uz = p(b, 2) - p(a, 2);
    const vx = p(c, 0) - p(a, 0),
      vy = p(c, 1) - p(a, 1),
      vz = p(c, 2) - p(a, 2);
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const v of [a, b, c]) {
      const k = key(v);
      const list = faces.get(k) ?? [];
      list.push(...n);
      faces.set(k, list);
    }
  }
  const count = positions.length / 3;
  for (let v = 0; v < count; v++) {
    const ox = normals[v * 3] ?? 0,
      oy = normals[v * 3 + 1] ?? 0,
      oz = normals[v * 3 + 2] ?? 0;
    const list = faces.get(key(v)) ?? [];
    let sx = 0,
      sy = 0,
      sz = 0;
    for (let i = 0; i < list.length; i += 3) {
      const fx = list[i] ?? 0,
        fy = list[i + 1] ?? 0,
        fz = list[i + 2] ?? 0;
      const len = Math.hypot(fx, fy, fz);
      // Double-sided cards may be wound either way: align each face with the old normal.
      const d = len > 0 ? (fx * ox + fy * oy + fz * oz) / len : 0;
      if (Math.abs(d) < 0.42) continue;
      const sign = d < 0 ? -1 : 1;
      sx += fx * sign;
      sy += fy * sign;
      sz += fz * sign;
    }
    const len = Math.hypot(sx, sy, sz);
    if (len === 0) continue;
    normals[v * 3] = sx / len;
    normals[v * 3 + 1] = sy / len;
    normals[v * 3 + 2] = sz / len;
  }
}

function jpeg(file: string, size: number): Uint8Array {
  const name = file.slice(file.lastIndexOf('/') + 1).replace(/\.png$/i, '');
  const out = `${scratch}/${name}-${size}.jpg`;
  execFileSync(
    'sips',
    ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(size), file, '--out', out],
    {
      stdio: 'pipe',
    },
  );
  return readFileSync(out);
}

function build(body: Body): void {
  const skel = load(body.skeleton);
  const joints = jointNames(skel);
  const targetBind = new Map([...inverseBinds(skel)].map(([n, m]) => [n, invert(m)]));

  const slots = new Map<string, Geometry>();
  const rig: Rig = {
    at: (bone) => {
      const m = targetBind.get(bone);
      if (!m) throw new Error(`no bone ${bone}`);
      return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
    },
  };
  const hems = body.hems?.(rig) ?? [];
  for (const part of body.parts) addPart(body, part, joints, targetBind, slots, hems);
  for (const [name, iterations] of Object.entries(body.smooth ?? {})) {
    const geo = slots.get(name);
    if (geo) smoothSlot(geo, iterations, body.inflate?.[name] ?? 0);
  }
  if (body.straightLegs) straightenLegs(body.straightLegs, slots, joints, rig);
  if (body.skirt) addSkirt(body.skirt, slots, joints, targetBind);
  const skinGeo = slots.get('Skin');
  const clothGeo = slots.get('Tint');
  const dressed = body.parts.some((p) => p.regions);
  if (skinGeo && clothGeo && body.id !== 'mannequin' && !dressed) {
    const before = skinGeo.indices.length / 3;
    cullHidden(skinGeo, clothGeo);
    console.log(`  Skin: ${before - skinGeo.indices.length / 3} tris hidden under clothes removed`);
  }

  const total = [...slots.values()].reduce((s, g) => s + g.indices.length / 3, 0);
  const full = new Map([...slots].map(([name, geo]) => [name, compact(geo, geo.indices)]));
  // Same ratio for every material; parts that can't shrink (hair cards are all seams) push the
  // others further, so repeat with a smaller ratio until the body fits.
  let ratio = Math.min(1, MAX_TRIANGLES / total);
  let simplified = new Map<string, Uint32Array>();
  for (let attempt = 0; attempt < 10; attempt++) {
    simplified = new Map(
      [...full].map(([name, g]) => [
        name,
        ratio < 1 && !body.keep?.includes(name)
          ? decimate(g.positions, g.indices, Math.floor((g.indices.length / 3) * ratio)).indices
          : g.indices,
      ]),
    );
    const got = [...simplified.values()].reduce((s, i) => s + i.length / 3, 0);
    if (got <= MAX_TRIANGLES) break;
    ratio *= (MAX_TRIANGLES / got) * 0.98;
  }

  const b = new GlbBuilder();
  const primitives: unknown[] = [];
  const materials: unknown[] = [];
  const images: unknown[] = [];
  const textures: unknown[] = [];
  let triangles = 0;
  for (const [name, f] of full) {
    const tris = f.indices.length / 3;
    const g = compact(
      {
        positions: [...f.positions],
        normals: [...f.normals],
        uvs: [...f.uvs],
        joints: [...f.joints],
        weights: [...f.weights],
        indices: [],
      },
      simplified.get(name) ?? f.indices,
    );
    if (ratio < 1 || body.smooth?.[name]) smoothNormals(g.positions, g.normals, g.indices);
    triangles += g.indices.length / 3;
    console.log(
      `  ${name}: ${tris} -> ${g.indices.length / 3} tris, ${g.positions.length / 3} verts`,
    );
    const slot = body.slots[name];
    if (!slot) throw new Error(`no slot ${name}`);
    const pbr: Record<string, unknown> = {
      metallicFactor: 0,
      roughnessFactor: slot.roughness ?? 0.85,
    };
    if (slot.texture) {
      const view = b.view(jpeg(slot.texture, slot.size ?? 512));
      images.push({ bufferView: view, mimeType: 'image/jpeg' });
      textures.push({ source: images.length - 1, sampler: 0 });
      pbr['baseColorTexture'] = { index: textures.length - 1 };
      if (slot.color) pbr['baseColorFactor'] = [...slot.color, 1];
    } else {
      pbr['baseColorFactor'] = [...(slot.color ?? [1, 1, 1]), 1];
    }
    materials.push({ name: slot.material ?? name, pbrMetallicRoughness: pbr, doubleSided: true });
    const vertexCount = g.positions.length / 3;
    primitives.push({
      attributes: {
        POSITION: b.accessor(g.positions, 'VEC3', { target: 34962, minMax: true }),
        NORMAL: b.accessor(g.normals, 'VEC3', { target: 34962 }),
        TEXCOORD_0: b.accessor(g.uvs, 'VEC2', { target: 34962 }),
        JOINTS_0: b.accessor(g.joints, 'VEC4', { target: 34962 }),
        WEIGHTS_0: b.accessor(g.weights, 'VEC4', { target: 34962 }),
      },
      indices: b.accessor(vertexCount < 65536 ? Uint16Array.from(g.indices) : g.indices, 'SCALAR', {
        target: 34963,
      }),
      material: materials.length - 1,
    });
  }

  // Skeleton: Armature (scene root) -> root bone hierarchy + the skinned mesh node.
  const nodes: Record<string, unknown>[] = [{ name: 'Armature', children: [] as number[] }];
  const nodeOf = new Map<string, number>();
  const copyBone = (src: number): number => {
    const n = skel.json.nodes[src];
    if (!n) throw new Error('bad bone');
    const i = nodes.push({}) - 1;
    nodeOf.set(n.name ?? '', i);
    const out: Record<string, unknown> = { name: n.name };
    if (n.translation) out['translation'] = n.translation;
    if (n.rotation) out['rotation'] = n.rotation;
    if (n.scale) out['scale'] = n.scale;
    const children = (n.children ?? []).map(copyBone);
    if (children.length) out['children'] = children;
    nodes[i] = out;
    return i;
  };
  const rootSrc = skel.json.nodes.findIndex((n) => n.name === 'root');
  const rootBone = copyBone(rootSrc);
  const meshNode = nodes.push({ name: 'Body', mesh: 0, skin: 0 }) - 1;
  nodes[0] = { name: 'Armature', children: [rootBone, meshNode] };
  const ibm = inverseBinds(skel);
  const ibmData = new Float32Array(joints.length * 16);
  joints.forEach((n, i) => ibmData.set(ibm.get(n) ?? [], i * 16));
  const skin = {
    joints: joints.map((n) => nodeOf.get(n) ?? 0),
    inverseBindMatrices: b.accessor(ibmData, 'MAT4'),
    skeleton: rootBone,
  };

  const animations = buildClips(b, nodeOf, skel);

  const glb = b.build({
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{ name: body.id, primitives }],
    skins: [skin],
    materials,
    ...(images.length
      ? { images, textures, samplers: [{ magFilter: 9729, minFilter: 9987 }] }
      : {}),
    animations,
  });
  const path = `${outDir}${body.id}.glb`;
  writeFileSync(path, glb);
  console.log(
    `${body.id}: ${triangles} tris (from ${total}), ${(statSync(path).size / 1024).toFixed(0)} KB`,
  );
}

/** Copies the clips from the library onto this body's bones. */
function buildClips(b: GlbBuilder, nodeOf: Map<string, number>, skel: Gltf) {
  const lib = load(UAL);
  const restZ = (g: Gltf) => g.json.nodes.find((n) => n.name === 'pelvis')?.translation?.[2] ?? 1;
  const pelvisScale = restZ(skel) / restZ(lib);
  const out: unknown[] = [];
  for (const anim of lib.json.animations ?? []) {
    const name = CLIPS[anim.name ?? ''];
    if (!name) continue;
    const channels: unknown[] = [];
    const samplers: unknown[] = [];
    const inputs = new Map<number, { full: number; single: number }>();
    for (const ch of anim.channels) {
      const bone = lib.json.nodes[ch.target.node]?.name ?? '';
      const node = nodeOf.get(bone);
      const { path } = ch.target;
      if (node === undefined || path === 'scale') continue;
      if (path === 'translation' && bone !== 'root' && bone !== 'pelvis') continue;
      const s = anim.samplers[ch.sampler];
      if (!s) continue;
      const { data, n } = readAccessor(lib, s.output);
      const values = Float32Array.from(data);
      if (bone === 'pelvis' && path === 'translation')
        for (let i = 0; i < values.length; i++) values[i] = (values[i] ?? 0) * pelvisScale;
      const constant = values.every((v, i) => Math.abs(v - (values[i % n] ?? 0)) < 1e-5);
      let input = inputs.get(s.input);
      if (!input) {
        const times = readAccessor(lib, s.input).data;
        input = {
          full: b.accessor(Float32Array.from(times), 'SCALAR', { minMax: true }),
          single: b.accessor(Float32Array.of(0), 'SCALAR', { minMax: true }),
        };
        inputs.set(s.input, input);
      }
      samplers.push({
        input: constant ? input.single : input.full,
        output: b.accessor(constant ? values.slice(0, n) : values, n === 4 ? 'VEC4' : 'VEC3'),
        interpolation: 'LINEAR',
      });
      channels.push({ sampler: samplers.length - 1, target: { node, path } });
    }
    out.push({ name, channels, samplers });
  }
  return out;
}

for (const body of BODIES) build(body);
