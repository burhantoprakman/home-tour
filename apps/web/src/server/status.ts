import { IdParam, type HomeStatusEvent } from '@home-tour/shared';
import { readHomeStatus } from './homes';
import { apiError, bearerToken } from './http';
import type { RouteDeps } from './rooms';

export interface StatusStreamOptions {
  /** Time between DB polls. */
  intervalMs: number;
  /** Polls per stream; the client reconnects (with a fresh token) after the stream ends. */
  maxPolls: number;
  /** Waits `ms`, resolving early when `signal` aborts (client disconnected). */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export const STATUS_STREAM_DEFAULTS: StatusStreamOptions = {
  intervalMs: 3000,
  maxPolls: 95, // ~4.75 minutes: stays under the route's maxDuration (300 s) with DB time
  sleep: abortableSleep,
};

/** True when no room will change without the owner acting (ready, failed, or no video yet). */
export function isSettled(event: HomeStatusEvent): boolean {
  return event.rooms.every(
    (r) => r.status === 'ready' || r.status === 'failed' || r.upload !== null,
  );
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * GET /api/homes/:id/status — server-sent events from `jobs`, by polling the DB server-side.
 * Events: `status` (HomeStatusEvent, sent when it changes), `done` (every room is ready,
 * failed or still waiting for its video; the stream closes), `error` ({ error }; the stream closes). Unchanged polls send a
 * `: ping` comment to keep proxies from timing out.
 */
export async function homeStatusStream(
  req: Request,
  params: unknown,
  deps: RouteDeps,
  opts: StatusStreamOptions = STATUS_STREAM_DEFAULTS,
): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const id = IdParam.safeParse(params);
  if (!id.success) return apiError(400, 'Invalid home id');

  const db = deps.db(token);
  // First poll before streaming, so auth/not-found errors are plain HTTP errors.
  const first = await readHomeStatus(db, id.data.id, deps.env);
  if (first instanceof Response) return first;

  const encoder = new TextEncoder();
  // Aborted when the client disconnects (req.signal) or the reader cancels the stream.
  const stop = new AbortController();
  if (req.signal.aborted) stop.abort();
  else req.signal.addEventListener('abort', () => stop.abort(), { once: true });
  const signal = stop.signal;
  const stopped = () => signal.aborted;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      try {
        let last = JSON.stringify(first);
        send('retry: 3000\n\n' + sseEvent('status', first));
        let settled = isSettled(first);
        for (let i = 1; i < opts.maxPolls && !settled; i++) {
          await opts.sleep(opts.intervalMs, signal);
          if (stopped()) return;
          const next = await readHomeStatus(db, id.data.id, deps.env);
          if (stopped()) return;
          if (next instanceof Response) {
            send(sseEvent('error', await next.json()));
            controller.close();
            return;
          }
          const text = JSON.stringify(next);
          if (text === last) {
            send(': ping\n\n');
          } else {
            last = text;
            send(sseEvent('status', next));
          }
          settled = isSettled(next);
        }
        if (settled) send(sseEvent('done', {}));
        controller.close();
      } catch (err) {
        // The client went away mid-write; nothing to clean up beyond stopping the loop.
        if (!stopped()) console.error('[api] status stream failed', err);
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
