import { z } from 'zod';

/**
 * Guided capture from the native iOS app (apps/capture-ios). Per room the app uploads:
 *   video.mov    room pass (ARKit frames, HEVC, SDR, exposure locked)
 *   details.mov  optional details pass (per-object orbits)
 *   capture.zip  poses.jsonl + objects.json + device.json (schemas below)
 * Coordinates are ARKit world space: metres, +y up (gravity aligned), right-handed.
 * Camera axes are ARKit's: +x right, +y up, -z forward (the worker flips to COLMAP).
 */

export const CapturePass = z.enum(['room', 'details']);
export type CapturePass = z.infer<typeof CapturePass>;

export const TrackingState = z.enum(['normal', 'limited', 'notAvailable']);
export type TrackingState = z.infer<typeof TrackingState>;

/** One line of poses.jsonl: the camera of one recorded video frame. */
export const CapturePose = z.object({
  pass: CapturePass,
  /** Frame index within that pass's video (0-based, in presentation order). */
  frame: z.number().int().nonnegative(),
  /** Seconds since the pass's video started. */
  t: z.number().nonnegative(),
  /** Camera-to-world 4x4, column-major (simd_float4x4 layout). */
  transform: z.array(z.number()).length(16),
  /** Pinhole intrinsics in pixels of the recorded video frame. */
  fx: z.number().positive(),
  fy: z.number().positive(),
  cx: z.number(),
  cy: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  tracking: TrackingState,
  /** ARKit's limited reason, e.g. 'excessiveMotion', 'insufficientFeatures', 'initializing'. */
  trackingReason: z.string().max(40).optional(),
  /** The app showed "Slow down" for this frame (it did not count toward coverage). */
  fast: z.boolean(),
  /** Details pass: the object being orbited, if any (CaptureObject.id). */
  objectId: z.number().int().nonnegative().optional(),
});
export type CapturePose = z.infer<typeof CapturePose>;

/** objects.json: one entry per details-pass orbit. */
export const CaptureObject = z.object({
  id: z.number().int().nonnegative(),
  /** Raycast hit on the object when the orbit started (world space). */
  anchor: z.tuple([z.number(), z.number(), z.number()]),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  /** Azimuth swept around the anchor, degrees. */
  sweptDeg: z.number().nonnegative(),
});
export type CaptureObject = z.infer<typeof CaptureObject>;
export const CaptureObjects = z.array(CaptureObject).max(200);

/** device.json */
export const CaptureDevice = z.object({
  model: z.string().max(60),
  systemVersion: z.string().max(30),
  appVersion: z.string().max(30),
  video: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  exposureLocked: z.boolean(),
  lidar: z.boolean(),
  /** Height of the detected floor plane in world y, if ARKit found one. */
  floorY: z.number().nullable(),
});
export type CaptureDevice = z.infer<typeof CaptureDevice>;

/** Files inside capture.zip. */
export const CAPTURE_BUNDLE_FILES = {
  poses: 'poses.jsonl',
  objects: 'objects.json',
  device: 'device.json',
} as const;

/** Payload of a capture token (QR pairing): lets the app upload for one room, nothing else. */
export const CaptureTokenPayload = z.object({
  roomId: z.uuid(),
  homeId: z.uuid(),
  /** Unix ms. */
  exp: z.number().int(),
});
export type CaptureTokenPayload = z.infer<typeof CaptureTokenPayload>;

export const CAPTURE_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
