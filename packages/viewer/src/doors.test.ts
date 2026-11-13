import type { Door } from '@home-tour/shared';
import { describe, expect, it } from 'vitest';
import { DoorMachine, doorAt } from './doors.ts';
import { visibleRooms } from './rooms.ts';

const roomId = '6f1d2c1e-8a5b-4c1e-9f0a-1b2c3d4e5f60';
const front: Door = {
  id: 'front',
  x: -8,
  z: 3,
  radius: 1,
  bell: true,
  to: { roomId, x: 37, z: -1, yaw: 2.8 },
};
const timing = { ring: 1, knockless: 0.1, fade: 0.5 };

/** Steps the machine at 0.1 s until `until` returns true or 10 s pass; returns the steps seen. */
function run(m: DoorMachine, x: number, z: number, until: () => boolean) {
  const seen = [];
  for (let i = 0; i < 100 && !until(); i++) seen.push(m.update(0.1, x, z));
  return seen;
}

describe('doorAt', () => {
  it('finds the door whose circle contains the point', () => {
    expect(doorAt([front], -8.5, 3.5)?.id).toBe('front');
    expect(doorAt([front], -6, 3)).toBeNull();
  });

  it('prefers the nearest centre when circles overlap', () => {
    const back = { ...front, id: 'back', x: -7 };
    expect(doorAt([front, back], -7.2, 3)?.id).toBe('back');
  });
});

describe('DoorMachine', () => {
  it('rings, fades out, teleports once, fades in', () => {
    const m = new DoorMachine([front], timing);
    m.update(0.1, 0, 0); // outside: armed
    const first = m.update(0.1, -8, 3);
    expect(first.entered?.id).toBe('front');
    expect(m.locked).toBe(true);
    const steps = run(m, -8, 3, () => m.phase === 'idle');
    expect(steps.filter((s) => s.teleport).length).toBe(1);
    expect(m.fade).toBe(0);
  });

  it('waits for the bell before fading', () => {
    const m = new DoorMachine([front], timing);
    m.update(0.1, 0, 0);
    m.update(0.1, -8, 3);
    for (let i = 0; i < 9; i++) m.update(0.1, -8, 3);
    expect(m.phase).toBe('ringing');
    expect(m.fade).toBe(0);
  });

  it('does not fire for a spawn inside a door circle until the player leaves it', () => {
    const m = new DoorMachine([front], timing);
    expect(m.update(0.1, -8, 3)).toEqual({});
    expect(m.phase).toBe('idle');
    m.update(0.1, 0, 0);
    expect(m.update(0.1, -8, 3).entered).toBeDefined();
  });

  it('does not fire again right after arriving inside another door circle', () => {
    const back = { ...front, id: 'back', x: 37, z: -1 };
    const m = new DoorMachine([front, back], timing);
    m.update(0.1, 0, 0);
    m.update(0.1, -8, 3);
    run(m, -8, 3, () => m.phase === 'fadeIn');
    run(m, 37, -1, () => m.phase === 'idle');
    expect(m.update(0.1, 37, -1)).toEqual({});
  });

  it('is not used while sitting', () => {
    const m = new DoorMachine([front], timing);
    m.update(0.1, 0, 0);
    expect(m.update(0.1, -8, 3, false)).toEqual({});
    expect(m.phase).toBe('idle');
  });

  it('fades halfway at half the fade time', () => {
    const m = new DoorMachine([{ ...front, bell: false }], timing);
    m.update(0.1, 0, 0);
    m.update(0.1, -8, 3);
    m.update(0.1, -8, 3); // knockless time passed -> fadeOut
    m.update(0.25, -8, 3);
    expect(m.phase).toBe('fadeOut');
    expect(m.fade).toBeCloseTo(0.5);
  });
});

describe('visibleRooms', () => {
  const yard = { id: 'yard', minX: -10, maxX: 4, minZ: -6, maxZ: 7 };
  const porch = { id: 'porch', minX: 4.5, maxX: 8, minZ: 0, maxZ: 3 };
  const salon = { id: 'salon', minX: 34, maxX: 42, minZ: -4, maxZ: 4 };

  it('shows the current room and rooms touching it, not ones reached only by a door', () => {
    expect([...visibleRooms([yard, porch, salon], 'yard')].sort()).toEqual(['porch', 'yard']);
    expect([...visibleRooms([yard, porch, salon], 'salon')]).toEqual(['salon']);
  });

  it('shows everything when the player is in no room', () => {
    expect(visibleRooms([yard, salon], null).size).toBe(2);
  });
});
