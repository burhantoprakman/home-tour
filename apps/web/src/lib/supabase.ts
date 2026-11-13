'use client';

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

// Inlined at build time. Only the public URL + anon key reach the browser.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

let client: SupabaseClient | null = null;

/**
 * The browser Supabase client, used only for auth. The session lives in localStorage
 * (supabase-js default); API routes get the access token as `Authorization: Bearer`.
 * PKCE: the magic link / Google redirect must open in the browser that asked for it.
 */
export function supabase(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set');
  }
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}

/** Headers that authenticate the signed-in user to our API and to Supabase Storage. */
export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');
  return { authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY };
}

/** The current session: undefined while loading, null when signed out. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    const auth = supabase().auth;
    let live = true;
    void auth.getSession().then(({ data }) => {
      if (live) setSession(data.session);
    });
    const { data } = auth.onAuthStateChange((_event, s) => setSession(s));
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);
  return session;
}

const NEXT_KEY = 'home-tour:after-sign-in';

/** Only same-site paths, so a crafted link can't bounce the user elsewhere after sign-in. */
export function safeNext(path: string | null | undefined): string {
  return path && path.startsWith('/') && !path.startsWith('//') ? path : '/homes';
}

export function rememberNext(path: string): void {
  try {
    sessionStorage.setItem(NEXT_KEY, safeNext(path));
  } catch {
    // ignore
  }
}

export function takeNext(): string {
  try {
    const next = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return safeNext(next);
  } catch {
    return '/homes';
  }
}
