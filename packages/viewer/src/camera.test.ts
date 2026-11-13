import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA,
  ThirdPersonCamera,
  fadeForDistance,
  pullInDistance,
  smoothDistance,
  wrapDegrees,
} from './camera.ts';
import { buildCollisionMesh } from './collision.ts';

describe('pullInDistance', () => {
  it('keeps the desired distance when nothing is hit', () => {
    expect(pullInDistance(null, 2.5, 0.2, 0.15)).toBe(2.5);
  });

  it('stops the margin in front of a hit', () => {
    expect(pullInDistance(1.2, 2.5, 0.2, 0.15)).toBeCloseTo(1.0);
  });

  it('ignores hits beyond the desired distance plus margin', () => {
    expect(pullInDistance(2.8, 2.5, 0.2, 0.15)).toBe(2.5);
    expect(pullInDistance(2.65, 2.5, 0.2, 0.15)).toBeCloseTo(2.45);
  });

  it('never goes below the minimum distance', () => {
    expect(pullInDistance(0.1, 2.5, 0.2, 0.15)).toBe(0.15);
  });
});

describe('smoothDistance', () => {
  it('pulls in fast and eases out slowly', () => {
    const inStep = smoothDistance(2.5, 1, 0.1, 18, 3);
    const outStep = smoothDistance(1, 2.5, 0.1, 18, 3);
    expect(2.5 - inStep).toBeGreaterThan(1.2); // > 80 % of the way in one 100 ms frame
    expect(outStep - 1).toBeLessThan(0.45); // < 30 % of the way out
    expect(smoothDistance(1, 2.5, 5, 18, 3)).toBeCloseTo(2.5, 3);
  });
});

describe('fadeForDistance', () => {
  it('is solid far away and hidden right at the camera', () => {
    expect(fadeForDistance(2, 0.7, 0.3)).toBe(1);
    expect(fadeForDistance(0.5, 0.7, 0.3)).toBeCloseTo(0.5);
    expect(fadeForDistance(0.2, 0.7, 0.3)).toBe(0);
  });
});

describe('ThirdPersonCamera', () => {
  // A big wall in the plane z = 1.5 behind an avatar standing at the origin facing -Z.
  const wall = buildCollisionMesh({
    positions: Float32Array.from([
      -10, -1, 1.5, 10, -1, 1.5, 10, 10, 1.5, -10, -1, 1.5, 10, 10, 1.5, -10, 10, 1.5,
    ]),
    triangleCount: 2,
  });
  const feet = { x: 0, y: 0, z: 0 };

  it('sits over the right shoulder, the full distance back, in open space', () => {
    const cam = new ThirdPersonCamera(0, 0);
    cam.update(1, feet, null);
    const o = DEFAULT_CAMERA;
    expect(cam.position[0]).toBeCloseTo(o.shoulder);
    expect(cam.position[1]).toBeCloseTo(o.height);
    expect(cam.position[2]).toBeCloseTo(o.distance);
  });

  // Wall 1.2 m behind: inside the 1.8 m boom.
  const near = buildCollisionMesh({
    positions: Float32Array.from([
      -10, -1, 1.2, 10, -1, 1.2, 10, 10, 1.2, -10, -1, 1.2, 10, 10, 1.2, -10, 10, 1.2,
    ]),
    triangleCount: 2,
  });

  it('pulls in to the margin in front of a wall behind the avatar', () => {
    const cam = new ThirdPersonCamera(0, 0);
    for (let i = 0; i < 60; i++) cam.update(1 / 30, feet, near);
    // The margin is along the (tilted, fanned) probe rays, so the gap is only roughly the margin.
    const gap = 1.2 - cam.position[2];
    expect(gap).toBeGreaterThan(DEFAULT_CAMERA.margin * 0.8);
    expect(gap).toBeLessThan(DEFAULT_CAMERA.margin + DEFAULT_CAMERA.probeRadius);
    expect(cam.distance).toBeLessThan(DEFAULT_CAMERA.distance);
  });

  it('drops under an overhead obstacle instead of pulling in to the head', () => {
    // A ceiling-fan-like slab 0.5 m above the pivot, 0.3..2 m behind the avatar.
    const fan = buildCollisionMesh({
      positions: Float32Array.from([
        -2, 2.1, 0.3, 2, 2.1, 0.3, 2, 2.1, 2, -2, 2.1, 0.3, 2, 2.1, 2, -2, 2.1, 2,
      ]),
      triangleCount: 2,
    });
    const cam = new ThirdPersonCamera(0, -25);
    for (let i = 0; i < 90; i++) cam.update(1 / 30, feet, fan);
    expect(cam.viewPitch).toBeGreaterThan(-25);
    expect(cam.position[1]).toBeLessThan(2.1);
    expect(cam.distance).toBeGreaterThan(DEFAULT_CAMERA.distance * 0.8);
  });

  it('keeps the player pitch in open space', () => {
    const open = new ThirdPersonCamera(0, -25);
    open.update(1, feet, null);
    expect(open.viewPitch).toBe(-25);
  });

  it('never ends a frame behind the wall, even on the first frame', () => {
    const cam = new ThirdPersonCamera(0, 0);
    cam.update(1 / 60, feet, wall);
    expect(cam.position[2]).toBeLessThan(1.5);
  });

  it('eases back out once the wall is gone', () => {
    const cam = new ThirdPersonCamera(0, 0);
    for (let i = 0; i < 60; i++) cam.update(1 / 30, feet, near);
    const pulled = cam.distance;
    cam.update(1 / 30, feet, null);
    expect(cam.distance).toBeGreaterThan(pulled);
    expect(cam.distance - pulled).toBeLessThan(0.1);
    for (let i = 0; i < 240; i++) cam.update(1 / 30, feet, null);
    expect(cam.distance).toBeCloseTo(DEFAULT_CAMERA.distance, 3);
  });

  it('clamps pitch', () => {
    const cam = new ThirdPersonCamera(0, 0);
    cam.look(0, -500);
    expect(cam.pitch).toBe(DEFAULT_CAMERA.minPitch);
    cam.look(0, 500);
    expect(cam.pitch).toBe(DEFAULT_CAMERA.maxPitch);
  });

  describe('seated', () => {
    // Sofa back / wall 0.4 m behind someone sitting at the origin facing -Z (facingYaw 0).
    const sofaBack = buildCollisionMesh({
      positions: Float32Array.from([
        -10, -1, 0.4, 10, -1, 0.4, 10, 10, 0.4, -10, -1, 0.4, 10, 10, 0.4, -10, 10, 0.4,
      ]),
      triangleCount: 2,
    });

    it('swings round to the front of the sitter, clear of the sofa back', () => {
      const cam = new ThirdPersonCamera(0, -15); // standing camera was behind (+Z), in the sofa
      cam.setSeated(0);
      for (let i = 0; i < 120; i++) cam.update(1 / 30, feet, sofaBack);
      expect(Math.abs(wrapDegrees(cam.yaw - 180))).toBeLessThan(3);
      expect(cam.position[2]).toBeLessThan(-1); // in front, in the room
      expect(cam.distance).toBeGreaterThan(DEFAULT_CAMERA.seatedDistance * 0.9);
      expect(cam.position[1]).toBeLessThan(DEFAULT_CAMERA.height + 0.6);
    });

    it('keeps the camera within the arc in front of the seat when the player looks round', () => {
      const cam = new ThirdPersonCamera(180, -15);
      cam.setSeated(0);
      for (let i = 0; i < 90; i++) cam.update(1 / 30, feet, sofaBack);
      cam.look(170, 0); // try to orbit behind the sofa
      for (let i = 0; i < 30; i++) cam.update(1 / 30, feet, sofaBack);
      expect(Math.abs(wrapDegrees(cam.yaw - 180))).toBeLessThanOrEqual(DEFAULT_CAMERA.seatedArc + 1e-6);
      expect(cam.position[2]).toBeLessThan(0.4 - DEFAULT_CAMERA.margin * 0.5);
    });

    it('picks a side angle when straight in front is blocked', () => {
      // Coffee-table-high block straight in front: a wall across x in [-0.3, 0.3] at z = -0.8.
      const table = buildCollisionMesh({
        positions: Float32Array.from([
          -0.3, -1, -0.8, 0.3, -1, -0.8, 0.3, 10, -0.8, -0.3, -1, -0.8, 0.3, 10, -0.8, -0.3, 10, -0.8,
        ]),
        triangleCount: 2,
      });
      const cam = new ThirdPersonCamera(0, -15);
      cam.setSeated(0);
      for (let i = 0; i < 120; i++) cam.update(1 / 30, feet, table);
      expect(Math.abs(wrapDegrees(cam.yaw - 180))).toBeGreaterThan(15);
      expect(cam.distance).toBeGreaterThan(DEFAULT_CAMERA.seatedDistance * 0.8);
    });

    it('goes back to the normal boom after standing up', () => {
      const cam = new ThirdPersonCamera(0, 0);
      cam.setSeated(0);
      for (let i = 0; i < 60; i++) cam.update(1 / 30, feet, null);
      expect(cam.seated).toBe(true);
      cam.setSeated(null);
      for (let i = 0; i < 300; i++) cam.update(1 / 30, feet, null);
      expect(cam.seated).toBe(false);
      expect(cam.distance).toBeCloseTo(DEFAULT_CAMERA.distance, 2);
      expect(cam.position[1]).toBeCloseTo(DEFAULT_CAMERA.height, 2);
    });
  });
});

describe('wrapDegrees', () => {
  it('wraps into (-180, 180]', () => {
    expect(wrapDegrees(190)).toBeCloseTo(-170);
    expect(wrapDegrees(-180)).toBe(180);
    expect(wrapDegrees(540)).toBe(180);
    expect(wrapDegrees(-30)).toBe(-30);
  });
});
