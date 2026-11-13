import { describe, expect, it } from 'vitest';
import type { Room } from '@home-tour/shared';
import { loadCollisionMesh } from './collision.ts';
import { ROOM_HALF, buildFixtureRoom } from './fixture.ts';
import { writeGlb } from './glb.ts';
import {
  boomClearance,
  clearance,
  currentRoom,
  mergeSoups,
  openFloorNear,
  planToWorld,
  soupToWorld,
  worldSeats,
} from './rooms.ts';

const identity = { position: [0, 0, 0] as [number, number, number], rotationYaw: 0, scale: 1 };

describe('floor plan placement', () => {
  // Same numbers as apps/web seatInPlan: rotate (x, z) by yaw, scale, translate.
  const placement = { roomId: 'r', x: 10, z: -2, rotationYaw: Math.PI / 2 };

  it('scales, rotates about +Y (counter-clockwise from above) and translates', () => {
    const [x, y, z] = planToWorld([1, 0.5, 0], placement, 2);
    // Local +X turned 90 degrees CCW points to -Z.
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(1);
    expect(z).toBeCloseTo(-4);
  });

  it('places seats with the room and turns their facing', () => {
    const room = {
      id: 'r',
      seats: [{ id: 's', position: [0, 0.45, -1], facingYaw: 0.25, confirmed: false }],
    } as unknown as Room;
    const [s] = worldSeats(room, placement, 1);
    expect(s?.x).toBeCloseTo(9);
    expect(s?.z).toBeCloseTo(-2);
    expect(s?.y).toBeCloseTo(0.45);
    expect(s?.facingYaw).toBeCloseTo(0.25 + Math.PI / 2);
  });

  it('moves collision triangles with the room and merges rooms', () => {
    const tri = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]), triangleCount: 1 };
    const a = soupToWorld(tri, identity, { roomId: 'a', x: 0, z: 0, rotationYaw: 0 }, 1);
    const b = soupToWorld(
      tri,
      { ...identity, scale: 2 },
      { roomId: 'b', x: 5, z: 0, rotationYaw: 0 },
      1,
    );
    expect([...b.positions.slice(3, 6)]).toEqual([7, 0, 0]);
    const merged = mergeSoups([a, b]);
    expect(merged.triangleCount).toBe(2);
    expect([...merged.positions.slice(9, 12)]).toEqual([5, 0, 0]);
  });
});

describe('currentRoom', () => {
  const rooms = [
    { id: 'a', minX: -2, maxX: 2, minZ: -2, maxZ: 2 },
    { id: 'b', minX: 1.8, maxX: 6, minZ: -1, maxZ: 1 },
  ];

  it('picks the room containing the point, the smaller one where they overlap', () => {
    expect(currentRoom(rooms, 0, 0)).toBe('a');
    expect(currentRoom(rooms, 4, 0)).toBe('b');
    expect(currentRoom(rooms, 1.9, 0)).toBe('b');
  });

  it('falls back to the nearest room outside every footprint', () => {
    expect(currentRoom(rooms, 8, 0)).toBe('b');
    expect(currentRoom(rooms, -5, 0)).toBe('a');
    expect(currentRoom([], 0, 0)).toBeNull();
  });
});

describe('openFloorNear', () => {
  const { positions, indices } = buildFixtureRoom();
  const mesh = loadCollisionMesh(writeGlb(positions, indices));

  it('keeps a spawn that already has room around it', () => {
    expect(openFloorNear(mesh, 0, 0, 0)).toEqual([0, 0, 0]);
  });

  it('moves a spawn off a wall onto open floor', () => {
    const p = openFloorNear(mesh, ROOM_HALF - 0.1, 0, 0);
    expect(p).not.toBeNull();
    const [x, y, z] = p ?? [0, 0, 0];
    expect(y).toBeCloseTo(0);
    expect(clearance(mesh, x, y, z)).toBeGreaterThanOrEqual(0.6);
    expect(Math.hypot(x - (ROOM_HALF - 0.1), z)).toBeLessThanOrEqual(2);
  });

  it('moves a spawn whose camera would start against the wall behind it', () => {
    // Facing -Z (yaw 0) right in front of the +Z wall: the boom has no room.
    const [x, y, z] = openFloorNear(mesh, 0, ROOM_HALF - 0.7, 0) ?? [0, 0, 0];
    expect(boomClearance(mesh, x, y, z, 0)).toBeGreaterThanOrEqual(1.5);
    expect(z).toBeLessThan(ROOM_HALF - 0.7);
  });
});
