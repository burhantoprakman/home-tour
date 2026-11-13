import { z } from 'zod';
import { Vec3 } from './geometry.js';

/**
 * A place to sit, in the room's levelled metric frame (+Y up, floor y=0). `position` is the
 * centre of the seat surface; `facingYaw` is radians about +Y, 0 = facing -Z (PlayCanvas
 * forward), so the facing direction is (-sin yaw, 0, -cos yaw).
 */
export const Seat = z.object({
  id: z.string().min(1),
  position: Vec3,
  facingYaw: z.number(),
  confirmed: z.boolean(),
});
export type Seat = z.infer<typeof Seat>;

export const RoomStatus = z.enum(['queued', 'solving', 'training', 'preview', 'ready', 'failed']);
export type RoomStatus = z.infer<typeof RoomStatus>;

/**
 * Room-local alignment from the pipeline (meta.json): levels the floor to y=0 and applies
 * metric scale. FloorPlan places the room within the home.
 */
export const RoomTransform = z.object({
  position: Vec3,
  rotationYaw: z.number(),
  scale: z.number().positive(),
});
export type RoomTransform = z.infer<typeof RoomTransform>;

export const Room = z.object({
  id: z.uuid(),
  homeId: z.uuid(),
  name: z.string().min(1).max(60),
  status: RoomStatus,
  // Null until the worker has published the room's files.
  splatUrl: z.url().nullable(),
  collisionUrl: z.url().nullable(),
  seats: z.array(Seat),
  transform: RoomTransform,
});
export type Room = z.infer<typeof Room>;
