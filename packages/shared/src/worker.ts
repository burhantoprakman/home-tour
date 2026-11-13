import { z } from 'zod';
import { Seat } from './room.js';

/**
 * Files the GPU pipeline writes for each room. The splat is a streamed SOG octree
 * (lod-meta.json + chunk files beside it); the viewer's splat budget only applies to this form.
 */
export const WORKER_OUTPUT_FILES = {
  splat: 'room_lod/lod-meta.json',
  collision: 'collision.glb',
  seats: 'seats.json',
  meta: 'meta.json',
} as const;

/**
 * Files a room's output folder may also hold, beside WORKER_OUTPUT_FILES. The viewer looks for them
 * next to collision.glb and carries on without them.
 * - camera: occluder mesh voxelised from the splat (everything drawn, not just what you can walk
 *   into); the third-person camera keeps out of it as well as out of collision.glb.
 */
export const WORKER_OPTIONAL_FILES = {
  camera: 'camera.glb',
} as const;

export const WorkerMeta = z.object({
  gaussianCount: z.number().int().nonnegative(),
  floorY: z.number(),
  scale: z.number().positive(),
});
export type WorkerMeta = z.infer<typeof WorkerMeta>;

/** Contents of seats.json; the pipeline writes every seat unconfirmed. */
export const WorkerSeats = z.array(Seat);
export type WorkerSeats = z.infer<typeof WorkerSeats>;
