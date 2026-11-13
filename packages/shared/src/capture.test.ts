import { describe, expect, it } from 'vitest';
import { CaptureDevice, CapturePose, CaptureObjects } from './capture.js';
import { roomCaptureBundlePath, roomDetailsVideoPath } from './api.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('capture contracts', () => {
  it('accepts a pose line as the app writes it', () => {
    const line = {
      pass: 'room',
      frame: 12,
      t: 0.4,
      transform: identity,
      fx: 1420.5,
      fy: 1420.5,
      cx: 958.1,
      cy: 718.9,
      width: 1920,
      height: 1440,
      tracking: 'limited',
      trackingReason: 'excessiveMotion',
      fast: true,
    };
    expect(CapturePose.parse(line)).toEqual(line);
  });

  it('rejects a malformed transform and unknown passes', () => {
    const base = { frame: 0, t: 0, fx: 1, fy: 1, cx: 0, cy: 0, width: 1, height: 1 };
    const ok = { ...base, pass: 'room', transform: identity, tracking: 'normal', fast: false };
    expect(CapturePose.safeParse(ok).success).toBe(true);
    expect(CapturePose.safeParse({ ...ok, transform: identity.slice(1) }).success).toBe(false);
    expect(CapturePose.safeParse({ ...ok, pass: 'garden' }).success).toBe(false);
  });

  it('parses objects and device', () => {
    expect(
      CaptureObjects.parse([{ id: 0, anchor: [1, 0.8, -2], start: 3, end: 18, sweptDeg: 131 }]),
    ).toHaveLength(1);
    expect(
      CaptureDevice.parse({
        model: 'iPhone15,4',
        systemVersion: '26.1',
        appVersion: '0.1',
        video: { width: 1920, height: 1440, fps: 30 },
        exposureLocked: true,
        lidar: false,
        floorY: -1.38,
      }).lidar,
    ).toBe(false);
  });

  it('builds storage paths next to the room video', () => {
    const id = '3f0c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f61';
    expect(roomDetailsVideoPath(id, 'mov')).toBe(`rooms/${id}/details.mov`);
    expect(roomCaptureBundlePath(id)).toBe(`rooms/${id}/capture.zip`);
  });
});
