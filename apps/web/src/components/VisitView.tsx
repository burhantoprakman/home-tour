'use client';

import type { VisitRequest, VisitResponse } from '@home-tour/shared';
import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen visit: the viewer, realtime session and chat/emote HUD (all from
 * @home-tour/viewer). PlayCanvas needs the browser, so the package is loaded on mount.
 */
export function VisitView({
  visit,
  choice,
  onLeave,
}: {
  visit: VisitResponse;
  choice: VisitRequest;
  onLeave(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void import('@home-tour/viewer').then(
      ({ visitHome }) => {
        if (cancelled) return;
        const v = visitHome(canvas, {
          homeId: visit.homeId,
          floorPlan: visit.floorPlan,
          rooms: visit.rooms,
          ticket: visit.ticket,
          realtimeUrl: visit.realtimeUrl,
          avatarId: choice.avatarId,
          tint: choice.tint,
        });
        v.viewer.on('error', (err) => setError(err.message));
        dispose = v.dispose;
      },
      (err: unknown) => setError(String(err)),
    );
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [visit, choice]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
      />
      <button
        type="button"
        onClick={onLeave}
        style={{
          position: 'absolute',
          left: 12,
          top: 12,
          padding: '8px 12px',
          borderRadius: 10,
          border: 0,
          background: 'rgba(0,0,0,.55)',
          color: '#fff',
          font: '14px system-ui, sans-serif',
          cursor: 'pointer',
          zIndex: 1,
        }}
      >
        ← Leave
      </button>
      {error && (
        <p
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 80,
            color: '#fff',
            background: '#b3261e',
            padding: 8,
            borderRadius: 8,
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
