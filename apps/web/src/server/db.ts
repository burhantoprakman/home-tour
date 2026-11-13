import { createClient } from '@supabase/supabase-js';
import type { ServerEnv } from './env';

export interface DbError {
  code?: string;
  message: string;
}

/** The slice of the Supabase client the routes use: Postgres functions, run as the caller. */
export interface UserDb {
  rpc<T>(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: T | null; error: DbError | null }>;
}

/**
 * A Supabase client acting as the signed-in user (their access token), so RLS and auth.uid()
 * apply; with a null token, as anon (guests resolving an invite). Uses the anon key only; the
 * service role key is never used by the web app.
 */
export function userDb(env: ServerEnv, accessToken: string | null): UserDb {
  const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    global: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    rpc: <T>(fn: string, args: Record<string, unknown>) =>
      client.rpc(fn, args) as unknown as PromiseLike<{ data: T | null; error: DbError | null }>,
  };
}
