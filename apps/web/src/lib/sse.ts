/** Server-sent events over fetch (EventSource can't send an Authorization header). */

export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental SSE parser: feed text chunks, get complete messages (comments are dropped). */
export function createSseParser(): (chunk: string) => SseMessage[] {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    const out: SseMessage[] = [];
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) out.push({ event, data: data.join('\n') });
    }
    return out;
  };
}

export interface SubscribeOptions {
  url: string;
  headers: () => Promise<Record<string, string>>;
  onMessage: (msg: SseMessage) => void;
  /** Called when the stream ended or a network/server error broke it; true = reconnect. */
  shouldReconnect: (reason: 'ended' | 'error') => boolean;
  /** Refreshes the session after a 401; tried once per failure run before giving up. */
  refreshSession?: () => Promise<void>;
  /** Called when the server refused the stream for good (4xx); no reconnect follows. */
  onStop?: (status: number) => void;
  reconnectMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`status stream ${status}`);
  }
}

/**
 * Reads the stream until `signal` aborts, reconnecting (with fresh headers) when the server
 * closes it. Stops on 4xx: a 401 first refreshes the session and retries once.
 */
export async function runSse(opts: SubscribeOptions, signal: AbortSignal): Promise<void> {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let refreshed = false;
  while (!signal.aborted) {
    let reason: 'ended' | 'error' = 'ended';
    try {
      const res = await doFetch(opts.url, {
        headers: { accept: 'text/event-stream', ...(await opts.headers()) },
        signal,
        cache: 'no-store',
      });
      if (!res.ok || !res.body) throw new HttpStatusError(res.status);
      refreshed = false;
      const parse = createSseParser();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parse(value)) opts.onMessage(msg);
      }
    } catch (err) {
      if (signal.aborted) return;
      const status = err instanceof HttpStatusError ? err.status : 0;
      if (status === 401 && !refreshed && opts.refreshSession) {
        refreshed = true;
        try {
          await opts.refreshSession();
          continue;
        } catch {
          // fall through: stop below
        }
      }
      if (status >= 400 && status < 500) {
        opts.onStop?.(status);
        return;
      }
      reason = 'error';
    }
    if (signal.aborted || !opts.shouldReconnect(reason)) return;
    await sleep(opts.reconnectMs ?? 3000);
  }
}

/** Starts `runSse` in the background; returns a function that stops it. */
export function subscribeSse(opts: SubscribeOptions): () => void {
  const controller = new AbortController();
  void runSse(opts, controller.signal);
  return () => controller.abort();
}
