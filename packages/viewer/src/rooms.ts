/**
 * Placing rooms in the home. A room's files (splat, collision.glb) are in the room's raw frame;
 * `Room.transform` takes them to the levelled metric frame its seats are in, and the floor plan
 * entry places that frame in the home: scale by `FloorPlan.scale`, rotate by `rotationYaw` about
 * +Y, move to (x, 0, z). Same transform as apps/web `seatInPlan`. Pure math, no engine imports.
 */
import type { FloorPlan, Room, RoomTransform } from '@home-tour/shared';
import { raycast, raycastDown, type CollisionMesh } from './collision.ts';
import type { TriangleSoup } from './glb.ts';
import type { WorldSeat } from './seats.ts';

export type Placement = FloorPlan['rooms'][number];

/** Rotates (x, z) by yaw about +Y (counter-clockwise from above). */
export function rotateY(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** Levelled room frame -> home (world) frame. */
export function planToWorld(
  p: readonly [number, number, number],
  placement: Placement,
  scale: number,
): [number, number, number] {
  const [x, z] = rotateY(p[0] * scale, p[2] * scale, placement.rotationYaw);
  return [placement.x + x, p[1] * scale, placement.z + z];
}

/** Raw room file frame -> levelled room frame (Room.transform). */
export function roomToLevelled(
  p: readonly [number, number, number],
  t: RoomTransform,
): [number, number, number] {
  const [x, z] = rotateY(p[0] * t.scale, p[2] * t.scale, t.rotationYaw);
  return [x + t.position[0], p[1] * t.scale + t.position[1], z + t.position[2]];
}

/** The room's seats in world space. */
export function worldSeats(room: Room, placement: Placement, scale: number): WorldSeat[] {
  return room.seats.map((s) => {
    const [x, y, z] = planToWorld(s.position, placement, scale);
    return {
      id: s.id,
      roomId: room.id,
      x,
      y,
      z,
      facingYaw: s.facingYaw + placement.rotationYaw,
      confirmed: s.confirmed,
    };
  });
}

/** Transforms a collision soup from the room's file frame into world space (new arrays). */
export function soupToWorld(
  soup: TriangleSoup,
  transform: RoomTransform,
  placement: Placement,
  scale: number,
): TriangleSoup {
  const out = new Float32Array(soup.positions.length);
  const p: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < out.length; i += 3) {
    p[0] = soup.positions[i] ?? 0;
    p[1] = soup.positions[i + 1] ?? 0;
    p[2] = soup.positions[i + 2] ?? 0;
    const w = planToWorld(roomToLevelled(p, transform), placement, scale);
    out[i] = w[0];
    out[i + 1] = w[1];
    out[i + 2] = w[2];
  }
  return { positions: out, triangleCount: soup.triangleCount };
}

export function mergeSoups(soups: readonly TriangleSoup[]): TriangleSoup {
  const triangleCount = soups.reduce((n, s) => n + s.triangleCount, 0);
  const positions = new Float32Array(triangleCount * 9);
  let o = 0;
  for (const s of soups) {
    positions.set(s.positions.subarray(0, s.triangleCount * 9), o);
    o += s.triangleCount * 9;
  }
  return { positions, triangleCount };
}

export interface RoomBounds {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Top-down bounds of a world-space soup. */
export function soupBounds(id: string, soup: TriangleSoup): RoomBounds {
  const b = { id, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < soup.triangleCount * 9; i += 3) {
    const x = soup.positions[i] ?? 0,
      z = soup.positions[i + 2] ?? 0;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

/**
 * The room the point is in: the smallest footprint containing it (rooms overlap a little at
 * doorways), else the room whose footprint is nearest.
 */
export function currentRoom(rooms: readonly RoomBounds[], x: number, z: number): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const r of rooms) {
    const dx = Math.max(r.minX - x, 0, x - r.maxX);
    const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
    const outside = Math.hypot(dx, dz);
    // Inside: rank by footprint area; outside: after every inside room, by distance.
    const score = outside > 0 ? 1e9 + outside : (r.maxX - r.minX) * (r.maxZ - r.minZ);
    if (score < bestScore) {
      bestScore = score;
      best = r.id;
    }
  }
  return best;
}

/**
 * Rooms to draw when the home has doors: the current room and every room whose footprint is
 * within `gap` metres of it (walk-through neighbours). Rooms reached only through a door sit
 * far away in the plan and would otherwise float on the horizon. No current room: all.
 */
export function visibleRooms(
  rooms: readonly RoomBounds[],
  currentId: string | null,
  gap = 1,
): Set<string> {
  const cur = rooms.find((r) => r.id === currentId);
  if (!cur) return new Set(rooms.map((r) => r.id));
  return new Set(
    rooms
      .filter(
        (r) =>
          r.minX - gap <= cur.maxX &&
          cur.minX - gap <= r.maxX &&
          r.minZ - gap <= cur.maxZ &&
          cur.minZ - gap <= r.maxZ,
      )
      .map((r) => r.id),
  );
}

/** Free horizontal space around a standing player at (x, y, z): nearest hit of 8 rays at knee and chest height. */
export function clearance(mesh: CollisionMesh, x: number, y: number, z: number, reach = 1): number {
  let best = reach;
  for (const h of [0.5, 1.2]) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const hit = raycast(mesh, x, y + h, z, Math.sin(a), 0, Math.cos(a), reach);
      if (hit && hit.distance < best) best = hit.distance;
    }
  }
  return best;
}

/**
 * Free length of the third-person camera boom for a player at (x, y, z) facing `yaw`: from head
 * height, backward and slightly up (the camera's default pitch), up to `reach`.
 */
export function boomClearance(
  mesh: CollisionMesh,
  x: number,
  y: number,
  z: number,
  yaw: number,
  reach = 2,
): number {
  const up = Math.sin((15 * Math.PI) / 180);
  const flat = Math.cos((15 * Math.PI) / 180);
  const hit = raycast(mesh, x, y + 1.6, z, Math.sin(yaw) * flat, up, Math.cos(yaw) * flat, reach);
  return hit ? hit.distance : reach;
}

/**
 * Feet position for a spawn at (x, z) facing `yaw`: the floor under it if there is `need` metres
 * of free space around the body and `boom` metres behind the head for the camera, else the
 * nearest floor point within 2 m that has both (else the most open one). Spawns in the middle
 * of a sofa, against a wall or under a low obstacle otherwise start with the camera inside it.
 * Null if there is no floor nearby at all.
 */
export function openFloorNear(
  mesh: CollisionMesh,
  x: number,
  z: number,
  yaw: number,
  need = 0.6,
  boom = 1.5,
): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  let bestScore = -1;
  for (let r = 0; r <= 2; r += 0.25) {
    const steps = r === 0 ? 1 : 16;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const px = x + Math.sin(a) * r,
        pz = z + Math.cos(a) * r;
      const floor = raycastDown(mesh, px, 1, pz, 3, 0.7);
      if (!floor) continue;
      const py = 1 - floor.distance;
      if (py > 0.25) continue; // furniture top, not the floor
      const space = clearance(mesh, px, py, pz);
      const back = boomClearance(mesh, px, py, pz, yaw);
      if (space >= need && back >= boom) return [px, py, pz];
      const score = Math.min(space / need, back / boom);
      if (score > bestScore) {
        bestScore = score;
        best = [px, py, pz];
      }
    }
  }
  return best;
}
