'use client';

import type { HomeDetail } from '@home-tour/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthGate } from '../../../../components/AuthGate';
import { FloorPlanEditor } from '../../../../components/FloorPlanEditor';
import styles from '../../../../components/ui.module.css';
import { api } from '../../../../lib/api';

function PlanView() {
  const { id } = useParams<{ id: string }>();
  const [home, setHome] = useState<HomeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<HomeDetail>(`/api/homes/${id}`).then(setHome, (e: Error) => setError(e.message));
  }, [id]);

  return (
    <main className={styles.page} style={{ maxWidth: 1200 }}>
      <header className={styles.header}>
        <h1>{home ? `${home.name}: floor plan` : 'Floor plan'}</h1>
        <Link href={`/homes/${id}`}>Back to rooms</Link>
      </header>
      {error && <p className={styles.error}>{error}</p>}
      {!home && !error && <p>Loading…</p>}
      {home && home.rooms.length === 0 && (
        <p className={styles.muted}>Add a room first, then arrange it here.</p>
      )}
      {home && home.rooms.length > 0 && <FloorPlanEditor home={home} />}
    </main>
  );
}

export default function PlanPage() {
  return <AuthGate>{() => <PlanView />}</AuthGate>;
}
