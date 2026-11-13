import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCollisionMesh, loadCollisionMesh, raycast, raycastDown } from './collision.ts';
import { CapsuleController } from './controller.ts';
import { ROOM_HALF, STEP_20, STEP_40, buildFixtureRoom } from './fixture.ts';
import { parseGlbTriangles, writeGlb } from './glb.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./dev/public/fixtures/${name}`, import.meta.url));

function roomMesh() {
  const { positions, indices } = buildFixtureRoom();
  return loadCollisionMesh(writeGlb(positions, indices));
}

/** Walks along +x (or -x) at z for `seconds`, 60 Hz. */
function walk(ctrl: CapsuleController, vx: number, vz: number, seconds: number) {
  for (let i = 0; i < seconds * 60; i++) ctrl.update(1 / 60, vx, vz);
}

describe('GLB reader', () => {
  it('round-trips the fixture room', () => {
    const { positions, indices } = buildFixtureRoom();
    const soup = parseGlbTriangles(writeGlb(positions, indices));
    expect(soup.triangleCount).toBe(indices.length / 3);
    expect(soup.positions.slice(0, 9)).toEqual(
      Float32Array.from(
        [...indices.slice(0, 3)].flatMap((i) => [...positions.slice(i * 3, i * 3 + 3)]),
      ),
    );
  });

  it('reads the committed collision.glb fixture', () => {
    const mesh = loadCollisionMesh(fixture('collision.glb'));
    expect(mesh.triangleCount).toBe(buildFixtureRoom().indices.length / 3);
  });

  it("reads splat-transform's --collision-mesh output", () => {
    const mesh = loadCollisionMesh(fixture('voxel.collision.glb'));
    expect(mesh.triangleCount).toBeGreaterThan(100);
    // Format check only: a walkable floor exists under the room centre near y = 0. (The voxel
    // mesh is coarse: on this fixture it puts the floor at ~0.2 m and does not resolve the steps.)
    const hit = raycastDown(mesh, 0, 1, 0, 2, 0.7);
    expect(hit).not.toBeNull();
    expect(1 - (hit?.distance ?? 0)).toBeGreaterThan(-0.1);
    expect(1 - (hit?.distance ?? 0)).toBeLessThan(0.3);
  });

  it('rejects non-GLB data', () => {
    expect(() => parseGlbTriangles(new Uint8Array(32))).toThrow(/not a GLB/);
  });
});

describe('SOG fixture', () => {
  it('is a zip bundle with meta.json', () => {
    const bytes = fixture('room.sog');
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]); // 'PK'
    expect(new TextDecoder('latin1').decode(bytes)).toContain('meta.json');
  });
});

describe('broadphase', () => {
  it('finds the floor and ignores walls for ground rays', () => {
    const mesh = roomMesh();
    expect(raycastDown(mesh, 0, 1, 0, 2, 0.7)?.distance).toBeCloseTo(1, 5);
    expect(raycastDown(mesh, 1.5, 1, -1.75, 2, 0.7)?.distance).toBeCloseTo(0.8, 5);
    expect(raycastDown(mesh, 0, 1, 0, 0.5, 0.7)).toBeNull();
  });

  it('handles an empty mesh', () => {
    const mesh = buildCollisionMesh({ positions: new Float32Array(0), triangleCount: 0 });
    expect(raycastDown(mesh, 0, 1, 0, 2, 0.7)).toBeNull();
  });
});

describe('capsule controller', () => {
  it('falls onto the floor and stands on it', () => {
    const ctrl = new CapsuleController(roomMesh(), [0, 1, 0]);
    walk(ctrl, 0, 0, 2);
    expect(ctrl.grounded).toBe(true);
    expect(ctrl.position.y).toBeCloseTo(0, 5);
    walk(ctrl, 0, 0, 1);
    expect(ctrl.position.y).toBeCloseTo(0, 5);
  });

  it('is blocked by a wall and slides along it', () => {
    const ctrl = new CapsuleController(roomMesh(), [0, 0, 0]);
    walk(ctrl, -2, 0, 3); // straight into the -x wall
    const r = ctrl.options.radius;
    expect(ctrl.position.x).toBeGreaterThanOrEqual(-ROOM_HALF + r - 1e-3);
    expect(ctrl.position.x).toBeLessThan(-ROOM_HALF + r + 0.01);
    expect(ctrl.position.y).toBeCloseTo(0, 5);

    // Diagonal into the wall: x stays blocked, z keeps moving.
    walk(ctrl, -1, 1, 1);
    expect(ctrl.position.x).toBeGreaterThanOrEqual(-ROOM_HALF + r - 1e-3);
    expect(ctrl.position.z).toBeGreaterThan(0.9);
  });

  it('climbs a 20 cm step', () => {
    const z = (STEP_20.min[2] + STEP_20.max[2]) / 2;
    const ctrl = new CapsuleController(roomMesh(), [0, 0, z]);
    walk(ctrl, 1.4, 0, 1.2); // ~1.7 m: well onto the step (x 1..2)
    expect(ctrl.position.x).toBeGreaterThan(STEP_20.min[0] + 0.3);
    expect(ctrl.position.y).toBeCloseTo(STEP_20.max[1], 5);
    expect(ctrl.grounded).toBe(true);

    // And walks back down off it.
    walk(ctrl, -1.4, 0, 1.2);
    expect(ctrl.position.x).toBeLessThan(STEP_20.min[0] - 0.3);
    expect(ctrl.position.y).toBeCloseTo(0, 5);
  });

  it('cannot climb a 40 cm step', () => {
    const z = (STEP_40.min[2] + STEP_40.max[2]) / 2;
    const ctrl = new CapsuleController(roomMesh(), [0, 0, z]);
    walk(ctrl, 1.4, 0, 2);
    expect(ctrl.position.y).toBeCloseTo(0, 5);
    expect(ctrl.position.x).toBeLessThan(STEP_40.min[0] - 0.2);
    expect(ctrl.position.x).toBeGreaterThan(STEP_40.min[0] - 0.35);
  });

  it('does not tunnel through a wall at a large time step', () => {
    const ctrl = new CapsuleController(roomMesh(), [0, 0, 0]);
    for (let i = 0; i < 10; i++) ctrl.update(0.1, -20, 0);
    expect(ctrl.position.x).toBeGreaterThan(-ROOM_HALF);
  });
});

/** A unit-free soup from triangles given as 9-number arrays. */
function soup(...tris: number[][]) {
  return buildCollisionMesh({
    positions: Float32Array.from(tris.flat()),
    triangleCount: tris.length,
  });
}

describe('general ray cast', () => {
  // A 2 x 2 m wall in the plane z = -3 (two triangles sharing the diagonal x = y).
  const wall = () => soup([-1, 0, -3, 1, 0, -3, 1, 2, -3], [-1, 0, -3, 1, 2, -3, -1, 2, -3]);

  it('hits a wall straight ahead at the right distance', () => {
    const hit = raycast(wall(), 0, 1, 0, 0, 0, -1, 10);
    expect(hit?.distance).toBeCloseTo(3, 6);
    expect(hit?.upness).toBeCloseTo(0, 6);
  });

  it('misses when the wall is out of reach, beside the ray or behind it', () => {
    expect(raycast(wall(), 0, 1, 0, 0, 0, -1, 2.9)).toBeNull();
    expect(raycast(wall(), 1.5, 1, 0, 0, 0, -1, 10)).toBeNull();
    expect(raycast(wall(), 0, 1, 0, 0, 0, 1, 10)).toBeNull();
  });

  it('hits from either side (two-sided)', () => {
    expect(raycast(wall(), 0, 1, -6, 0, 0, 1, 10)?.distance).toBeCloseTo(3, 6);
  });

  it('hits exactly on the shared diagonal edge and on the outer edge', () => {
    expect(raycast(wall(), 0.5, 0.5, 0, 0, 0, -1, 10)?.distance).toBeCloseTo(3, 6);
    expect(raycast(wall(), 1, 1, 0, 0, 0, -1, 10)?.distance).toBeCloseTo(3, 6);
  });

  it('does not hit a triangle it grazes in its own plane', () => {
    expect(raycast(wall(), -2, 1, -3, 1, 0, 0, 10)).toBeNull();
  });

  it('returns the nearest of several hits across grid cells', () => {
    const mesh = soup(
      [-1, 0, -8, 1, 0, -8, 0, 2, -8],
      [-1, 0, -3, 1, 0, -3, 0, 2, -3],
      [-1, 0, -5, 1, 0, -5, 0, 2, -5],
    );
    expect(mesh.dims[2]).toBeGreaterThan(4);
    const hit = raycast(mesh, 0, 0.5, 0, 0, 0, -1, 20);
    expect(hit?.distance).toBeCloseTo(3, 6);
    expect(hit?.triangle).toBe(1);
  });

  it('agrees with the ground ray on a diagonal down to the fixture floor', () => {
    const mesh = roomMesh();
    const d = Math.SQRT1_2;
    const hit = raycast(mesh, 0, 2, 2, 0, -d, -d, 10);
    const down = raycastDown(mesh, 0, 2, 0, 5, 0.7);
    expect(down?.distance).toBeCloseTo(2, 6);
    expect(hit?.distance).toBeCloseTo(2 * Math.SQRT2, 5);
    expect(hit?.upness).toBeCloseTo(1, 6);
  });

  it('enters the grid from outside and stops at the first wall', () => {
    const hit = raycast(roomMesh(), 0, 1, 10, 0, 0, -1, 20);
    expect(hit?.distance).toBeCloseTo(10 - ROOM_HALF, 5);
  });
});
