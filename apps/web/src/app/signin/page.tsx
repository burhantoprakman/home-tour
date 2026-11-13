'use client';

import { useState, type FormEvent } from 'react';
import styles from '../../components/ui.module.css';
import { supabase } from '../../lib/supabase';

function callbackUrl(): string {
  return `${window.location.origin}/auth/callback`;
}

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendLink(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl(), shouldCreateUser: true },
    });
    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function google() {
    setError(null);
    const { error } = await supabase().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callbackUrl() },
    });
    if (error) setError(error.message);
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Sign in to Home Tour</h1>
      </header>
      <section className={styles.card}>
        {sent ? (
          <div className={styles.stack}>
            <p>
              Check <strong>{email}</strong> for a sign-in link. Open it in this browser.
            </p>
            <button className={styles.link} onClick={() => setSent(false)}>
              Use a different email
            </button>
          </div>
        ) : (
          <form className={styles.stack} onSubmit={sendLink}>
            <label className={styles.stack}>
              <span>Email</span>
              <input
                className={styles.input}
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <button className={styles.primary} disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </form>
        )}
      </section>
      <section className={styles.card}>
        <button className={styles.button} style={{ width: '100%' }} onClick={google}>
          Continue with Google
        </button>
      </section>
      {error && <p className={styles.error}>{error}</p>}
      <p className={styles.muted}>New here? Either option creates your account.</p>
    </main>
  );
}
