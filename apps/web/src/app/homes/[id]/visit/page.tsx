'use client';

import type { VisitRequest, VisitResponse } from '@home-tour/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AuthGate } from '../../../../components/AuthGate';
import { CharacterPicker } from '../../../../components/CharacterPicker';
import styles from '../../../../components/ui.module.css';
import { VisitView } from '../../../../components/VisitView';
import { api } from '../../../../lib/api';

function OwnerVisit({ homeId }: { homeId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visit, setVisit] = useState<{ res: VisitResponse; choice: VisitRequest } | null>(null);

  async function enter(choice: VisitRequest) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<VisitResponse>(`/api/homes/${homeId}/visit`, {
        method: 'POST',
        body: choice,
      });
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
        <h1>Visit your home</h1>
        <Link href={`/homes/${homeId}`}>Back</Link>
      </header>
      <section className={styles.card}>
        <CharacterPicker busy={busy} submitLabel="Walk in" onSubmit={(c) => void enter(c)} />
        {error && <p className={styles.error}>{error}</p>}
      </section>
    </main>
  );
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  return <OwnerVisit homeId={id} />;
}

export default function OwnerVisitPage() {
  return <AuthGate>{() => <Inner />}</AuthGate>;
}
