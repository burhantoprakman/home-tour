import {
  CreateRoomRequest,
  IdParam,
  STORAGE_BUCKETS,
  VIDEO_CONTENT_TYPES,
  type CreateRoomResponse,
  type ResumableUpload,
  type RoomUploadedResponse,
  type VideoContentType,
} from '@home-tour/shared';
import type { UserDb } from './db';
import type { JobEnqueuer } from './enqueue';
import type { ServerEnv } from './env';
import { dbErrorResponse } from './errors';
import { apiError, bearerToken, json, readJson } from './http';

/** Supabase Storage requires TUS chunks of exactly 6 MiB. */
export const TUS_CHUNK_SIZE = 6 * 1024 * 1024;

export interface RouteDeps {
  env: ServerEnv;
  /** null: anon (guest) access. */
  db: (accessToken: string | null) => UserDb;
  enqueuer: JobEnqueuer;
}

/** The TUS target for a room video (`video_path` of its job) in Supabase Storage. */
export function uploadTarget(
  env: ServerEnv,
  objectName: string,
  contentType: VideoContentType,
): ResumableUpload {
  return {
    protocol: 'tus',
    endpoint: `${env.supabaseUrl}/storage/v1/upload/resumable`,
    bucketName: STORAGE_BUCKETS.videos,
    objectName,
    contentType,
    chunkSize: TUS_CHUNK_SIZE,
  };
}

/** POST /api/homes/:id/rooms — create a queued room + job, return the video's TUS target. */
export async function createRoom(
  req: Request,
  params: unknown,
  deps: RouteDeps,
): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const id = IdParam.safeParse(params);
  if (!id.success) return apiError(400, 'Invalid home id');
  const body = CreateRoomRequest.safeParse(await readJson(req));
  if (!body.success) return apiError(400, 'Invalid input');

  const { data, error } = await deps
    .db(token)
    .rpc<{ room_id: string; job_id: string; video_path: string }[]>('create_room', {
      p_home_id: id.data.id,
      p_name: body.data.name,
      p_video_ext: VIDEO_CONTENT_TYPES[body.data.contentType],
    });
  if (error) return dbErrorResponse(error);
  const row = data?.[0];
  if (!row) return apiError(500, 'Something went wrong');

  return json<CreateRoomResponse>(
    {
      roomId: row.room_id,
      jobId: row.job_id,
      upload: uploadTarget(deps.env, row.video_path, body.data.contentType),
    },
    201,
  );
}

/** POST /api/rooms/:id/uploaded — the TUS upload finished: enqueue the Modal job once. */
export async function roomUploaded(
  req: Request,
  params: unknown,
  deps: RouteDeps,
): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const id = IdParam.safeParse(params);
  if (!id.success) return apiError(400, 'Invalid room id');

  const db = deps.db(token);
  const { data, error } = await db.rpc<{ job_id: string; room_id: string; video_path: string }[]>(
    'claim_room_upload',
    { p_room_id: id.data.id },
  );
  if (error) return dbErrorResponse(error);
  const job = data?.[0];
  if (!job) return apiError(500, 'Something went wrong');

  try {
    await deps.enqueuer.enqueue({
      jobId: job.job_id,
      roomId: job.room_id,
      videoPath: job.video_path,
    });
  } catch (err) {
    console.error('[api] enqueue failed', job.job_id, err);
    const release = await db.rpc<null>('release_room_upload', { p_job_id: job.job_id });
    if (release.error) console.error('[api] release failed', job.job_id, release.error.message);
    return apiError(503, 'Could not start processing. Please try again.');
  }
  return json<RoomUploadedResponse>({ roomId: job.room_id, jobId: job.job_id }, 202);
}
