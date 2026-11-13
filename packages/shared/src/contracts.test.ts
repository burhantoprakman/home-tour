import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  FloorPlan,
  Job,
  Room,
  STORAGE_BUCKETS,
  WorkerMeta,
  roomOutputPrefix,
} from './index.js';

const roomId = '6f1c2b7e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const homeId = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

describe('Room', () => {
  it('accepts a queued room with no files yet', () => {
    const room = {
      id: roomId,
      homeId,
      name: 'Living room',
      status: 'queued',
      splatUrl: null,
      collisionUrl: null,
      seats: [{ id: 'seat-1', position: [1, 0.45, -2], facingYaw: 1.57, confirmed: false }],
      transform: { position: [0, 0, 0], rotationYaw: 0, scale: 1 },
    };
    expect(Room.parse(room)).toEqual(room);
  });

  it('rejects an unknown status', () => {
    const result = Room.safeParse({ status: 'done' });
    expect(result.success).toBe(false);
  });
});

describe('FloorPlan', () => {
  it('rejects a non-positive scale', () => {
    const plan = { rooms: [], spawn: { x: 0, z: 0, yaw: 0 }, scale: 0 };
    expect(FloorPlan.safeParse(plan).success).toBe(false);
  });

  it('caps the number of rooms', () => {
    const room = { roomId, x: 0, z: 0, rotationYaw: 0 };
    const plan = { rooms: Array(101).fill(room), spawn: { x: 0, z: 0, yaw: 0 }, scale: 1 };
    expect(FloorPlan.safeParse(plan).success).toBe(false);
  });

  const door = {
    id: 'front',
    label: 'Front door',
    x: -8,
    z: 3,
    radius: 1,
    bell: true,
    to: { roomId, x: 37, z: -1, yaw: 2.8 },
  };

  it('keeps doors', () => {
    const plan = { rooms: [], spawn: { x: 0, z: 0, yaw: 0 }, scale: 1, doors: [door] };
    expect(FloorPlan.parse(plan)).toEqual(plan);
  });

  it('accepts a plan without doors', () => {
    const plan = { rooms: [], spawn: { x: 0, z: 0, yaw: 0 }, scale: 1 };
    expect(FloorPlan.parse(plan)).toEqual(plan);
  });

  it('rejects a door without a target room', () => {
    const plan = {
      rooms: [],
      spawn: { x: 0, z: 0, yaw: 0 },
      scale: 1,
      doors: [{ ...door, to: { ...door.to, roomId: 'nope' } }],
    };
    expect(FloorPlan.safeParse(plan).success).toBe(false);
  });
});

describe('ClientMessage', () => {
  it.each([
    { type: 'transform', position: [0, 0, 1], yaw: 0.5 },
    { type: 'anim', state: 'walk' },
    { type: 'anim', state: 'emote:wave' },
    { type: 'seatClaim', seatId: 'seat-1' },
    { type: 'seatRelease', seatId: 'seat-1' },
    { type: 'chat', text: 'hi!' },
  ])('accepts $type', (msg) => {
    expect(ClientMessage.safeParse(msg).success).toBe(true);
  });

  it.each([
    { type: 'anim', state: 'dance' },
    { type: 'anim', state: 'emote:' },
    { type: 'anim', state: 'emote:Big Wave!' },
    { type: 'chat', text: '   ' },
    { type: 'chat', text: 'x'.repeat(201) },
    { type: 'teleport' },
  ])('rejects %j', (msg) => {
    expect(ClientMessage.safeParse(msg).success).toBe(false);
  });
});

describe('WorkerMeta', () => {
  it('requires an integer gaussian count', () => {
    expect(WorkerMeta.safeParse({ gaussianCount: 1.5, floorY: 0, scale: 1 }).success).toBe(false);
  });
});

describe('Job', () => {
  const job = {
    id: roomId,
    roomId,
    status: 'training',
    stage: 'train',
    progress: 0.4,
    error: null,
    gpuSeconds: 12.5,
    stageTimings: { frames: 83, solve: 310 },
  };

  it('accepts a running job', () => {
    expect(Job.parse(job)).toEqual(job);
  });

  it('rejects progress outside 0..1 and unknown stages', () => {
    expect(Job.safeParse({ ...job, progress: 1.2 }).success).toBe(false);
    expect(Job.safeParse({ ...job, stage: 'render' }).success).toBe(false);
  });

  it('builds per-variant storage prefixes', () => {
    expect(roomOutputPrefix(roomId, 'preview')).toBe(`rooms/${roomId}/preview`);
    expect(STORAGE_BUCKETS.files).toBe('room-files');
  });
});
