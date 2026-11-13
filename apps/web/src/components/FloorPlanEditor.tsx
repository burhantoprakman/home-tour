'use client';

import type { FloorPlan, HomeDetail, SaveFloorPlanRequest } from '@home-tour/shared';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { api } from '../lib/api';
import {
  facing,
  hitRadii,
  normalizeYaw,
  ROOM_SIZE,
  roundCm,
  SCALE_MAX,
  SCALE_MIN,
  seatInPlan,
  syncPlan,
  viewBox,
  yawToSvgDegrees,
} from '../lib/plan';
import css from './editor.module.css';
import styles from './ui.module.css';

type Selection = { kind: 'room'; roomId: string } | { kind: 'spawn' } | null;
type Drag =
  | { kind: 'room'; roomId: string; dx: number; dz: number }
  | { kind: 'spawn'; dx: number; dz: number };

const DEG = Math.PI / 180;

function YawSlider({
  yaw,
  onChange,
  label,
}: {
  yaw: number;
  onChange: (yaw: number) => void;
  label: string;
}) {
  const deg = Math.round(normalizeYaw(yaw) / DEG);
  return (
    <div className={styles.stack}>
      <label className={styles.stack}>
        <span>
          {label}: {deg}°
        </span>
        <input
          className={css.slider}
          type="range"
          min={-180}
          max={180}
          step={5}
          value={deg}
          onChange={(e) => onChange(Number(e.target.value) * DEG)}
        />
      </label>
      <div className={styles.row}>
        <button className={styles.button} onClick={() => onChange(normalizeYaw(yaw + Math.PI / 2))}>
          ⟲ 90°
        </button>
        <button className={styles.button} onClick={() => onChange(normalizeYaw(yaw - Math.PI / 2))}>
          ⟳ 90°
        </button>
      </div>
    </div>
  );
}

/** Top-down editor: drag/rotate rooms, confirm seats, place the spawn, set scale; saves FloorPlan. */
export function FloorPlanEditor({ home }: { home: HomeDetail }) {
  const [plan, setPlan] = useState<FloorPlan>(() => syncPlan(home.floorPlan, home.rooms));
  const [confirmed, setConfirmed] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      home.rooms.map((r) => [r.id, r.seats.filter((s) => s.confirmed).map((s) => s.id)]),
    ),
  );
  const [box, setBox] = useState(() => viewBox(plan));
  const [selected, setSelected] = useState<Selection>(null);
  const [dirty, setDirty] = useState(home.floorPlan === null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);

  const rooms = useMemo(() => new Map(home.rooms.map((r) => [r.id, r])), [home.rooms]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function change(next: FloorPlan) {
    setPlan(next);
    setDirty(true);
    setMessage(null);
  }

  const updateRoom = (roomId: string, patch: Partial<FloorPlan['rooms'][number]>) =>
    change({
      ...plan,
      rooms: plan.rooms.map((p) => (p.roomId === roomId ? { ...p, ...patch } : p)),
    });

  function toPlan(e: PointerEvent): [number, number] {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!ctm) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  }

  function startDrag(e: PointerEvent, target: Selection) {
    if (!target) return;
    e.stopPropagation();
    const [x, z] = toPlan(e);
    if (target.kind === 'room') {
      const p = plan.rooms.find((r) => r.roomId === target.roomId);
      if (!p) return;
      drag.current = { kind: 'room', roomId: target.roomId, dx: x - p.x, dz: z - p.z };
    } else {
      drag.current = { kind: 'spawn', dx: x - plan.spawn.x, dz: z - plan.spawn.z };
    }
    setSelected(target);
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  function moveDrag(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const [x, z] = toPlan(e);
    const pos = { x: roundCm(x - d.dx), z: roundCm(z - d.dz) };
    if (d.kind === 'room') updateRoom(d.roomId, pos);
    else change({ ...plan, spawn: { ...plan.spawn, ...pos } });
  }

  function endDrag(e: PointerEvent) {
    drag.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
  }

  function toggleSeat(roomId: string, seatId: string) {
    setConfirmed((all) => {
      const ids = all[roomId] ?? [];
      return {
        ...all,
        [roomId]: ids.includes(seatId) ? ids.filter((s) => s !== seatId) : [...ids, seatId],
      };
    });
    setDirty(true);
    setMessage(null);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    const body: SaveFloorPlanRequest = {
      floorPlan: {
        rooms: plan.rooms.map((p) => ({ ...p, rotationYaw: roundCm(normalizeYaw(p.rotationYaw)) })),
        spawn: { ...plan.spawn, yaw: roundCm(normalizeYaw(plan.spawn.yaw)) },
        scale: plan.scale,
        ...(plan.doors ? { doors: plan.doors } : {}),
      },
      seats: home.rooms
        .filter((r) => r.seats.length > 0)
        .map((r) => ({
          roomId: r.id,
          confirmedSeatIds: (confirmed[r.id] ?? []).filter((id) =>
            r.seats.some((s) => s.id === id),
          ),
        })),
    };
    try {
      await api(`/api/homes/${home.id}/floor-plan`, { method: 'PUT', body });
      setDirty(false);
      setMessage({ ok: true, text: 'Floor plan saved.' });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const size = ROOM_SIZE * plan.scale;
  const [bx, bz, bw, bh] = box;
  const gridLines: number[] = [];
  for (let v = Math.floor(Math.min(bx, bz)); v <= Math.ceil(Math.max(bx + bw, bz + bh)); v++) {
    gridLines.push(v);
  }
  const selectedRoom =
    selected?.kind === 'room' ? plan.rooms.find((p) => p.roomId === selected.roomId) : undefined;
  const selectedInfo = selectedRoom ? rooms.get(selectedRoom.roomId) : undefined;
  const [fx, fz] = facing(plan.spawn.yaw);
  const seatDots = plan.rooms.flatMap((p) =>
    (rooms.get(p.roomId)?.seats ?? []).map((seat) => {
      const [x, z] = seatInPlan(seat, p, plan.scale);
      return { p, seat, x, z };
    }),
  );
  const seatHitR = hitRadii(seatDots.map(({ x, z }): [number, number] => [x, z]));

  return (
    <div className={css.layout}>
      <div className={styles.stack}>
        <svg
          ref={svgRef}
          className={css.canvas}
          viewBox={box.join(' ')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={() => setSelected(null)}
          role="application"
          aria-label="Floor plan. Drag rooms and the orange spawn marker."
        >
          {gridLines.map((v) => (
            <g key={v} className={css.grid}>
              <line x1={v} y1={bz} x2={v} y2={bz + bh} />
              <line x1={bx} y1={v} x2={bx + bw} y2={v} />
            </g>
          ))}

          {plan.rooms.map((p) => {
            const room = rooms.get(p.roomId);
            const isSel = selected?.kind === 'room' && selected.roomId === p.roomId;
            return (
              <g
                key={p.roomId}
                className={`${css.room} ${isSel ? css.selected : ''}`}
                transform={`translate(${p.x} ${p.z}) rotate(${yawToSvgDegrees(p.rotationYaw)})`}
                onPointerDown={(e) => startDrag(e, { kind: 'room', roomId: p.roomId })}
              >
                <rect x={-size / 2} y={-size / 2} width={size} height={size} rx={0.1} />
                {/* Notch on the room's -Z side ("forward" in the scan) to show its rotation. */}
                <path
                  className={css.front}
                  d={`M -0.3 ${-size / 2} L 0.3 ${-size / 2} L 0 ${-size / 2 + 0.35} Z`}
                />
                <text className={css.label}>{room?.name ?? 'Room'}</text>
              </g>
            );
          })}

          {seatDots.map(({ p, seat, x, z }, i) => {
            const [tx, tz] = facing(seat.facingYaw + p.rotationYaw);
            const on = (confirmed[p.roomId] ?? []).includes(seat.id);
            return (
              <g
                key={`${p.roomId}:${seat.id}`}
                className={css.seatGroup}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => toggleSeat(p.roomId, seat.id)}
              >
                <title>{on ? 'Confirmed seat (tap to unconfirm)' : 'Seat (tap to confirm)'}</title>
                {/* Invisible, finger-sized hit target under the small dot. */}
                <circle className={css.seatHit} cx={x} cy={z} r={seatHitR[i]} />
                <line className={css.seatTick} x1={x} y1={z} x2={x + tx * 0.4} y2={z + tz * 0.4} />
                <circle className={on ? css.seatConfirmed : css.seat} cx={x} cy={z} r={0.2} />
              </g>
            );
          })}

          <g
            className={`${css.spawn} ${selected?.kind === 'spawn' ? css.spawnSelected : ''}`}
            transform={`translate(${plan.spawn.x} ${plan.spawn.z})`}
            onPointerDown={(e) => startDrag(e, { kind: 'spawn' })}
          >
            <circle r={0.3} />
            <path
              d={`M ${fx * 0.75} ${fz * 0.75} L ${-fz * 0.18} ${fx * 0.18} L ${fz * 0.18} ${-fx * 0.18} Z`}
            />
          </g>
        </svg>
        <div className={styles.row}>
          <button className={styles.button} onClick={() => setBox(viewBox(plan))}>
            Fit to view
          </button>
          <span className={styles.muted}>Grid: 1 m. Tap a seat dot to confirm it.</span>
        </div>
      </div>

      <div className={styles.stack}>
        <section className={styles.card}>
          <label className={styles.stack}>
            <span>Scale: {plan.scale.toFixed(2)}×</span>
            <input
              className={css.slider}
              type="range"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={0.01}
              value={plan.scale}
              onChange={(e) => change({ ...plan, scale: Number(e.target.value) })}
            />
          </label>
          <p className={styles.muted}>
            Make the rooms match real life (e.g. a door is about 0.9 m wide).
          </p>
        </section>

        {selectedRoom && selectedInfo && (
          <section className={styles.card}>
            <h2>{selectedInfo.name}</h2>
            <YawSlider
              label="Rotation"
              yaw={selectedRoom.rotationYaw}
              onChange={(yaw) => updateRoom(selectedRoom.roomId, { rotationYaw: yaw })}
            />
            <h2 style={{ marginTop: 16 }}>Seats</h2>
            {selectedInfo.seats.length === 0 ? (
              <p className={styles.muted}>
                {selectedInfo.status === 'ready' || selectedInfo.status === 'preview'
                  ? 'No seats were found in this room.'
                  : 'Seats appear once the room has been processed.'}
              </p>
            ) : (
              <ul className={css.seatList}>
                {selectedInfo.seats.map((seat, i) => (
                  <li key={seat.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={(confirmed[selectedInfo.id] ?? []).includes(seat.id)}
                        onChange={() => toggleSeat(selectedInfo.id, seat.id)}
                      />
                      Seat {i + 1}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <button
              className={styles.button}
              style={{ marginTop: 12 }}
              onClick={() =>
                change({ ...plan, spawn: { ...plan.spawn, x: selectedRoom.x, z: selectedRoom.z } })
              }
            >
              Put spawn in this room
            </button>
          </section>
        )}

        {selected?.kind === 'spawn' && (
          <section className={styles.card}>
            <h2>Spawn point</h2>
            <p className={styles.muted}>Where guests appear, and which way they face.</p>
            <YawSlider
              label="Facing"
              yaw={plan.spawn.yaw}
              onChange={(yaw) => change({ ...plan, spawn: { ...plan.spawn, yaw } })}
            />
          </section>
        )}

        {!selected && (
          <p className={styles.muted}>
            Drag rooms into place and tap one to rotate it or confirm its seats. Drag the orange
            marker to set where guests appear.
          </p>
        )}

        <button className={styles.primary} disabled={saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : dirty ? 'Save floor plan' : 'Saved'}
        </button>
        {message && <p className={message.ok ? styles.muted : styles.error}>{message.text}</p>}
      </div>
    </div>
  );
}
