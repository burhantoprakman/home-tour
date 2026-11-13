import { z } from 'zod';
import { FloorPlan } from './floor-plan.js';
import { JobStage } from './job.js';
import { Room, RoomStatus } from './room.js';
import { AvatarId, DisplayName, Tint } from './realtime.js';

/** Room video formats the owner may upload; the value is the file extension in Storage. */
export const VIDEO_CONTENT_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
} as const;
export type VideoContentType = keyof typeof VIDEO_CONTENT_TYPES;
export type VideoExtension = (typeof VIDEO_CONTENT_TYPES)[VideoContentType];

/** Object path of a room's video inside STORAGE_BUCKETS.videos (the worker's `video_path`). */
export function roomVideoPath(roomId: string, ext: VideoExtension): string {
  return `rooms/${roomId}/video.${ext}`;
}

/** Optional details-pass video from the iOS capture app (same bucket). */
export function roomDetailsVideoPath(roomId: string, ext: VideoExtension): string {
  return `rooms/${roomId}/details.${ext}`;
}

/** capture.zip from the iOS capture app: poses.jsonl + objects.json + device.json. */
export function roomCaptureBundlePath(roomId: string): string {
  return `rooms/${roomId}/capture.zip`;
}

/** Path params of /homes/:id/... and /rooms/:id/... routes. */
export const IdParam = z.object({ id: z.uuid() });

/** POST /api/homes/:id/rooms */
export const CreateRoomRequest = z.object({
  name: Room.shape.name,
  contentType: z.enum(
    Object.keys(VIDEO_CONTENT_TYPES) as [VideoContentType, ...VideoContentType[]],
  ),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;

/**
 * A TUS (resumable) upload target in Supabase Storage. The client sends its own
 * `Authorization: Bearer <access token>` + `apikey` headers and these values as TUS metadata
 * (bucketName, objectName, contentType); Storage requires chunks of exactly `chunkSize` bytes.
 */
export const ResumableUpload = z.object({
  protocol: z.literal('tus'),
  endpoint: z.url(),
  bucketName: z.string().min(1),
  objectName: z.string().min(1),
  contentType: z.string().min(1),
  chunkSize: z.number().int().positive(),
});
export type ResumableUpload = z.infer<typeof ResumableUpload>;

export const CreateRoomResponse = z.object({
  roomId: z.uuid(),
  jobId: z.uuid(),
  upload: ResumableUpload,
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;

/** POST /api/rooms/:id/uploaded -> 202 once the processing job has been enqueued. */
export const RoomUploadedResponse = z.object({
  roomId: z.uuid(),
  jobId: z.uuid(),
});
export type RoomUploadedResponse = z.infer<typeof RoomUploadedResponse>;

/** POST /api/homes */
export const CreateHomeRequest = z.object({ name: z.string().trim().min(1).max(60) });
export type CreateHomeRequest = z.infer<typeof CreateHomeRequest>;

export const CreateHomeResponse = z.object({ homeId: z.uuid() });
export type CreateHomeResponse = z.infer<typeof CreateHomeResponse>;

/** GET /api/homes -> the caller's homes, newest first. */
export const HomeSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  roomCount: z.number().int().nonnegative(),
});
export type HomeSummary = z.infer<typeof HomeSummary>;

export const ListHomesResponse = z.object({ homes: z.array(HomeSummary) });
export type ListHomesResponse = z.infer<typeof ListHomesResponse>;

/** Processing state of one room, from its newest `jobs` row. */
export const RoomProgress = z.object({
  roomId: z.uuid(),
  status: RoomStatus,
  stage: JobStage,
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  // Where to (re)send the video; null once the upload finished and the job was enqueued.
  upload: ResumableUpload.nullable(),
});
export type RoomProgress = z.infer<typeof RoomProgress>;

/** GET /api/homes/:id */
export const HomeDetail = z.object({
  id: z.uuid(),
  name: z.string(),
  rooms: z.array(Room),
  progress: z.array(RoomProgress),
  // Null until the owner first saves the floor plan.
  floorPlan: FloorPlan.nullable(),
});
export type HomeDetail = z.infer<typeof HomeDetail>;

/** GET /api/homes/:id/status: server-sent events. `status` data = HomeStatusEvent. */
export const HomeStatusEvent = z.object({ rooms: z.array(RoomProgress) });
export type HomeStatusEvent = z.infer<typeof HomeStatusEvent>;

/**
 * PUT /api/homes/:id/floor-plan: the plan plus, per room, the ids of the seats the owner
 * confirmed (that room's other seats become unconfirmed). Each room appears at most once.
 */
export const SaveFloorPlanRequest = z.object({
  floorPlan: FloorPlan.refine(
    (plan) => new Set(plan.rooms.map((r) => r.roomId)).size === plan.rooms.length,
    'Each room may appear only once',
  ),
  seats: z
    .array(z.object({ roomId: z.uuid(), confirmedSeatIds: z.array(z.string().min(1)).max(200) }))
    .max(100)
    .refine(
      (rooms) => new Set(rooms.map((r) => r.roomId)).size === rooms.length,
      'Each room may appear only once',
    ),
});
export type SaveFloorPlanRequest = z.infer<typeof SaveFloorPlanRequest>;

/** Error body of every API route. */
export const ApiError = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiError>;

/** POST /api/homes/:id/invites (owner) -> a link anyone can open to join the home. */
export const CreateInviteResponse = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

/** Path params of /api/join/:token. */
export const InviteTokenParam = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });

/** GET /api/join/:token -> what the join page shows before the guest picks a name. */
export const InvitePreview = z.object({ homeId: z.uuid(), homeName: z.string() });
export type InvitePreview = z.infer<typeof InvitePreview>;

/** POST /api/join/:token (guest) and POST /api/homes/:id/visit (owner). */
export const VisitRequest = z.object({ name: DisplayName, avatarId: AvatarId, tint: Tint });
export type VisitRequest = z.infer<typeof VisitRequest>;

/** Everything the visit page needs: the home to load and a ticket for the realtime room. */
export const VisitResponse = z.object({
  homeId: z.uuid(),
  homeName: z.string(),
  rooms: z.array(Room),
  floorPlan: FloorPlan,
  ticket: z.string(),
  realtimeUrl: z.string().min(1),
});
export type VisitResponse = z.infer<typeof VisitResponse>;

/** Path params of /api/capture/:token/... (a capture token, see signCaptureToken). */
export const CaptureTokenParam = z.object({ token: z.string().min(20).max(1000) });

/** POST /api/rooms/:id/capture-token (owner) -> what the QR code encodes. */
export const CaptureTokenResponse = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  /** hometour://pair?api=<origin>&token=<token> */
  pairUrl: z.string(),
});
export type CaptureTokenResponse = z.infer<typeof CaptureTokenResponse>;

/**
 * One file the app sends: a tus target plus the headers that authorise it. The app has no
 * Supabase session, so `headers` carry a signed upload token valid for this object only.
 */
export const CaptureUploadTarget = z.object({
  upload: ResumableUpload,
  headers: z.record(z.string(), z.string()),
});
export type CaptureUploadTarget = z.infer<typeof CaptureUploadTarget>;

/** POST /api/capture/:token/uploads -> where the app sends each file. */
export const CaptureUploadsResponse = z.object({
  roomId: z.uuid(),
  roomName: z.string(),
  homeName: z.string(),
  video: CaptureUploadTarget,
  details: CaptureUploadTarget,
  bundle: CaptureUploadTarget,
});
export type CaptureUploadsResponse = z.infer<typeof CaptureUploadsResponse>;

/** POST /api/capture/:token/done: all files sent; starts processing. */
export const CaptureDoneRequest = z.object({ details: z.boolean() });
export type CaptureDoneRequest = z.infer<typeof CaptureDoneRequest>;
