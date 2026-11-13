'use client';

import {
  HomeStatusEvent,
  type CreateRoomResponse,
  type HomeDetail,
  type ResumableUpload,
  type RoomProgress,
} from '@home-tour/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AuthGate } from '../../../components/AuthGate';
import { RecordingTips } from '../../../components/RecordingTips';
import { SharePanel } from '../../../components/SharePanel';
import styles from '../../../components/ui.module.css';
import { api } from '../../../lib/api';
import { subscribeSse } from '../../../lib/sse';
import { authHeaders, supabase } from '../../../lib/supabase';
import { uploadRoomVideo, videoContentType } from '../../../lib/upload';

interface UploadState {
  sent: number;
  total: number;
  error: string | null;
  done: boolean;
}

const STAGE_LABELS: Record<RoomProgress['stage'], string> = {
  queued: 'Waiting for a GPU',
  download: 'Fetching your video',
  frames: 'Picking sharp frames',
  solve: 'Working out camera positions',
  floor: 'Finding the floor',
  train: 'Building the 3D room',
  publish_preview: 'Publishing a preview',
  publish_final: 'Publishing the final room',
  done: 'Done',
};

function percent(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function RoomStatus({
  p,
  upload,
}: {
  p: RoomProgress | undefined;
  upload: UploadState | undefined;
}) {
  if (upload && !upload.done) {
    return (
      <div className={styles.stack}>
        <span className={styles.muted}>
          Uploading… {percent(upload.sent, upload.total)}% ({(upload.sent / 1e6).toFixed(0)} of{' '}
          {(upload.total / 1e6).toFixed(0)} MB)
        </span>
        <div className={styles.bar}>
          <span style={{ width: `${percent(upload.sent, upload.total)}%` }} />
        </div>
        {upload.error && <span className={styles.error}>{upload.error}</span>}
      </div>
    );
  }
  if (!p) return null;
  if (p.status === 'ready') return <span className={styles.badgeReady}>Ready</span>;
  if (p.status === 'failed') {
    return (
      <span className={styles.error}>
        <span className={styles.badgeFailed}>Failed</span> {p.error ?? 'Processing failed.'}
      </span>
    );
  }
  if (p.upload) return <span className={styles.muted}>Waiting for the video</span>;
  return (
    <div className={styles.stack}>
      <span className={styles.muted}>
        {p.status === 'preview' ? 'Preview ready, still improving: ' : ''}
        {STAGE_LABELS[p.stage]} · {Math.round(p.progress * 100)}%
      </span>
      <div className={styles.bar}>
        <span style={{ width: `${Math.round(p.progress * 100)}%` }} />
      </div>
    </div>
  );
}

function HomeView({ homeId }: { homeId: string }) {
  const [home, setHome] = useState<HomeDetail | null>(null);
  const [progress, setProgress] = useState<Record<string, RoomProgress>>({});
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [error, setError] = useState<string | null>(null);
  const [roomName, setRoomName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // One AbortController per room upload; all are aborted when the page unmounts.
  const uploadAborts = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const aborts = uploadAborts.current;
    return () => {
      for (const c of aborts.values()) c.abort();
      aborts.clear();
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const h = await api<HomeDetail>(`/api/homes/${homeId}`);
      setHome(h);
      setProgress(Object.fromEntries(h.progress.map((p) => [p.roomId, p])));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [homeId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live status from the jobs table (SSE). Restarts whenever the home is reloaded (room added,
  // upload finished), since the server ends the stream once nothing is left to watch.
  useEffect(() => {
    if (!home || home.rooms.length === 0) return;
    let settled = false;
    return subscribeSse({
      url: `/api/homes/${homeId}/status`,
      headers: authHeaders,
      onMessage: (msg) => {
        if (msg.event === 'done') settled = true;
        if (msg.event !== 'status') return;
        const parsed = HomeStatusEvent.safeParse(JSON.parse(msg.data));
        if (parsed.success) {
          setProgress(Object.fromEntries(parsed.data.rooms.map((p) => [p.roomId, p])));
        }
      },
      shouldReconnect: () => !settled,
      refreshSession: async () => {
        const { error } = await supabase().auth.refreshSession();
        if (error) throw error;
      },
      onStop: (status) =>
        setError(
          status === 401 ? 'Your session expired. Please sign in again.' : 'Live status stopped.',
        ),
    });
  }, [homeId, home]);

  // Leaving the page pauses an upload (it resumes when the same file is picked again).
  const uploading = Object.values(uploads).some((u) => !u.done && !u.error);
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  async function send(roomId: string, target: ResumableUpload, video: File) {
    const set = (u: Partial<UploadState>) =>
      setUploads((all) => ({
        ...all,
        [roomId]: { sent: 0, total: video.size, error: null, done: false, ...all[roomId], ...u },
      }));
    uploadAborts.current.get(roomId)?.abort();
    const controller = new AbortController();
    uploadAborts.current.set(roomId, controller);
    set({ sent: 0, error: null, done: false });
    try {
      await uploadRoomVideo(
        roomId,
        target,
        video,
        (sent, total) => set({ sent, total }),
        controller.signal,
      );
      set({ done: true });
      await load();
    } catch (err) {
      if (controller.signal.aborted) return;
      set({ error: `${(err as Error).message} Pick the same video again to resume.` });
    } finally {
      if (uploadAborts.current.get(roomId) === controller) uploadAborts.current.delete(roomId);
    }
  }

  async function addRoom(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const contentType = videoContentType(file);
    if (!contentType) {
      setError('Please choose an MP4, MOV or WebM video.');
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const created = await api<CreateRoomResponse>(`/api/homes/${homeId}/rooms`, {
        method: 'POST',
        body: { name: roomName.trim(), contentType },
      });
      setRoomName('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      await load();
      void send(created.roomId, created.upload, file);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  if (!home) {
    return (
      <main className={styles.page}>
        {error ? <p className={styles.error}>{error}</p> : 'Loading…'}
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>{home.name}</h1>
        <Link href="/homes">All homes</Link>
      </header>

      <section className={styles.card}>
        <h2>Rooms</h2>
        {home.rooms.length === 0 ? (
          <p className={styles.muted}>No rooms yet. Add one below.</p>
        ) : (
          <ul className={styles.list}>
            {home.rooms.map((room) => {
              const p = progress[room.id];
              const u = uploads[room.id];
              const needsVideo = p?.upload && (!u || u.error);
              return (
                <li key={room.id} className={styles.stack}>
                  <strong>{room.name}</strong>
                  <RoomStatus p={p} upload={u} />
                  {needsVideo && p.upload && (
                    <label className={styles.row}>
                      <span className={styles.muted}>Video:</span>
                      <input
                        type="file"
                        accept="video/mp4,video/quicktime,video/webm,.mov,.mp4,.webm"
                        onChange={(e) => {
                          const picked = e.target.files?.[0];
                          if (picked && p.upload) void send(room.id, p.upload, picked);
                        }}
                      />
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {home.rooms.length > 0 && (
          <p>
            <Link className={styles.primary} href={`/homes/${homeId}/plan`}>
              Edit floor plan
            </Link>
          </p>
        )}
      </section>

      <SharePanel
        homeId={homeId}
        canVisit={
          !!home.floorPlan?.rooms.some((placed) =>
            home.rooms.some((r) => r.id === placed.roomId && r.splatUrl && r.collisionUrl),
          )
        }
      />

      <section className={styles.card}>
        <h2>Add a room</h2>
        <form className={styles.stack} onSubmit={addRoom}>
          <RecordingTips />
          <input
            className={styles.input}
            placeholder="Room name, e.g. Living room"
            maxLength={60}
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            aria-label="Room name"
          />
          <input
            ref={fileInput}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,.mov,.mp4,.webm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            aria-label="Room video"
          />
          <button className={styles.primary} disabled={adding || !roomName.trim() || !file}>
            {adding ? 'Adding…' : 'Add room and upload'}
          </button>
        </form>
      </section>
      {error && <p className={styles.error}>{error}</p>}
    </main>
  );
}

function HomePageInner() {
  const { id } = useParams<{ id: string }>();
  return <HomeView homeId={id} />;
}

export default function HomePage() {
  return <AuthGate>{() => <HomePageInner />}</AuthGate>;
}
