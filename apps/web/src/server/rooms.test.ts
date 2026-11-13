import { CreateRoomResponse, RoomUploadedResponse } from '@home-tour/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbError, UserDb } from './db';
import type { JobEnqueuer } from './enqueue';
import { createRoom, roomUploaded, TUS_CHUNK_SIZE, type RouteDeps } from './rooms';

const HOME = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const ROOM = '6f1c2b7e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const JOB = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
const VIDEO = `rooms/${ROOM}/video.mov`;

type RpcResult = { data: unknown; error: DbError | null };

function setup(results: Record<string, RpcResult>) {
  const rpc = vi.fn(
    async (fn: string) => results[fn] ?? { data: null, error: { message: `no fake for ${fn}` } },
  );
  const db = vi.fn((): UserDb => ({ rpc: rpc as UserDb['rpc'] }));
  const enqueue = vi.fn<JobEnqueuer['enqueue']>(async () => undefined);
  const deps: RouteDeps = {
    env: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon',
      ticketSecret: null,
      realtimeUrl: 'ws://realtime.test',
    },
    db,
    enqueuer: { enqueue },
  };
  return { deps, db, rpc, enqueue };
}

function post(body: unknown, token: string | null = 'user-jwt'): Request {
  return new Request('http://localhost/api', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/homes/:id/rooms', () => {
  const created = { data: [{ room_id: ROOM, job_id: JOB, video_path: VIDEO }], error: null };

  it('creates the room + job as the caller and returns a TUS target', async () => {
    const { deps, db, rpc } = setup({ create_room: created });
    const res = await createRoom(
      post({ name: 'Living room', contentType: 'video/quicktime' }),
      { id: HOME },
      deps,
    );

    expect(res.status).toBe(201);
    const body = CreateRoomResponse.parse(await res.json());
    expect(body).toEqual({
      roomId: ROOM,
      jobId: JOB,
      upload: {
        protocol: 'tus',
        endpoint: 'https://example.supabase.co/storage/v1/upload/resumable',
        bucketName: 'room-videos',
        objectName: VIDEO,
        contentType: 'video/quicktime',
        chunkSize: TUS_CHUNK_SIZE,
      },
    });
    expect(db).toHaveBeenCalledWith('user-jwt');
    expect(rpc).toHaveBeenCalledWith('create_room', {
      p_home_id: HOME,
      p_name: 'Living room',
      p_video_ext: 'mov',
    });
  });

  it.each([
    ['empty name', { name: '', contentType: 'video/mp4' }],
    ['unsupported type', { name: 'Kitchen', contentType: 'image/gif' }],
    ['missing fields', {}],
    ['non-JSON body', 'not json'],
  ])('rejects %s with 400', async (_label, body) => {
    const { deps, rpc } = setup({ create_room: created });
    const res = await createRoom(post(body), { id: HOME }, deps);
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid home id with 400', async () => {
    const { deps } = setup({ create_room: created });
    const res = await createRoom(
      post({ name: 'Kitchen', contentType: 'video/mp4' }),
      { id: 'nope' },
      deps,
    );
    expect(res.status).toBe(400);
  });

  it('requires a bearer token', async () => {
    const { deps, db } = setup({ create_room: created });
    const res = await createRoom(
      post({ name: 'Kitchen', contentType: 'video/mp4' }, null),
      { id: HOME },
      deps,
    );
    expect(res.status).toBe(401);
    expect(db).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller does not own the home', async () => {
    const { deps } = setup({
      create_room: { data: null, error: { code: 'P0002', message: 'home not found' } },
    });
    const res = await createRoom(
      post({ name: 'Kitchen', contentType: 'video/mp4' }),
      { id: HOME },
      deps,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 for an expired token', async () => {
    const { deps } = setup({
      create_room: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } },
    });
    const res = await createRoom(
      post({ name: 'Kitchen', contentType: 'video/mp4' }),
      { id: HOME },
      deps,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/rooms/:id/uploaded', () => {
  const claimed = { data: [{ job_id: JOB, room_id: ROOM, video_path: VIDEO }], error: null };

  it('claims the job and spawns process_room once', async () => {
    const { deps, rpc, enqueue } = setup({ claim_room_upload: claimed });
    const res = await roomUploaded(post({}), { id: ROOM }, deps);

    expect(res.status).toBe(202);
    expect(RoomUploadedResponse.parse(await res.json())).toEqual({ roomId: ROOM, jobId: JOB });
    expect(rpc).toHaveBeenCalledWith('claim_room_upload', { p_room_id: ROOM });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({ jobId: JOB, roomId: ROOM, videoPath: VIDEO });
  });

  it('returns 404 for a room the caller does not own', async () => {
    const { deps, enqueue } = setup({
      claim_room_upload: { data: null, error: { code: 'P0002', message: 'room not found' } },
    });
    const res = await roomUploaded(post({}), { id: ROOM }, deps);
    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns 409 when the video is missing or the job was already enqueued', async () => {
    const { deps, enqueue } = setup({
      claim_room_upload: { data: null, error: { code: '55000', message: 'job already enqueued' } },
    });
    const res = await roomUploaded(post({}), { id: ROOM }, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'job already enqueued' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid room id and a missing token', async () => {
    const { deps, db } = setup({ claim_room_upload: claimed });
    expect((await roomUploaded(post({}), { id: '1' }, deps)).status).toBe(400);
    expect((await roomUploaded(post({}, null), { id: ROOM }, deps)).status).toBe(401);
    expect(db).not.toHaveBeenCalled();
  });

  it('releases the claim and returns 503 when the spawn fails', async () => {
    const { deps, rpc, enqueue } = setup({
      claim_room_upload: claimed,
      release_room_upload: { data: null, error: null },
    });
    enqueue.mockRejectedValueOnce(new Error('modal down'));
    const res = await roomUploaded(post({}), { id: ROOM }, deps);
    expect(res.status).toBe(503);
    expect(rpc).toHaveBeenLastCalledWith('release_room_upload', { p_job_id: JOB });
  });
});
