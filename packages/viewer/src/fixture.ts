/**
 * Synthetic test room: a 6 x 6 m box (floor, four walls, ceiling at 2.5 m) with a 20 cm step and a
 * 40 cm step. Used by tests and by scripts/make-fixture.ts to write the dev-page fixtures.
 *
 *   step20: x 1..2, z -2.5..-1, top y 0.2
 *   step40: x 1..2, z  1..2.5,  top y 0.4
 */

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

export const ROOM_HALF = 3;
export const ROOM_HEIGHT = 2.5;
export const STEP_20: Box = { min: [1, 0, -2.5], max: [2, 0.2, -1] };
export const STEP_40: Box = { min: [1, 0, 1], max: [2, 0.4, 2.5] };

export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Collision geometry for the fixture room. */
export function buildFixtureRoom(): IndexedMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const h = ROOM_HALF,
    y = ROOM_HEIGHT;
  // Floor (normal +y) and ceiling (normal -y).
  quad([-h, 0, -h], [-h, 0, h], [h, 0, h], [h, 0, -h]);
  quad([-h, y, -h], [h, y, -h], [h, y, h], [-h, y, h]);
  // Walls, facing inward.
  quad([-h, 0, -h], [h, 0, -h], [h, y, -h], [-h, y, -h]);
  quad([-h, 0, h], [-h, y, h], [h, y, h], [h, 0, h]);
  quad([-h, 0, -h], [-h, y, -h], [-h, y, h], [-h, 0, h]);
  quad([h, 0, -h], [h, 0, h], [h, y, h], [h, y, -h]);
  for (const box of [STEP_20, STEP_40]) {
    const [x0, y0, z0] = box.min;
    const [x1, y1, z1] = box.max;
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // top
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // -z
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +x
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

const SH_C0 = 0.28209479177387814;

/**
 * Gaussian splats on the fixture's surfaces as a standard 3DGS binary PLY (DC colour only).
 * spacing is the grid step in metres; 0.1 gives ~8k splats.
 */
export function buildFixturePly(spacing = 0.1): Uint8Array {
  const splats: number[][] = [];
  const add = (x: number, y: number, z: number, rgb: [number, number, number]) => {
    splats.push([x, y, z, ...rgb]);
  };
  const h = ROOM_HALF;
  const n = Math.round((2 * h) / spacing);
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const a = -h + i * spacing,
        b = -h + j * spacing;
      const checker = (Math.floor(a + h) + Math.floor(b + h)) % 2 === 0;
      add(a, 0, b, checker ? [0.85, 0.82, 0.75] : [0.45, 0.4, 0.35]);
    }
  }
  const wallRows = Math.round(ROOM_HEIGHT / spacing);
  const wallColors: [number, number, number][] = [
    [0.7, 0.3, 0.3],
    [0.3, 0.6, 0.3],
    [0.3, 0.4, 0.75],
    [0.75, 0.7, 0.3],
  ];
  for (let i = 0; i <= n; i++) {
    const a = -h + i * spacing;
    for (let k = 0; k <= wallRows; k++) {
      const y = k * spacing;
      add(a, y, -h, wallColors[0] ?? [1, 1, 1]);
      add(a, y, h, wallColors[1] ?? [1, 1, 1]);
      add(-h, y, a, wallColors[2] ?? [1, 1, 1]);
      add(h, y, a, wallColors[3] ?? [1, 1, 1]);
    }
  }
  for (const box of [STEP_20, STEP_40]) {
    const [x0, , z0] = box.min;
    const [x1, y1, z1] = box.max;
    for (let x = x0; x <= x1 + 1e-6; x += spacing / 2) {
      for (let z = z0; z <= z1 + 1e-6; z += spacing / 2) add(x, y1 + 0.005, z, [0.95, 0.55, 0.1]);
    }
  }

  const props = [
    'x',
    'y',
    'z',
    'nx',
    'ny',
    'nz',
    'f_dc_0',
    'f_dc_1',
    'f_dc_2',
    'opacity',
    'scale_0',
    'scale_1',
    'scale_2',
    'rot_0',
    'rot_1',
    'rot_2',
    'rot_3',
  ];
  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${splats.length}\n` +
    props.map((p) => `property float ${p}\n`).join('') +
    'end_header\n';
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(headerBytes.length + splats.length * props.length * 4);
  out.set(headerBytes, 0);
  const dv = new DataView(out.buffer, headerBytes.length);
  const logScale = Math.log(spacing * 0.6);
  let o = 0;
  const put = (f: number) => {
    dv.setFloat32(o, f, true);
    o += 4;
  };
  for (const [x = 0, y = 0, z = 0, r = 0, g = 0, b = 0] of splats) {
    put(x);
    put(y);
    put(z);
    put(0);
    put(0);
    put(0);
    put((r - 0.5) / SH_C0);
    put((g - 0.5) / SH_C0);
    put((b - 0.5) / SH_C0);
    put(4); // logit opacity ~0.98
    put(logScale);
    put(logScale);
    put(logScale);
    put(1); // identity quaternion (w first)
    put(0);
    put(0);
    put(0);
  }
  return out;
}
