'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import styles from '../../../components/ui.module.css';
import { supabase, takeNext } from '../../../lib/supabase';

/**
 * Magic-link and Google sign-in land here with `?code=` (PKCE). supabase-js exchanges the code
 * itself when the client starts (detectSessionInUrl); we wait for the session and move on.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const failure = params.get('error_description') ?? hash.get('error_description');
    if (failure) {
      setError(failure);
      return;
    }
    const auth = supabase().auth;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      router.replace(takeNext());
    };
    const { data } = auth.onAuthStateChange((_event, session) => {
      if (session) go();
    });
    void auth.getSession().then(({ data: { session }, error }) => {
      if (session) go();
      else if (error) setError(error.message);
    });
    const timeout = setTimeout(() => {
      if (!done)
        setError('This sign-in link is invalid or expired, or was opened in another browser.');
    }, 10000);
    return () => {
      clearTimeout(timeout);
      data.subscription.unsubscribe();
    };
  }, [router]);

  return (
    <main className={styles.page}>
      {error ? (
        <section className={styles.card}>
          <p className={styles.error}>{error}</p>
          <a className={styles.button} href="/signin">
            Try again
          </a>
        </section>
      ) : (
        <p>Signing you in…</p>
      )}
    </main>
  );
}
