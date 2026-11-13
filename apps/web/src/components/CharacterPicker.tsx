'use client';

import { AVATAR_IDS, VisitRequest, type AvatarId } from '@home-tour/shared';
import { useEffect, useState, type FormEvent } from 'react';
import styles from './ui.module.css';

const AVATAR_LABELS: Record<AvatarId, string> = {
  'villager-m': 'Man',
  'villager-f': 'Woman',
  'villager-m-beard': 'Man with beard',
  mannequin: 'Mannequin',
};

const DEFAULT_TINT = '#4a7bd0';
const TINTS = [DEFAULT_TINT, '#c0504d', '#3c9d5d', '#d9a521', '#8e5bc4', '#3a3a3a'];

const STORAGE_KEY = 'home-tour:character';

/** Name + character + colour, remembered on this device for the next visit. */
export function CharacterPicker({
  busy,
  submitLabel,
  onSubmit,
}: {
  busy: boolean;
  submitLabel: string;
  onSubmit(choice: VisitRequest): void;
}) {
  const [name, setName] = useState('');
  const [avatarId, setAvatarId] = useState<AvatarId>('villager-m');
  const [tint, setTint] = useState(DEFAULT_TINT);

  useEffect(() => {
    try {
      const saved = VisitRequest.partial().safeParse(
        JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'),
      );
      if (!saved.success) return;
      if (saved.data.name) setName(saved.data.name);
      if (saved.data.avatarId) setAvatarId(saved.data.avatarId);
      if (saved.data.tint) setTint(saved.data.tint);
    } catch {
      // storage blocked or corrupt: start blank
    }
  }, []);

  const choice = VisitRequest.safeParse({ name, avatarId, tint });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice.success) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(choice.data));
    } catch {
      // not remembered; fine
    }
    onSubmit(choice.data);
  }

  return (
    <form className={styles.stack} onSubmit={submit}>
      <label className={styles.stack}>
        <span>Your name</span>
        <input
          className={styles.input}
          value={name}
          maxLength={24}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder="What friends will see"
        />
      </label>
      <fieldset className={styles.stack} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>Character</legend>
        <div className={styles.row} style={{ flexWrap: 'wrap' }}>
          {AVATAR_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={id === avatarId ? styles.primary : styles.button}
              aria-pressed={id === avatarId}
              onClick={() => setAvatarId(id)}
            >
              {AVATAR_LABELS[id]}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.stack} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>Clothes colour</legend>
        <div className={styles.row}>
          {TINTS.map((t) => (
            <button
              key={t}
              type="button"
              aria-label={`Colour ${t}`}
              aria-pressed={t === tint}
              onClick={() => setTint(t)}
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: t,
                border: t === tint ? '3px solid currentColor' : '1px solid rgba(0,0,0,.2)',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      </fieldset>
      <button className={styles.primary} disabled={busy || !choice.success}>
        {busy ? 'Opening…' : submitLabel}
      </button>
    </form>
  );
}
