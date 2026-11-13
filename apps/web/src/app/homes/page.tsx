'use client';

import type { CreateHomeResponse, ListHomesResponse } from '@home-tour/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthGate } from '../../components/AuthGate';
import styles from '../../components/ui.module.css';
import { api } from '../../lib/api';
import { supabase } from '../../lib/supabase';

function Homes({ email }: { email: string | undefined }) {
  const router = useRouter();
  const [homes, setHomes] = useState<ListHomesResponse['homes'] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ListHomesResponse>('/api/homes').then(
      (r) => setHomes(r.homes),
      (e: Error) => setError(e.message),
    );
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { homeId } = await api<CreateHomeResponse>('/api/homes', {
        method: 'POST',
        body: { name: name.trim() },
      });
      router.push(`/homes/${homeId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>My homes</h1>
        <button
          className={styles.link}
          onClick={() =>
            void supabase()
              .auth.signOut()
              .then(() => router.replace('/signin'))
          }
        >
          Sign out
        </button>
      </header>
      {email && <p className={styles.muted}>Signed in as {email}</p>}

      <section className={styles.card}>
        <h2>Your homes</h2>
        {homes === null ? (
          <p className={styles.muted}>Loading…</p>
        ) : homes.length === 0 ? (
          <p className={styles.muted}>No homes yet. Create your first one below.</p>
        ) : (
          <ul className={styles.list}>
            {homes.map((h) => (
              <li key={h.id} className={styles.row}>
                <Link className={styles.grow} href={`/homes/${h.id}`}>
                  {h.name}
                </Link>
                <span className={styles.muted}>
                  {h.roomCount} {h.roomCount === 1 ? 'room' : 'rooms'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.card}>
        <h2>New home</h2>
        <form className={styles.row} onSubmit={create}>
          <input
            className={`${styles.input} ${styles.grow}`}
            placeholder="e.g. Our flat"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Home name"
          />
          <button className={styles.primary} disabled={busy || !name.trim()}>
            Create
          </button>
        </form>
      </section>
      {error && <p className={styles.error}>{error}</p>}
    </main>
  );
}

export default function HomesPage() {
  return <AuthGate>{(session) => <Homes email={session.user.email} />}</AuthGate>;
}
