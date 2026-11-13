import type { FloorPlan, Room, Seat } from '@home-tour/shared';

/**
 * Floor plan geometry, top-down. Plan x/z are metres in the home frame; the SVG uses x right,
 * z down (so -Z, PlayCanvas forward, points up the screen). Yaw is radians about +Y
 * (counter-clockwise seen from above), as in the Seat/FloorPlan contracts.
 */

/** Room footprint drawn in the editor until the pipeline reports room bounds (metres). */
export const ROOM_SIZE = 4;
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;

export type Placement = FloorPlan['rooms'][number];

/** Rotates a room-local (x, z) by yaw about +Y. */
export function rotate(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** SVG `rotate()` degrees for a yaw (SVG rotates clockwise on screen, yaw is counter-clockwise). */
export function yawToSvgDegrees(yaw: number): number {
  return (-yaw * 180) / Math.PI;
}

/** Wraps an angle to (-PI, PI]. */
export function normalizeYaw(yaw: number): number {
  const twoPi = 2 * Math.PI;
  let a = ((yaw % twoPi) + twoPi) % twoPi;
  if (a > Math.PI) a -= twoPi;
  return a;
}

/** A seat's position in the plan: room-local metres, scaled, rotated and moved by the room. */
export function seatInPlan(seat: Seat, room: Placement, scale: number): [number, number] {
  const [x, z] = rotate(seat.position[0] * scale, seat.position[2] * scale, room.rotationYaw);
  return [room.x + x, room.z + z];
}

/**
 * Tap-target radius for each seat: up to `max`, but at most half the distance to the nearest
 * other seat, so neighbouring seats' targets never overlap and a tap goes to the nearest one.
 */
export function hitRadii(points: [number, number][], max = 0.5): number[] {
  return points.map(([x, z], i) =>
    points.reduce(
      (r, [ox, oz], j) => (j === i ? r : Math.min(r, Math.hypot(ox - x, oz - z) / 2)),
      max,
    ),
  );
}

/** Unit vector (plan x, z) a yaw faces: (-sin yaw, -cos yaw). */
export function facing(yaw: number): [number, number] {
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/**
 * The saved plan reconciled with the home's current rooms: rooms that no longer exist are
 * dropped, new rooms are placed in a row to the right of the others.
 */
export function syncPlan(saved: FloorPlan | null, rooms: Pick<Room, 'id'>[]): FloorPlan {
  const ids = new Set(rooms.map((r) => r.id));
  const kept = (saved?.rooms ?? []).filter((p) => ids.has(p.roomId));
  const placed = new Set(kept.map((p) => p.roomId));
  let nextX = kept.length ? Math.max(...kept.map((p) => p.x)) + ROOM_SIZE + 1 : 0;
  const added = rooms
    .filter((r) => !placed.has(r.id))
    .map((r) => {
      const p = { roomId: r.id, x: nextX, z: 0, rotationYaw: 0 };
      nextX += ROOM_SIZE + 1;
      return p;
    });
  const first = kept[0] ?? added[0];
  return {
    rooms: [...kept, ...added],
    spawn: saved?.spawn ?? { x: first?.x ?? 0, z: first?.z ?? 0, yaw: 0 },
    scale: saved?.scale ?? 1,
    // The editor doesn't draw doors yet; keep the ones that still lead to a room of this home.
    ...(saved?.doors ? { doors: saved.doors.filter((d) => ids.has(d.to.roomId)) } : {}),
  };
}

/** SVG viewBox [minX, minZ, width, height] covering every room and the spawn, with margin. */
export function viewBox(plan: FloorPlan): [number, number, number, number] {
  const half = (ROOM_SIZE * plan.scale) / Math.SQRT2 + 1; // a rotated room's reach
  const xs = [plan.spawn.x, ...plan.rooms.flatMap((r) => [r.x - half, r.x + half])];
  const zs = [plan.spawn.z, ...plan.rooms.flatMap((r) => [r.z - half, r.z + half])];
  const minX = Math.min(...xs) - 1;
  const minZ = Math.min(...zs) - 1;
  const size = Math.max(Math.max(...xs) + 1 - minX, Math.max(...zs) + 1 - minZ, 10);
  return [minX, minZ, size, size];
}

/** Rounds metres to centimetres so saved plans stay readable. */
export function roundCm(v: number): number {
  return Math.round(v * 100) / 100;
}
