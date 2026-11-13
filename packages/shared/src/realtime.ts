import { z } from 'zod';
import { Vec3 } from './geometry.js';

export const MAX_PLAYERS_PER_HOME = 8;
export const CHAT_MAX_LENGTH = 200;

export const AnimState = z.union([
  z.enum(['idle', 'walk', 'sit']),
  z.templateLiteral(['emote:', z.string().regex(/^[a-z0-9-]{1,32}$/)]),
]);
export type AnimState = z.infer<typeof AnimState>;

export const TransformMessage = z.object({
  type: z.literal('transform'),
  position: Vec3,
  yaw: z.number(),
});

export const AnimMessage = z.object({
  type: z.literal('anim'),
  state: AnimState,
});

export const SeatClaimMessage = z.object({
  type: z.literal('seatClaim'),
  seatId: z.string().min(1),
});

export const SeatReleaseMessage = z.object({
  type: z.literal('seatRelease'),
  seatId: z.string().min(1),
});

export const ChatMessage = z.object({
  type: z.literal('chat'),
  text: z.string().trim().min(1).max(CHAT_MAX_LENGTH),
});

/** Messages a client sends to the home's realtime room. */
export const ClientMessage = z.discriminatedUnion('type', [
  TransformMessage,
  AnimMessage,
  SeatClaimMessage,
  SeatReleaseMessage,
  ChatMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Preset characters (GLBs in packages/viewer/public/avatars). */
export const AVATAR_IDS = ['villager-m', 'villager-f', 'villager-m-beard', 'mannequin'] as const;
export const AvatarId = z.enum(AVATAR_IDS);
export type AvatarId = z.infer<typeof AvatarId>;

/** The 6 emote wheel slots; sent as anim `emote:<id>`. */
export const EMOTE_IDS = ['wave', 'dance', 'clap', 'cheer', 'yes', 'no'] as const;
export type EmoteId = (typeof EMOTE_IDS)[number];

/** '#rrggbb' clothes tint. */
export const Tint = z.string().regex(/^#[0-9a-f]{6}$/i);

export const DisplayName = z.string().trim().min(1).max(24);

/** Colyseus room name; one room per home, matched by `homeId`. */
export const HOME_ROOM = 'home';
/** Clients send transforms at most this often; the server drops faster ones. */
export const TRANSFORM_HZ = 15;
/** Chat rate limit: at most CHAT_BURST messages per CHAT_WINDOW_MS. */
export const CHAT_BURST = 5;
export const CHAT_WINDOW_MS = 10_000;
/** Chat bubble lifetime over an avatar's head. */
export const CHAT_BUBBLE_MS = 5_000;

/** Signed by apps/web, checked by apps/realtime (see ticket.ts). */
export const JoinTicketPayload = z.object({
  homeId: z.uuid(),
  name: DisplayName,
  avatarId: AvatarId,
  tint: Tint,
  role: z.enum(['owner', 'guest']),
  /** Unix ms; the ticket only has to survive until the socket opens. */
  exp: z.number().int(),
});
export type JoinTicketPayload = z.infer<typeof JoinTicketPayload>;

/** Options a client passes to joinOrCreate(HOME_ROOM, ...). */
export const JoinOptions = z.object({ homeId: z.uuid(), ticket: z.string().min(1).max(2000) });
export type JoinOptions = z.infer<typeof JoinOptions>;

/** Server -> client: a chat line, relayed to everyone (sender included). */
export const ChatBroadcast = z.object({
  id: z.number().int(),
  sessionId: z.string(),
  name: z.string(),
  text: z.string(),
  at: z.number(),
});
export type ChatBroadcast = z.infer<typeof ChatBroadcast>;

/** Server -> client: a seatClaim was refused (someone else sits there). */
export const SeatDenied = z.object({ seatId: z.string() });
export type SeatDenied = z.infer<typeof SeatDenied>;

/** Server -> client message types besides state patches. */
export const SERVER_MESSAGES = {
  chat: 'chat',
  seatDenied: 'seatDenied',
  chatLimited: 'chatLimited',
} as const;
