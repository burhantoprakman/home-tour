import { describe, expect, it, vi } from 'vitest';
import { fakeDeps, request } from './fakes';
import { homeStatusStream, type StatusStreamOptions } from './status';

const HOME = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const ROOM = '6f1c2b7e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';

const status = (s: string, stage: string, progress: number) => ({
  data: {
    rooms: [
      {
        roomId: ROOM,
        status: s,
        stage,
        progress,
        error: null,
        videoPath: `rooms/${ROOM}/video.mp4`,
        enqueued: true,
      },
    ],
  },
  error: null,
});

const opts = (maxPolls: number): StatusStreamOptions => ({
  intervalMs: 1,
  maxPolls,
  sleep: vi.fn(async () => undefined),
});

/** The stream's events as [event, data] pairs; pings as ['ping', null]. */
async function events(res: Response): Promise<[string, unknown][]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block && !block.startsWith('retry:'))
    .map((block) => {
      if (block.startsWith(': ping')) return ['ping', null];
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return [event, data ? JSON.parse(data) : null];
    });
}

describe('GET /api/homes/:id/status', () => {
  it('streams status changes, pings when unchanged and ends with done', async () => {
    const { deps, rpc } = fakeDeps({
      home_status: [
        status('training', 'train', 0.2),
        status('training', 'train', 0.2),
        status('preview', 'train', 0.5),
        status('ready', 'done', 1),
      ],
    });
    const res = await homeStatusStream(request('GET'), { id: HOME }, deps, opts(10));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const evs = await events(res);
    expect(evs.map(([e]) => e)).toEqual(['status', 'ping', 'status', 'status', 'done']);
    expect(evs[3]?.[1]).toMatchObject({ rooms: [{ status: 'ready', upload: null }] });
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(rpc).toHaveBeenCalledWith('home_status', { p_home_id: HOME });
  });

  it('closes after maxPolls without done so the client reconnects', async () => {
    const { deps, rpc } = fakeDeps({ home_status: status('training', 'train', 0.2) });
    const evs = await events(await homeStatusStream(request('GET'), { id: HOME }, deps, opts(3)));
    expect(evs.map(([e]) => e)).toEqual(['status', 'ping', 'ping']);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('returns plain HTTP errors before streaming', async () => {
    const { deps } = fakeDeps({
      home_status: { data: null, error: { code: 'P0002', message: 'home not found' } },
    });
    expect((await homeStatusStream(request('GET'), { id: HOME }, deps, opts(3))).status).toBe(404);
    expect(
      (await homeStatusStream(request('GET', undefined, null), { id: HOME }, deps, opts(3))).status,
    ).toBe(401);
    expect((await homeStatusStream(request('GET'), { id: 'x' }, deps, opts(3))).status).toBe(400);
  });

  it('sends an error event and closes when a later poll fails', async () => {
    const { deps } = fakeDeps({
      home_status: [
        status('training', 'train', 0.2),
        { data: null, error: { code: 'PGRST301', message: 'JWT expired' } },
      ],
    });
    const evs = await events(await homeStatusStream(request('GET'), { id: HOME }, deps, opts(10)));
    expect(evs).toEqual([
      ['status', expect.anything()],
      ['error', { error: 'Sign in again' }],
    ]);
  });
});

describe('isSettled', () => {
  it('treats rooms still waiting for their video as settled', async () => {
    const { isSettled } = await import('./status');
    const room = { roomId: ROOM, stage: 'queued', progress: 0, error: null } as const;
    const upload = {
      protocol: 'tus',
      endpoint: 'https://e.co/u',
      bucketName: 'b',
      objectName: 'o',
      contentType: 'video/mp4',
      chunkSize: 1,
    } as const;
    expect(isSettled({ rooms: [{ ...room, status: 'queued', upload }] })).toBe(true);
    expect(isSettled({ rooms: [{ ...room, status: 'queued', upload: null }] })).toBe(false);
    expect(isSettled({ rooms: [{ ...room, status: 'ready', upload: null }] })).toBe(true);
  });
});

describe('status stream shutdown', () => {
  it('wakes from the poll sleep and ends when the client disconnects', async () => {
    const { STATUS_STREAM_DEFAULTS } = await import('./status');
    const { deps, rpc } = fakeDeps({ home_status: status('training', 'train', 0.2) });
    const client = new AbortController();
    const req = new Request('http://localhost/api', {
      headers: { authorization: 'Bearer user-jwt' },
      signal: client.signal,
    });
    const res = await homeStatusStream(req, { id: HOME }, deps, {
      ...STATUS_STREAM_DEFAULTS,
      intervalMs: 60_000,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // first status event
    const started = Date.now();
    client.abort();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(rpc).toHaveBeenCalledTimes(1); // no poll after the disconnect
  });
});
