import { describe, expect, it } from 'vitest';
import {
  CreateHomeRequest,
  CreateRoomRequest,
  IdParam,
  SaveFloorPlanRequest,
  roomVideoPath,
} from './index.js';

describe('CreateRoomRequest', () => {
  it('accepts a named room with a supported video type', () => {
    const body = { name: 'Living room', contentType: 'video/quicktime' };
    expect(CreateRoomRequest.parse(body)).toEqual(body);
  });

  it.each([
    { name: '', contentType: 'video/mp4' },
    { name: 'x'.repeat(61), contentType: 'video/mp4' },
    { name: 'Kitchen', contentType: 'image/png' },
    { name: 'Kitchen' },
  ])('rejects %j', (body) => {
    expect(CreateRoomRequest.safeParse(body).success).toBe(false);
  });
});

describe('roomVideoPath', () => {
  it('matches the worker video_path layout', () => {
    expect(roomVideoPath('6f1c2b7e-3d4a-4b5c-8d9e-0a1b2c3d4e5f', 'mov')).toBe(
      'rooms/6f1c2b7e-3d4a-4b5c-8d9e-0a1b2c3d4e5f/video.mov',
    );
  });

  it('rejects non-uuid ids', () => {
    expect(IdParam.safeParse({ id: 'abc' }).success).toBe(false);
  });
});

describe('CreateHomeRequest', () => {
  it('trims the name and rejects blank ones', () => {
    expect(CreateHomeRequest.parse({ name: '  Our flat ' })).toEqual({ name: 'Our flat' });
    expect(CreateHomeRequest.safeParse({ name: '   ' }).success).toBe(false);
  });
});

describe('SaveFloorPlanRequest', () => {
  const a = '6f1c2b7e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
  const b = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
  const plan = (ids: string[]) => ({
    rooms: ids.map((roomId, i) => ({ roomId, x: i * 5, z: 0, rotationYaw: 0 })),
    spawn: { x: 0, z: 0, yaw: 0 },
    scale: 1,
  });

  it('accepts a two-room plan with seat confirmations', () => {
    const body = { floorPlan: plan([a, b]), seats: [{ roomId: a, confirmedSeatIds: ['seat-1'] }] };
    expect(SaveFloorPlanRequest.parse(body)).toEqual(body);
  });

  it('rejects a room placed twice', () => {
    expect(SaveFloorPlanRequest.safeParse({ floorPlan: plan([a, a]), seats: [] }).success).toBe(
      false,
    );
  });

  it('rejects non-finite coordinates', () => {
    const body = { floorPlan: { ...plan([a]), spawn: { x: Infinity, z: 0, yaw: 0 } }, seats: [] };
    expect(SaveFloorPlanRequest.safeParse(body).success).toBe(false);
  });
});
