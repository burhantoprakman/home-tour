import type { ResumableUpload } from '@home-tour/shared';
import { describe, expect, it, vi } from 'vitest';
import { TusError, tusUpload } from './tus';

const upload: ResumableUpload = {
  protocol: 'tus',
  endpoint: 'https://example.supabase.co/storage/v1/upload/resumable',
  bucketName: 'room-videos',
  objectName: 'rooms/r/video.mp4',
  contentType: 'video/mp4',
  chunkSize: 4,
};

const file = (size: number) =>
  Object.assign(new Blob([new Uint8Array(size).map((_, i) => i)]), {
    name: 'v.mp4',
    lastModified: 1,
  });

/** An in-memory TUS server; `fail` lets a test break specific requests. */
function fakeServer(fail?: (method: string, n: number) => Response | Error | undefined) {
  const uploads = new Map<string, { length: number; bytes: number[] }>();
  const log: string[] = [];
  let n = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const h = new Headers(init?.headers);
    log.push(method);
    const broken = fail?.(method, ++n);
    if (broken instanceof Error) throw broken;
    if (broken) return broken;
    expect(h.get('tus-resumable')).toBe('1.0.0');
    expect(h.get('authorization')).toBe('Bearer t');
    if (method === 'POST') {
      expect(h.get('x-upsert')).toBe('true');
      expect(h.get('upload-metadata')).toContain(`objectName ${btoa(upload.objectName)}`);
      const id = `${uploads.size + 1}`;
      uploads.set(id, { length: Number(h.get('upload-length')), bytes: [] });
      return new Response(null, { status: 201, headers: { location: `resumable/${id}` } });
    }
    const up = uploads.get(url.split('/').pop() ?? '');
    if (!up) return new Response(null, { status: 404 });
    if (method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { 'upload-offset': `${up.bytes.length}` },
      });
    }
    if (Number(h.get('upload-offset')) !== up.bytes.length)
      return new Response(null, { status: 409 });
    const chunk = new Uint8Array(await (init?.body as Blob).arrayBuffer());
    up.bytes.push(...chunk);
    return new Response(null, { status: 204, headers: { 'upload-offset': `${up.bytes.length}` } });
  });
  return { fetch, uploads, log };
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

const base = {
  upload,
  headers: async () => ({ authorization: 'Bearer t', apikey: 'anon' }),
  sleep: async () => undefined,
};

describe('tusUpload', () => {
  it('creates the upload and sends exact-size chunks', async () => {
    const server = fakeServer();
    const progress: number[] = [];
    const storage = memoryStorage();
    await tusUpload({
      ...base,
      file: file(10),
      fetch: server.fetch,
      storage,
      onProgress: (sent) => progress.push(sent),
    });
    expect(server.log).toEqual(['POST', 'PATCH', 'PATCH', 'PATCH']);
    expect(server.uploads.get('1')?.bytes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(server.fetch.mock.calls[1]?.[0]).toBe(
      'https://example.supabase.co/storage/v1/upload/resumable/1',
    );
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(storage.m.size).toBe(0); // finished uploads are forgotten
  });

  it('resumes a remembered upload from the server offset', async () => {
    const storage = memoryStorage();
    const first = fakeServer((method, n) => (n === 3 ? new Error('offline') : undefined));
    await expect(
      tusUpload({ ...base, file: file(10), fetch: first.fetch, storage, retryDelaysMs: [] }),
    ).rejects.toThrow('offline');
    expect(storage.m.size).toBe(1);

    // Same server state, new page load: HEAD then only the missing chunks.
    const second = fakeServer();
    second.uploads.set('1', first.uploads.get('1') ?? { length: 10, bytes: [] });
    await tusUpload({ ...base, file: file(10), fetch: second.fetch, storage });
    expect(second.log).toEqual(['HEAD', 'PATCH', 'PATCH']);
    expect(second.uploads.get('1')?.bytes).toHaveLength(10);
  });

  it('retries network errors and 5xx, resyncing with HEAD', async () => {
    const server = fakeServer((method, n) =>
      n === 2 ? new Error('reset') : n === 4 ? new Response(null, { status: 503 }) : undefined,
    );
    await tusUpload({ ...base, file: file(6), fetch: server.fetch, storage: null });
    expect(server.log).toEqual(['POST', 'PATCH', 'HEAD', 'PATCH', 'HEAD', 'PATCH', 'PATCH']);
    expect(server.uploads.get('1')?.bytes).toHaveLength(6);
  });

  it('starts over when the remembered upload expired', async () => {
    const storage = memoryStorage();
    storage.setItem('tus:room-videos/rooms/r/video.mp4:6:1', `${upload.endpoint}/gone`);
    const server = fakeServer();
    await tusUpload({ ...base, file: file(6), fetch: server.fetch, storage });
    expect(server.log).toEqual(['HEAD', 'POST', 'PATCH', 'PATCH']);
  });

  it('does not retry client errors', async () => {
    const server = fakeServer((method) =>
      method === 'POST' ? Response.json({ message: 'denied' }, { status: 403 }) : undefined,
    );
    const err = await tusUpload({
      ...base,
      file: file(6),
      fetch: server.fetch,
      storage: null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TusError);
    expect((err as TusError).status).toBe(403);
    expect(server.log).toEqual(['POST']);
  });
});
