// Test helpers: fake RouteDeps whose db answers RPCs from a table of canned results.
import { vi } from 'vitest';
import type { DbError, UserDb } from './db';
import type { JobEnqueuer } from './enqueue';
import type { RouteDeps } from './rooms';

export type RpcResult = { data: unknown; error: DbError | null };
type Results = Record<string, RpcResult | RpcResult[]>;

/** Each RPC answers with its result, or with successive results when given an array. */
export function fakeDeps(results: Results) {
  const calls: Record<string, number> = {};
  const rpc = vi.fn(async (fn: string) => {
    const r = results[fn];
    const n = (calls[fn] = (calls[fn] ?? 0) + 1);
    if (Array.isArray(r)) return r[Math.min(n, r.length) - 1] ?? { data: null, error: null };
    return r ?? { data: null, error: { message: `no fake for ${fn}` } };
  });
  const db = vi.fn((): UserDb => ({ rpc: rpc as UserDb['rpc'] }));
  const enqueue = vi.fn<JobEnqueuer['enqueue']>(async () => undefined);
  const deps: RouteDeps = {
    env: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon',
      ticketSecret: 't'.repeat(40),
      realtimeUrl: 'ws://realtime.test',
    },
    db,
    enqueuer: { enqueue },
  };
  return { deps, db, rpc, enqueue };
}

export function request(
  method: string,
  body?: unknown,
  token: string | null = 'user-jwt',
): Request {
  return new Request('http://localhost/api', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
