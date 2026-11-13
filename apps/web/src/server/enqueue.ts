/** Starts the GPU pipeline for one uploaded room video. */
export interface JobEnqueuer {
  enqueue(job: { jobId: string; roomId: string; videoPath: string }): Promise<void>;
}

export const MODAL_APP = 'home-tour-worker';
export const MODAL_FUNCTION = 'process_room';

export class EnqueueUnavailableError extends Error {}

/**
 * Spawns `process_room(job_id, room_id, video_path)` of the deployed Modal app.
 * Credentials come from MODAL_TOKEN_ID / MODAL_TOKEN_SECRET or ~/.modal.toml (the SDK's defaults).
 */
export const modalEnqueuer: JobEnqueuer = {
  async enqueue(job) {
    const { ModalClient } = await import('modal');
    let fn;
    try {
      fn = await new ModalClient().functions.fromName(MODAL_APP, MODAL_FUNCTION);
    } catch (err) {
      throw new EnqueueUnavailableError(
        `Modal function ${MODAL_APP}.${MODAL_FUNCTION} is unavailable: ${String(err)}`,
      );
    }
    await fn.spawn([job.jobId, job.roomId, job.videoPath]);
  },
};
