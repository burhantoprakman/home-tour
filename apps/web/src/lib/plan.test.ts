import { describe, expect, it } from 'vitest';
import { facing, hitRadii, normalizeYaw, rotate, seatInPlan, syncPlan, viewBox } from './plan';

const A = '6f1c2b7e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const B = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
const C = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

const close = (v: [number, number], e: [number, number]) => {
  expect(v[0]).toBeCloseTo(e[0]);
  expect(v[1]).toBeCloseTo(e[1]);
};

describe('plan geometry', () => {
  it('rotates counter-clockwise seen from above, matching facing()', () => {
    // Forward (0, -1) turned by 90 degrees faces -X, as Seat.facingYaw defines.
    close(rotate(0, -1, Math.PI / 2), [-1, 0]);
    close(facing(Math.PI / 2), [-1, 0]);
    close(facing(0), [-0, -1]);
  });

  it('places seats by room yaw, offset and scale', () => {
    const seat = {
      id: 's',
      position: [1, 0.4, 0] as [number, number, number],
      facingYaw: 0,
      confirmed: false,
    };
    close(seatInPlan(seat, { roomId: A, x: 5, z: 2, rotationYaw: Math.PI / 2 }, 2), [5, 0]); // +X turns to -Z
  });

  it('wraps yaw to (-PI, PI]', () => {
    expect(normalizeYaw(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeYaw(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });

  it('lays out a new plan in a row with spawn in the first room', () => {
    const plan = syncPlan(null, [{ id: A }, { id: B }]);
    expect(plan.rooms.map((r) => [r.roomId, r.x])).toEqual([
      [A, 0],
      [B, 5],
    ]);
    expect(plan.spawn).toEqual({ x: 0, z: 0, yaw: 0 });
    expect(plan.scale).toBe(1);
  });

  it('keeps saved placements, drops deleted rooms and appends new ones', () => {
    const saved = {
      rooms: [
        { roomId: A, x: 2, z: 3, rotationYaw: 1 },
        { roomId: C, x: 9, z: 0, rotationYaw: 0 },
      ],
      spawn: { x: 1, z: 1, yaw: 0.5 },
      scale: 1.2,
    };
    const plan = syncPlan(saved, [{ id: A }, { id: B }]);
    expect(plan.rooms).toEqual([
      { roomId: A, x: 2, z: 3, rotationYaw: 1 },
      { roomId: B, x: 7, z: 0, rotationYaw: 0 },
    ]);
    expect(plan.spawn).toEqual(saved.spawn);
    expect(plan.scale).toBe(1.2);
  });

  it('keeps doors that lead to a room of the home and drops the rest', () => {
    const door = (id: string, roomId: string) => ({
      id,
      x: 0,
      z: 0,
      radius: 1,
      bell: true,
      to: { roomId, x: 30, z: 0, yaw: 0 },
    });
    const saved = {
      rooms: [{ roomId: A, x: 0, z: 0, rotationYaw: 0 }],
      spawn: { x: 0, z: 0, yaw: 0 },
      scale: 1,
      doors: [door('front', B), door('gone', C)],
    };
    expect(syncPlan(saved, [{ id: A }, { id: B }]).doors).toEqual([door('front', B)]);
    expect(syncPlan({ ...saved, doors: undefined }, [{ id: A }]).doors).toBeUndefined();
  });

  it('frames every room in a square viewBox', () => {
    const [x, z, w, h] = viewBox(syncPlan(null, [{ id: A }, { id: B }]));
    expect(w).toBe(h);
    expect(x).toBeLessThan(-2);
    expect(x + w).toBeGreaterThan(7);
    expect(z).toBeLessThan(-2);
  });
});

describe('hitRadii', () => {
  it('caps each radius at half the distance to the nearest other seat', () => {
    expect(
      hitRadii([
        [0, 0],
        [0.6, 0],
        [5, 5],
      ]),
    ).toEqual([0.3, 0.3, 0.5]);
  });

  it('uses the full radius for a lone seat', () => {
    expect(hitRadii([[1, 2]])).toEqual([0.5]);
  });
});
