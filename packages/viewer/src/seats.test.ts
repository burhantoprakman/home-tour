import { describe, expect, it } from 'vitest';
import {
  SEAT_RANGE,
  SIT_BACK,
  SIT_HEIGHT,
  SitMachine,
  nearestSeat,
  pickSeatOnScreen,
  seatsInRange,
  sitSpot,
  type WorldSeat,
} from './seats.ts';

const seat = (id: string, x: number, z: number, confirmed = true, y = 0.45): WorldSeat => ({
  id,
  roomId: 'r',
  x,
  y,
  z,
  facingYaw: 0,
  confirmed,
});
const feet = { x: 0, y: 0, z: 0 };

describe('seat range and picking', () => {
  const seats = [
    seat('near', 1, 0),
    seat('edge', 0, SEAT_RANGE),
    seat('far', 3, 0),
    seat('unconfirmed', -0.5, 0, false),
    seat('upstairs', 0.5, 0, true, 2.9),
  ];

  it('offers confirmed seats within range on the same floor', () => {
    expect(seatsInRange(seats, feet, false).map((s) => s.id)).toEqual(['near', 'edge']);
  });

  it('offers unconfirmed seats too when asked (dev ?seats=all)', () => {
    expect(seatsInRange(seats, feet, true).map((s) => s.id)).toEqual([
      'near',
      'edge',
      'unconfirmed',
    ]);
  });

  it('picks the nearest offered seat for E', () => {
    expect(nearestSeat(seatsInRange(seats, feet, false), feet)?.id).toBe('near');
    expect(nearestSeat(seatsInRange(seats, feet, true), feet)?.id).toBe('unconfirmed');
    expect(nearestSeat([], feet)).toBeNull();
  });

  it('picks the ring nearest a tap, within the tap radius', () => {
    const points = [
      { seat: 'a', x: 100, y: 100 },
      { seat: 'b', x: 130, y: 100 },
    ];
    expect(pickSeatOnScreen(points, 118, 100)).toBe('b');
    expect(pickSeatOnScreen(points, 100, 140)).toBe('a');
    expect(pickSeatOnScreen(points, 300, 300)).toBeNull();
  });

  it('puts the feet in front of the seat, facing its way, lowered by the sit height', () => {
    const s = { ...seat('s', 1, 2), facingYaw: Math.PI / 2 }; // faces -X
    const spot = sitSpot(s);
    expect(spot.x).toBeCloseTo(1 - SIT_BACK);
    expect(spot.z).toBeCloseTo(2);
    expect(spot.y).toBeCloseTo(0.45 - SIT_HEIGHT);
    expect(spot.yaw).toBe(Math.PI / 2);
  });
});

describe('SitMachine', () => {
  const dt = 1 / 30;
  const target = seat('couch', 0, -2); // faces -Z: the sit spot is SIT_BACK in front, z = -2.33

  /** Walks a point along the machine's steering until it stops steering. */
  function approach(m: SitMachine, pos = { x: 0, z: 0 }, blockedAtZ = -Infinity) {
    for (let i = 0; i < 600 && m.state === 'approach'; i++) {
      const v = m.update(dt, { ...pos, wantsMove: false });
      if (!v) break;
      pos.x += v.vx * dt;
      pos.z = Math.max(blockedAtZ, pos.z + v.vz * dt);
    }
    return pos;
  }

  it('walks to the seat, sits down, stays seated, stands up on move, then is free', () => {
    const m = new SitMachine(1.4, 1.3, 1.0);
    m.request(target, { x: 0, z: 0 });
    expect(m.state).toBe('approach');
    const pos = approach(m);
    expect(m.state).toBe('sittingDown');
    expect(m.snapped).toBe(false);
    expect(Math.hypot(pos.x - sitSpot(target).x, pos.z - sitSpot(target).z)).toBeLessThan(0.15);
    expect(m.locked).toBe(true);

    // Move input is ignored while sitting down.
    let t = 0;
    for (; m.state === 'sittingDown' && t < 5; t += dt) m.update(dt, { ...pos, wantsMove: true });
    expect(t).toBeCloseTo(1.3, 1);
    expect(m.state).toBe('seated');
    m.update(dt, { ...pos, wantsMove: false });
    expect(m.state).toBe('seated');
    m.update(dt, { ...pos, wantsMove: true });
    expect(m.state).toBe('standingUp');
    for (let i = 0; i < 1.1 / dt; i++) m.update(dt, { ...pos, wantsMove: false });
    expect(m.state).toBe('none');
    expect(m.seat).toBeNull();
    expect(m.locked).toBe(false);
  });

  it('cancels the approach when the player moves', () => {
    const m = new SitMachine(1.4);
    m.request(target, { x: 0, z: 0 });
    expect(m.update(dt, { x: 0, z: 0, wantsMove: true })).toBeNull();
    expect(m.state).toBe('none');
  });

  it('snaps onto the seat when blocked near it (the couch stops the capsule)', () => {
    const m = new SitMachine(1.4);
    m.request(target, { x: 0, z: 0 });
    approach(m, { x: 0, z: 0 }, -1.6); // blocked 0.7 m short of the spot
    expect(m.state).toBe('sittingDown');
    expect(m.snapped).toBe(true);
  });

  it('snaps after 2 s blocked far away', () => {
    const m = new SitMachine(1.4);
    m.request(seat('couch', 0, -6), { x: 0, z: 0 });
    let steps = 0;
    while (m.state === 'approach' && steps++ < 200) m.update(dt, { x: 0, z: 0, wantsMove: false });
    expect(m.state).toBe('sittingDown');
    expect(m.snapped).toBe(true);
    expect(steps * dt).toBeGreaterThan(1.99);
    expect(steps * dt).toBeLessThan(2.2);
  });

  it('ignores new requests while seated, and E (stand) gets up', () => {
    const m = new SitMachine(1.4);
    m.request(target, { x: 0, z: 0 });
    const pos = approach(m);
    for (let t = 0; t < 1.4; t += dt) m.update(dt, { ...pos, wantsMove: false });
    m.request(seat('other', 5, 5), pos);
    expect(m.seat?.id).toBe('couch');
    m.stand();
    expect(m.state).toBe('standingUp');
  });
});

describe('sitSpot scale', () => {
  it('shrinks the hip offsets with the avatar', () => {
    const s = seat('couch', 1, 0);
    const spot = sitSpot(s, 0.9);
    expect(spot.y).toBeCloseTo(s.y - SIT_HEIGHT * 0.9);
  });
});
