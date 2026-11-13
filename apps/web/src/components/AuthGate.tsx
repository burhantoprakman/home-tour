'use client';

import type { Session } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { rememberNext, useSession } from '../lib/supabase';
import styles from './ui.module.css';

/** Renders children for a signed-in user; sends everyone else to /signin and back here after. */
export function AuthGate({ children }: { children: (session: Session) => ReactNode }) {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session === null) {
      rememberNext(window.location.pathname);
      router.replace('/signin');
    }
  }, [session, router]);
  if (!session) return <main className={styles.page}>Loading…</main>;
  return <>{children(session)}</>;
}
