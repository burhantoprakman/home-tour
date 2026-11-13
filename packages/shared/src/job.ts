import { z } from 'zod';
import { RoomStatus } from './room.js';

/**
 * Pipeline stages, in order. The worker writes the current one to `jobs.stage`.
 * `train` is one GPU run: the preview snapshot is published at PREVIEW_ITERS, the final at
 * FINAL_ITERS. `publish_preview` / `publish_final` = collision -> seats -> compress -> meta ->
 * upload for that snapshot.
 */
export const JobStage = z.enum([
  'queued',
  'download',
  'frames',
  'solve',
  'floor',
  'train',
  'publish_preview',
  'publish_final',
  'done',
]);
export type JobStage = z.infer<typeof JobStage>;

export const PREVIEW_ITERS = 7_000;
export const FINAL_ITERS = 30_000;

/**
 * One processing job per uploaded room video (`jobs` table, snake_case columns:
 * id, room_id, status, stage, progress, error, gpu_seconds, stage_timings).
 * `status` mirrors the room's status; `error` is a user-readable message when status is 'failed'.
 */
export const Job = z.object({
  id: z.uuid(),
  roomId: z.uuid(),
  status: RoomStatus,
  stage: JobStage,
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  gpuSeconds: z.number().nonnegative(),
  // Wall seconds per finished stage, e.g. { frames: 83, solve: 310, train: 2583 }.
  stageTimings: z.record(z.string(), z.number().nonnegative()),
});
export type Job = z.infer<typeof Job>;

/**
 * Supabase Storage. Videos are private (service role + the owner's upload URL); room files are
 * public-read so the viewer/CDN can stream them.
 */
export const STORAGE_BUCKETS = {
  videos: 'room-videos',
  files: 'room-files',
} as const;

export const OutputVariant = z.enum(['preview', 'final']);
export type OutputVariant = z.infer<typeof OutputVariant>;

/**
 * Folder in STORAGE_BUCKETS.files holding one variant's WORKER_OUTPUT_FILES,
 * e.g. `rooms/<roomId>/final/room_lod/lod-meta.json`.
 */
export function roomOutputPrefix(roomId: string, variant: OutputVariant): string {
  return `rooms/${roomId}/${variant}`;
}
