'use client';

import { InvitePreview, VisitResponse, type VisitRequest } from '@home-tour/shared';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CharacterPicker } from '../../../components/CharacterPicker';
import styles from '../../../components/ui.module.css';
import { VisitView } from '../../../components/VisitView';

async function call<T>(url: string, parse: (v: unknown) => T, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return parse(json);
}

/** GET /join/:token — guests pick a name and character, then walk in. No account needed. */
export default function JoinPage() {
  const { token } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [visit, setVisit] = useState<{ res: VisitResponse; choice: VisitRequest } | null>(null);

  useEffect(() => {
    call(`/api/join/${token}`, (v) => InvitePreview.parse(v)).then(setPreview, (e: Error) =>
      setError(e.message),
    );
  }, [token]);

  async function enter(choice: VisitRequest) {
    setBusy(true);
    setError(null);
    try {
      const res = await call(`/api/join/${token}`, (v) => VisitResponse.parse(v), choice);
      setVisit({ res, choice });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (visit)
    return <VisitView visit={visit.res} choice={visit.choice} onLeave={() => setVisit(null)} />;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>{preview ? `Visit ${preview.homeName}` : 'Home Tour'}</h1>
      </header>
      <section className={styles.card}>
        {preview ? (
          <CharacterPicker busy={busy} submitLabel="Walk in" onSubmit={(c) => void enter(c)} />
        ) : (
          !error && <p className={styles.muted}>Opening the invite…</p>
        )}
        {error && <p className={styles.error}>{error}</p>}
      </section>
    </main>
  );
}
