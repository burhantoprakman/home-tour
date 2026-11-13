import { Room, type Client } from '@colyseus/core';
import type { z } from 'zod';
import {
  AnimMessage,
  ChatMessage,
  JoinOptions,
  MAX_PLAYERS_PER_HOME,
  SERVER_MESSAGES,
  SeatClaimMessage,
  SeatReleaseMessage,
  TRANSFORM_HZ,
  TransformMessage,
  verifyJoinTicket,
  type ChatBroadcast,
  type JoinTicketPayload,
  type SeatDenied,
} from '@home-tour/shared';
import { HomeState, Player } from './state.ts';
import { MAX_COORD_M, MIN_TRANSFORM_GAP_MS, RateLimiter } from './limits.ts';

/** Seconds a dropped client (phone sleep, Wi-Fi switch) keeps its avatar and seat. */
export const RECONNECT_S = 15;

interface ClientData {
  lastTransform: number;
  chat: RateLimiter;
}

type HomeClient = Client<{ userData: ClientData; auth: JoinTicketPayload }>;

// Colyseus routes by message type, so payloads are the shared messages minus `type`.
const TransformPayload = TransformMessage.omit({ type: true });
const AnimPayload = AnimMessage.omit({ type: true });
const SeatClaimPayload = SeatClaimMessage.omit({ type: true });
const SeatReleasePayload = SeatReleaseMessage.omit({ type: true });
const ChatPayload = ChatMessage.omit({ type: true });

/** A handler that ignores payloads `schema` rejects (Colyseus' parsed() would disconnect). */
function parsed<S extends z.ZodType>(
  schema: S,
  handler: (client: HomeClient, msg: z.infer<S>) => void,
) {
  return (client: HomeClient, raw: unknown) => {
    const res = schema.safeParse(raw);
    if (res.success) handler(client, res.data);
  };
}

/** Homes with a live room in this process. One process serves all homes (MVP), so this is
 * what stops a ninth player from opening a second room for the same home. */
const liveHomes = new Set<string>();

export const HOME_FULL = 'This home is full (8 people).';

/** Ticket secret; main.ts sets it from REALTIME_TICKET_SECRET, tests set their own. */
export const config = { ticketSecret: '' };

/** One per home (matched on `homeId`). Relays avatars, owns seats, relays chat. */
export class HomeRoom extends Room<{ state: HomeState }> {
  maxClients = MAX_PLAYERS_PER_HOME;
  patchRate = 1000 / TRANSFORM_HZ;
  // 15 transforms + anim changes + chat; well above honest use, kicks floods.
  maxMessagesPerSecond = 40;
  state = new HomeState();
  private homeId = '';
  private chatId = 0;

  messages = {
    transform: parsed(TransformPayload, (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      const data = client.userData;
      if (!p || !data) return;
      const now = Date.now();
      if (now - data.lastTransform < MIN_TRANSFORM_GAP_MS) return;
      const [x, y, z] = msg.position;
      if (![x, y, z, msg.yaw].every(Number.isFinite)) return;
      if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > MAX_COORD_M) return;
      data.lastTransform = now;
      p.x = x;
      p.y = y;
      p.z = z;
      p.yaw = msg.yaw;
      p.placed = true;
    }),
    anim: parsed(AnimPayload, (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.anim = msg.state;
    }),
    seatClaim: parsed(SeatClaimPayload, (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const holder = this.seatHolder(msg.seatId);
      if (holder && holder !== client.sessionId) {
        client.send(SERVER_MESSAGES.seatDenied, { seatId: msg.seatId } satisfies SeatDenied);
        return;
      }
      p.seatId = msg.seatId;
    }),
    seatRelease: parsed(SeatReleasePayload, (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (p && p.seatId === msg.seatId) p.seatId = '';
    }),
    chat: parsed(ChatPayload, (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !client.userData) return;
      const now = Date.now();
      if (!client.userData.chat.allow(now)) {
        client.send(SERVER_MESSAGES.chatLimited, {});
        return;
      }
      const line: ChatBroadcast = {
        id: ++this.chatId,
        sessionId: client.sessionId,
        name: p.name,
        text: msg.text,
        at: now,
      };
      this.broadcast(SERVER_MESSAGES.chat, line);
    }),
  };

  onCreate(options: unknown) {
    const homeId = JoinOptions.shape.homeId.parse(
      (options as { homeId?: unknown } | undefined)?.homeId,
    );
    if (liveHomes.has(homeId)) throw new Error(HOME_FULL);
    liveHomes.add(homeId);
    this.homeId = homeId;
  }

  async onAuth(_client: Client, options: unknown): Promise<JoinTicketPayload> {
    const opts = JoinOptions.safeParse(options);
    if (!opts.success) throw new Error('bad join options');
    const ticket = await verifyJoinTicket(opts.data.ticket, config.ticketSecret);
    if (!ticket || ticket.homeId !== this.homeId || opts.data.homeId !== this.homeId) {
      throw new Error('invalid or expired ticket');
    }
    return ticket;
  }

  onJoin(client: HomeClient) {
    const t = client.auth;
    if (!t) throw new Error('joined without auth');
    client.userData = { lastTransform: 0, chat: new RateLimiter() };
    this.state.players.set(
      client.sessionId,
      new Player({
        name: t.name,
        avatarId: t.avatarId,
        tint: t.tint,
        placed: false,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        anim: 'idle',
        seatId: '',
      }),
    );
  }

  async onDrop(client: HomeClient) {
    await this.allowReconnection(client, RECONNECT_S);
  }

  onLeave(client: HomeClient) {
    // Deleting the player also frees its seat: seats live on the player.
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    liveHomes.delete(this.homeId);
  }

  private seatHolder(seatId: string): string | null {
    for (const [id, p] of this.state.players) if (p.seatId === seatId) return id;
    return null;
  }
}
