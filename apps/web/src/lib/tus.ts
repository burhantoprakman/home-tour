import type { ResumableUpload } from '@home-tour/shared';

/**
 * Minimal TUS 1.0 client for Supabase Storage resumable uploads (creation + PATCH chunks +
 * HEAD to resume). Supabase needs chunks of exactly `upload.chunkSize` bytes (last one shorter).
 * The upload URL is remembered in `storage` so a reload or a dropped connection resumes from
 * the server's offset instead of starting over.
 */

const TUS_VERSION = '1.0.0';

export class TusError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface TusFile {
  readonly size: number;
  readonly name?: string;
  readonly lastModified?: number;
  slice(start: number, end: number): Blob;
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface TusOptions {
  upload: ResumableUpload;
  file: TusFile;
  /** Auth headers (`authorization`, `apikey`), fetched per request so refreshed tokens apply. */
  headers: () => Promise<Record<string, string>>;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Delays before each retry of a failed request; retries reset after progress is made. */
  retryDelaysMs?: number[];
  fetch?: typeof fetch;
  storage?: KeyValueStore | null;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS = [0, 1000, 3000, 5000, 10000, 20000];

function utf8Base64(value: string): string {
  let bin = '';
  for (const byte of new TextEncoder().encode(value)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function metadataHeader(upload: ResumableUpload): string {
  return Object.entries({
    bucketName: upload.bucketName,
    objectName: upload.objectName,
    contentType: upload.contentType,
    cacheControl: '3600',
  })
    .map(([k, v]) => `${k} ${utf8Base64(v)}`)
    .join(',');
}

function resumeKey(upload: ResumableUpload, file: TusFile): string {
  return `tus:${upload.bucketName}/${upload.objectName}:${file.size}:${file.lastModified ?? 0}`;
}

function retryable(status: number): boolean {
  return status === 423 || status === 429 || status >= 500;
}

function readOffset(res: Response): number {
  const offset = Number(res.headers.get('upload-offset'));
  if (!Number.isInteger(offset) || offset < 0) throw new TusError('Bad Upload-Offset', res.status);
  return offset;
}

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Uploads (or resumes) `file` to the TUS target; resolves once the server has every byte. */
export async function tusUpload(opts: TusOptions): Promise<void> {
  const { upload, file, signal } = opts;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const key = resumeKey(upload, file);
  const remember = {
    get: () => {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (url: string) => {
      try {
        storage?.setItem(key, url);
      } catch {
        // Storage full or blocked: the upload still works, it just can't resume after reload.
      }
    },
    clear: () => {
      try {
        storage?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };

  const request = async (url: string, method: string, extra: Record<string, string>, body?: Blob) =>
    doFetch(url, {
      method,
      headers: { ...(await opts.headers()), 'tus-resumable': TUS_VERSION, ...extra },
      ...(body ? { body } : {}),
      ...(signal ? { signal } : {}),
    });

  /** Creates the upload; returns its URL. */
  const create = async (): Promise<string> => {
    const res = await request(upload.endpoint, 'POST', {
      'upload-length': String(file.size),
      'upload-metadata': metadataHeader(upload),
      'x-upsert': 'true',
    });
    if (res.status !== 201) throw new TusError(await failure(res, 'start the upload'), res.status);
    const location = res.headers.get('location');
    if (!location) throw new TusError('Upload has no Location', res.status);
    const url = new URL(location, upload.endpoint).toString();
    remember.set(url);
    return url;
  };

  /** The server's offset for `url`, or null if the upload is gone (expired or unknown). */
  const head = async (url: string): Promise<number | null> => {
    const res = await request(url, 'HEAD', {});
    if (res.status === 404 || res.status === 410 || res.status === 403) return null;
    if (!res.ok) throw new TusError(`Upload check failed (${res.status})`, res.status);
    return readOffset(res);
  };

  let url = remember.get();
  let offset: number | null = null;
  let attempt = 0;

  for (;;) {
    signal?.throwIfAborted();
    try {
      if (url && offset === null) {
        offset = await head(url);
        if (offset === null) {
          remember.clear();
          url = null;
        }
      }
      if (!url) {
        url = await create();
        offset = 0;
      }
      offset ??= 0;
      opts.onProgress?.(offset, file.size);
      if (offset >= file.size) break;

      const end = Math.min(offset + upload.chunkSize, file.size);
      const res = await request(
        url,
        'PATCH',
        { 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
        file.slice(offset, end),
      );
      if (res.status === 409) {
        offset = null; // offset mismatch: ask the server where it is
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        remember.clear();
        url = null;
        offset = null;
        continue;
      }
      if (res.status !== 204) throw new TusError(await failure(res, 'upload'), res.status);
      offset = readOffset(res);
      attempt = 0;
    } catch (err) {
      if (signal?.aborted) throw err;
      const status = err instanceof TusError ? err.status : undefined;
      // Network errors (no status) and server hiccups are retried; client errors are not.
      if (status !== undefined && !retryable(status)) throw err;
      const delay = delays[attempt++];
      if (delay === undefined) throw err;
      await sleep(delay);
      offset = null; // resync with HEAD before sending more
    }
  }
  remember.clear();
}

async function failure(res: Response, what: string): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    detail = String(body.message ?? body.error ?? '');
  } catch {
    // not JSON
  }
  if (res.status === 413) return 'This video is larger than the upload limit.';
  return `Could not ${what} (${res.status}${detail ? `: ${detail}` : ''})`;
}
