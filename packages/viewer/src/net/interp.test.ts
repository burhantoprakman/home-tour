import { describe, expect, it } from 'vitest';
import { INTERP_DELAY_MS, InterpBuffer, type Pose } from './interp.ts';

const at = (x: number, yaw = 0) => ({ x, y: 0, z: 0, yaw });
/** sample() that must have a pose (the buffer isn't empty). */
function pose(b: InterpBuffer, now: number): Pose {
  const p = b.sample(now);
  if (!p) throw new Error('no pose');
  return p;
}

describe('InterpBuffer', () => {
  it('is empty until the first sample, then holds it', () => {
    const b = new InterpBuffer();
    expect(b.sample(1000)).toBeNull();
    b.push(1000, at(2));
    expect(b.sample(5000)).toMatchObject({ x: 2 });
  });

  it('draws INTERP_DELAY_MS behind, lerping between samples', () => {
    const b = new InterpBuffer();
    b.push(0, at(0));
    b.push(66, at(1));
    b.push(133, at(2));
    expect(pose(b, 33 + INTERP_DELAY_MS).x).toBeCloseTo(0.5, 2);
    expect(pose(b, 100 + INTERP_DELAY_MS).x).toBeCloseTo(1.5, 1);
  });

  it('extrapolates briefly past the newest sample, then holds', () => {
    const b = new InterpBuffer();
    b.push(0, at(0));
    b.push(100, at(1));
    expect(pose(b, 150 + INTERP_DELAY_MS).x).toBeCloseTo(1.5, 2);
    const held = pose(b, 10_000).x;
    expect(held).toBeLessThanOrEqual(2.5);
    expect(pose(b, 20_000).x).toBe(held);
  });

  it('turns the short way round', () => {
    const b = new InterpBuffer();
    b.push(0, at(0, 3.0));
    b.push(100, at(0, -3.0));
    const yaw = pose(b, 50 + INTERP_DELAY_MS).yaw;
    expect(Math.abs(yaw)).toBeGreaterThan(3.0);
  });

  it('snaps across teleports', () => {
    const b = new InterpBuffer();
    b.push(0, at(0));
    b.push(100, at(10));
    expect(pose(b, 50 + INTERP_DELAY_MS).x).toBe(10);
  });

  it('a pause then a move starts from the pause, not from the old timestamp', () => {
    const b = new InterpBuffer();
    b.push(0, at(0));
    b.push(5000, at(0)); // standing still, patches keep coming
    b.push(5066, at(1));
    expect(pose(b, 5033 + INTERP_DELAY_MS).x).toBeCloseTo(0.5, 2);
  });
});
