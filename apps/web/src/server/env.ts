/** Server-side settings, read per request so `next build` needs no secrets. */
export interface ServerEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Signs realtime join tickets (same value as apps/realtime). Visits fail with 500 without it. */
  ticketSecret: string | null;
  realtimeUrl: string;
}

export function serverEnv(): ServerEnv {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
  }
  const ticketSecret = process.env.REALTIME_TICKET_SECRET ?? '';
  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    supabaseAnonKey,
    ticketSecret: ticketSecret.length >= 32 ? ticketSecret : null,
    realtimeUrl: process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://localhost:2567',
  };
}
