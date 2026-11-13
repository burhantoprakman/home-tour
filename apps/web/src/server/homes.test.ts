import { HomeDetail, ListHomesResponse } from '@home-tour/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDeps, request } from './fakes';
import { createHome, getHome, listHomes, saveFloorPlan } from './homes';
import { TUS_CHUNK_SIZE } from './rooms';

const HOME = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const ROOM_A = '6f1c2b7e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const ROOM_B = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';

const room = (id: string, name: string) => ({
  id,
  homeId: HOME,
  name,
  status: 'queued',
  splatUrl: null,
  collisionUrl: null,
  seats: [{ id: 'seat-1', position: [1, 0.45, -2], facingYaw: 0, confirmed: false }],
  transform: { position: [0, 0, 0], rotationYaw: 0, scale: 1 },
});
const progressRow = (roomId: string, enqueued: boolean) => ({
  roomId,
  status: 'queued',
  stage: 'queued',
  progress: 0,
  error: null,
  videoPath: `rooms/${roomId}/video.mov`,
  enqueued,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('GET /api/homes', () => {
  it("lists the caller's homes", async () => {
    const { deps, db } = fakeDeps({
      list_homes: { data: [{ id: HOME, name: 'Flat', room_count: 2 }], error: null },
    });
    const res = await listHomes(request('GET'), deps);
    expect(res.status).toBe(200);
    expect(ListHomesResponse.parse(await res.json())).toEqual({
      homes: [{ id: HOME, name: 'Flat', roomCount: 2 }],
    });
    expect(db).toHaveBeenCalledWith('user-jwt');
  });

  it('requires a token', async () => {
    const { deps } = fakeDeps({});
    expect((await listHomes(request('GET', undefined, null), deps)).status).toBe(401);
  });
});

describe('POST /api/homes', () => {
  it('creates a home with the trimmed name', async () => {
    const { deps, rpc } = fakeDeps({ create_home: { data: HOME, error: null } });
    const res = await createHome(request('POST', { name: '  Flat ' }), deps);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ homeId: HOME });
    expect(rpc).toHaveBeenCalledWith('create_home', { p_name: 'Flat' });
  });

  it.each([[{ name: '' }], [{}], ['nope']])('rejects %j', async (body) => {
    const { deps, rpc } = fakeDeps({});
    expect((await createHome(request('POST', body), deps)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps an expired session to 401', async () => {
    const { deps } = fakeDeps({
      create_home: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } },
    });
    expect((await createHome(request('POST', { name: 'Flat' }), deps)).status).toBe(401);
  });
});

describe('GET /api/homes/:id', () => {
  const home = {
    id: HOME,
    name: 'Flat',
    floorPlan: null,
    rooms: [room(ROOM_A, 'Living'), room(ROOM_B, 'Kitchen')],
    progress: [progressRow(ROOM_A, true), progressRow(ROOM_B, false)],
  };

  it('returns rooms + progress, with an upload target only for rooms still to upload', async () => {
    const { deps, rpc } = fakeDeps({ get_home: { data: home, error: null } });
    const res = await getHome(request('GET'), { id: HOME }, deps);
    expect(res.status).toBe(200);
    const body = HomeDetail.parse(await res.json());
    expect(rpc).toHaveBeenCalledWith('get_home', { p_home_id: HOME });
    expect(body.rooms.map((r) => r.name)).toEqual(['Living', 'Kitchen']);
    expect(body.progress[0]?.upload).toBeNull();
    expect(body.progress[1]?.upload).toEqual({
      protocol: 'tus',
      endpoint: 'https://example.supabase.co/storage/v1/upload/resumable',
      bucketName: 'room-videos',
      objectName: `rooms/${ROOM_B}/video.mov`,
      contentType: 'video/quicktime',
      chunkSize: TUS_CHUNK_SIZE,
    });
  });

  it('returns 404 for a home the caller does not own', async () => {
    const { deps } = fakeDeps({
      get_home: { data: null, error: { code: 'P0002', message: 'home not found' } },
    });
    expect((await getHome(request('GET'), { id: HOME }, deps)).status).toBe(404);
  });

  it('returns 500 for a malformed row instead of passing it on', async () => {
    const { deps } = fakeDeps({ get_home: { data: { ...home, rooms: 'x' }, error: null } });
    expect((await getHome(request('GET'), { id: HOME }, deps)).status).toBe(500);
  });

  it('rejects a non-uuid id', async () => {
    const { deps, db } = fakeDeps({});
    expect((await getHome(request('GET'), { id: '1' }, deps)).status).toBe(400);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('PUT /api/homes/:id/floor-plan', () => {
  const body = {
    floorPlan: {
      rooms: [
        { roomId: ROOM_A, x: 0, z: 0, rotationYaw: 0 },
        { roomId: ROOM_B, x: 5, z: 0, rotationYaw: Math.PI / 2 },
      ],
      spawn: { x: 0, z: 1, yaw: 0 },
      scale: 1.1,
    },
    seats: [{ roomId: ROOM_A, confirmedSeatIds: ['seat-1'] }],
  };

  it('saves the plan and seat confirmations in one RPC', async () => {
    const { deps, rpc } = fakeDeps({ save_floor_plan: { data: null, error: null } });
    const res = await saveFloorPlan(request('PUT', body), { id: HOME }, deps);
    expect(res.status).toBe(204);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('save_floor_plan', {
      p_home_id: HOME,
      p_plan: body.floorPlan,
      p_seats: body.seats,
    });
  });

  it.each([
    ['zero scale', { ...body, floorPlan: { ...body.floorPlan, scale: 0 } }],
    [
      'duplicate room',
      {
        ...body,
        floorPlan: { ...body.floorPlan, rooms: [body.floorPlan.rooms[0], body.floorPlan.rooms[0]] },
      },
    ],
    ['missing seats', { floorPlan: body.floorPlan }],
    ['non-uuid room', { ...body, seats: [{ roomId: 'x', confirmedSeatIds: [] }] }],
  ])('rejects %s with 400', async (_label, bad) => {
    const { deps, rpc } = fakeDeps({});
    expect((await saveFloorPlan(request('PUT', bad), { id: HOME }, deps)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps a room outside the home to 400', async () => {
    const { deps } = fakeDeps({
      save_floor_plan: { data: null, error: { code: '22023', message: 'outside this home' } },
    });
    expect((await saveFloorPlan(request('PUT', body), { id: HOME }, deps)).status).toBe(400);
  });
});
