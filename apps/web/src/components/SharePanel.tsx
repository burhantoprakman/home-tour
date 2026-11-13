'use client';

import type { CreateInviteResponse } from '@home-tour/shared';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '../lib/api';
import styles from './ui.module.css';

/** Home page card: walk in yourself, or make an invite link for friends and family. */
export function SharePanel({ homeId, canVisit }: { homeId: string; canVisit: boolean }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createLink() {
    setBusy(true);
    setError(null);
    try {
      const inv = await api<CreateInviteResponse>(`/api/homes/${homeId}/invites`, {
        method: 'POST',
      });
      setLink({ url: `${location.origin}/join/${inv.token}`, expiresAt: inv.expiresAt });
      setCopied(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setError('Copy failed; select the link and copy it.');
    }
  }

  return (
    <section className={styles.card}>
      <h2>Visit and share</h2>
      {!canVisit && (
        <p className={styles.muted}>
          Place at least one finished room on the floor plan to open your home.
        </p>
      )}
      <div className={styles.row} style={{ flexWrap: 'wrap' }}>
        {canVisit && (
          <Link className={styles.primary} href={`/homes/${homeId}/visit`}>
            Walk in
          </Link>
        )}
        <button
          type="button"
          className={styles.button}
          disabled={busy || !canVisit}
          onClick={() => void createLink()}
        >
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
      </div>
      {link && (
        <div className={styles.stack}>
          <div className={styles.row}>
            <input
              className={`${styles.input} ${styles.grow}`}
              readOnly
              value={link.url}
              onFocus={(e) => e.target.select()}
              aria-label="Invite link"
            />
            <button type="button" className={styles.button} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <span className={styles.muted}>
            Anyone with this link can join (up to 8 people at once)
            {link.expiresAt ? ` until ${new Date(link.expiresAt).toLocaleDateString()}` : ''}.
          </span>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}
