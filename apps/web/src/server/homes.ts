import {
  CreateHomeRequest,
  FloorPlan,
  IdParam,
  JobStage,
  Room,
  RoomStatus,
  SaveFloorPlanRequest,
  VIDEO_CONTENT_TYPES,
  type CreateHomeResponse,
  type HomeDetail,
  type HomeStatusEvent,
  type ListHomesResponse,
  type RoomProgress,
  type VideoContentType,
} from '@home-tour/shared';
import { z } from 'zod';
import type { ServerEnv } from './env';
import { dbErrorResponse } from './errors';
import { apiError, bearerToken, json, readJson } from './http';
import { uploadTarget, type RouteDeps } from './rooms';

/** A progress row as returned by public.home_progress() (supabase/migrations/*_step3.sql). */
const ProgressRow = z.object({
  roomId: z.uuid(),
  status: RoomStatus,
  stage: JobStage,
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  videoPath: z.string().nullable(),
  enqueued: z.boolean(),
});

const HomeRow = z.object({
  id: z.uuid(),
  name: z.string(),
  floorPlan: FloorPlan.nullable(),
  rooms: z.array(Room),
  progress: z.array(ProgressRow),
});

const StatusRow = z.object({ rooms: z.array(ProgressRow) });

const EXT_CONTENT_TYPES = Object.fromEntries(
  Object.entries(VIDEO_CONTENT_TYPES).map(([type, ext]) => [ext, type as VideoContentType]),
) as Record<string, VideoContentType>;

/** Adds the upload target while the room's video still has to be sent. */
export function toRoomProgress(row: z.infer<typeof ProgressRow>, env: ServerEnv): RoomProgress {
  const ext = /\.([a-z0-9]+)$/.exec(row.videoPath ?? '')?.[1];
  const contentType = ext ? EXT_CONTENT_TYPES[ext] : undefined;
  return {
    roomId: row.roomId,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    error: row.error,
    upload:
      row.enqueued || !row.videoPath || !contentType
        ? null
        : uploadTarget(env, row.videoPath, contentType),
  };
}

function badRow(what: string, issue: unknown): Response {
  console.error(`[api] unexpected ${what} row`, issue);
  return apiError(500, 'Something went wrong');
}

/** GET /api/homes — the caller's homes. */
export async function listHomes(req: Request, deps: RouteDeps): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const { data, error } = await deps
    .db(token)
    .rpc<{ id: string; name: string; room_count: number }[]>('list_homes', {});
  if (error) return dbErrorResponse(error);
  return json<ListHomesResponse>({
    homes: (data ?? []).map((h) => ({ id: h.id, name: h.name, roomCount: h.room_count })),
  });
}

/** POST /api/homes — create a home owned by the caller. */
export async function createHome(req: Request, deps: RouteDeps): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const body = CreateHomeRequest.safeParse(await readJson(req));
  if (!body.success) return apiError(400, 'Invalid input');
  const { data, error } = await deps
    .db(token)
    .rpc<string>('create_home', { p_name: body.data.name });
  if (error) return dbErrorResponse(error);
  if (!data) return apiError(500, 'Something went wrong');
  return json<CreateHomeResponse>({ homeId: data }, 201);
}

/** GET /api/homes/:id — home, rooms, processing progress and floor plan. */
export async function getHome(req: Request, params: unknown, deps: RouteDeps): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const id = IdParam.safeParse(params);
  if (!id.success) return apiError(400, 'Invalid home id');
  const { data, error } = await deps.db(token).rpc<unknown>('get_home', { p_home_id: id.data.id });
  if (error) return dbErrorResponse(error);
  const row = HomeRow.safeParse(data);
  if (!row.success) return badRow('home', row.error.issues);
  return json<HomeDetail>({
    ...row.data,
    progress: row.data.progress.map((p) => toRoomProgress(p, deps.env)),
  });
}

/** One poll of public.home_status(): the status event, or an error Response. */
export async function readHomeStatus(
  db: ReturnType<RouteDeps['db']>,
  homeId: string,
  env: ServerEnv,
): Promise<HomeStatusEvent | Response> {
  const { data, error } = await db.rpc<unknown>('home_status', { p_home_id: homeId });
  if (error) return dbErrorResponse(error);
  const row = StatusRow.safeParse(data);
  if (!row.success) return badRow('status', row.error.issues);
  return { rooms: row.data.rooms.map((p) => toRoomProgress(p, env)) };
}

/** PUT /api/homes/:id/floor-plan — save the FloorPlan and seat confirmations together. */
export async function saveFloorPlan(
  req: Request,
  params: unknown,
  deps: RouteDeps,
): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const id = IdParam.safeParse(params);
  if (!id.success) return apiError(400, 'Invalid home id');
  const body = SaveFloorPlanRequest.safeParse(await readJson(req));
  if (!body.success) return apiError(400, 'Invalid floor plan');
  const { error } = await deps.db(token).rpc<null>('save_floor_plan', {
    p_home_id: id.data.id,
    p_plan: body.data.floorPlan,
    p_seats: body.data.seats,
  });
  if (error) return dbErrorResponse(error);
  return new Response(null, { status: 204 });
}
