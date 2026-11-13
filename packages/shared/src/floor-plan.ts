import { z } from 'zod';

export const MAX_ROOMS_PER_HOME = 100;
export const MAX_DOORS_PER_HOME = 50;

/**
 * A door that links two rooms that were recorded separately (e.g. the front yard and the living
 * room): walking into the circle at (x, z) rings the bell, if `bell`, then moves the player to
 * `to` in another room. Everything is in the home frame (metres, yaw radians about +Y,
 * 0 = facing -Z), like `spawn`.
 */
export const Door = z.object({
  id: z.string().min(1).max(40),
  /** Shown while the door is used, e.g. "Front door". */
  label: z.string().min(1).max(60).optional(),
  x: z.number(),
  z: z.number(),
  radius: z.number().positive().max(5),
  bell: z.boolean(),
  to: z.object({
    roomId: z.uuid(),
    x: z.number(),
    z: z.number(),
    yaw: z.number(),
  }),
});
export type Door = z.infer<typeof Door>;

/**
 * Where each room sits in the home, top-down. x/z are metres in the home frame; yaw is radians
 * about +Y. `scale` multiplies every room's metric transform; seats and footprints scale with
 * it (it corrects the pipeline's per-room scale estimate).
 */
export const FloorPlan = z.object({
  rooms: z
    .array(
      z.object({
        roomId: z.uuid(),
        x: z.number(),
        z: z.number(),
        rotationYaw: z.number(),
      }),
    )
    .max(MAX_ROOMS_PER_HOME),
  spawn: z.object({
    x: z.number(),
    z: z.number(),
    yaw: z.number(),
  }),
  scale: z.number().positive(),
  /** Optional: homes without doors are one walkable space. */
  doors: z.array(Door).max(MAX_DOORS_PER_HOME).optional(),
});
export type FloorPlan = z.infer<typeof FloorPlan>;
