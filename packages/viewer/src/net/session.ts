/**
 * Net adapter: joins the home's Colyseus room with a join ticket and wires it to a Viewer.
 * Local transform/anim/seat events go up; the server's player state comes down as interpolated
 * remote avatars; chat lines become bubbles. The HUD (hud.ts) shows chat and the emote wheel.
 */
import { Client, type Room } from '@colyseus/sdk';
import {
  HOME_ROOM,
  SERVER_MESSAGES,
  type AnimState,
  type ChatBroadcast,
  type Vec3,
} from '@home-tour/shared';
import type { RemotePlayer, Viewer } from '../viewer.ts';

export type NetStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface PlayerInfo {
  id: string;
  name: string;
  self: boolean;
}

export interface HomeSessionHooks {
  status?(status: NetStatus, reason?: string): void;
  chat?(line: ChatBroadcast, mine: boolean): void;
  chatLimited?(): void;
  players?(players: PlayerInfo[]): void;
}

export interface HomeSession {
  readonly sessionId: string;
  sendChat(text: string): void;
  leave(): Promise<void>;
}

/** The decoded server state (schema in apps/realtime/src/state.ts). */
interface WirePlayer {
  name: string;
  avatarId: string;
  tint: string;
  placed: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: string;
  seatId: string;
}
interface WireState {
  players: Map<string, WirePlayer>;
}

export async function joinHome(
  viewer: Viewer,
  opts: { realtimeUrl: string; homeId: string; ticket: string },
  hooks: HomeSessionHooks = {},
): Promise<HomeSession> {
  // Remember the latest local state from the start, so it can be sent as soon as we join
  // (the viewer only emits on change).
  let transform: { position: Vec3; yaw: number } | null = null;
  let anim: AnimState = 'idle';
  let seat: string | null = null;
  let room: Room<unknown, WireState> | null = null;

  const offs = [
    viewer.on('transform', (t) => {
      transform = t;
      room?.send('transform', t);
    }),
    viewer.on('anim', (a) => {
      anim = a;
      room?.send('anim', { state: a });
    }),
    viewer.on('seat', ({ seatId }) => {
      if (seat && seat !== seatId) room?.send('seatRelease', { seatId: seat });
      if (seatId) room?.send('seatClaim', { seatId });
      seat = seatId;
    }),
  ];

  hooks.status?.('connecting');
  try {
    room = await new Client(opts.realtimeUrl).joinOrCreate<WireState>(HOME_ROOM, {
      homeId: opts.homeId,
      ticket: opts.ticket,
    });
  } catch (err) {
    offs.forEach((off) => off());
    const msg = err instanceof Error ? err.message : String(err);
    hooks.status?.('disconnected', msg);
    throw err;
  }
  const r = room;
  hooks.status?.('connected');

  const sendLocal = () => {
    if (transform) r.send('transform', transform);
    r.send('anim', { state: anim });
    if (seat) r.send('seatClaim', { seatId: seat });
  };
  sendLocal();

  let lastRoster = '';
  r.onStateChange((state) => {
    const remotes: RemotePlayer[] = [];
    const roster: PlayerInfo[] = [];
    for (const [id, p] of state.players) {
      roster.push({ id, name: p.name, self: id === r.sessionId });
      if (id === r.sessionId || !p.placed) continue;
      remotes.push({
        id,
        name: p.name,
        avatarId: p.avatarId,
        tint: p.tint,
        position: [p.x, p.y, p.z],
        yaw: p.yaw,
        anim: p.anim as AnimState,
        seatId: p.seatId || null,
      });
    }
    viewer.setRemotePlayers(remotes);
    const key = roster.map((p) => `${p.id}:${p.name}`).join('|');
    if (key !== lastRoster) {
      lastRoster = key;
      hooks.players?.(roster);
    }
  });
  r.onMessage(SERVER_MESSAGES.chat, (line: ChatBroadcast) => {
    const mine = line.sessionId === r.sessionId;
    viewer.say(mine ? null : line.sessionId, line.text);
    hooks.chat?.(line, mine);
  });
  r.onMessage(SERVER_MESSAGES.seatDenied, () => {
    seat = null;
    viewer.releaseSeat();
  });
  r.onMessage(SERVER_MESSAGES.chatLimited, () => hooks.chatLimited?.());
  r.onDrop(() => hooks.status?.('reconnecting'));
  r.onReconnect(() => {
    hooks.status?.('connected');
    sendLocal();
  });
  r.onLeave((code: number) => {
    viewer.setRemotePlayers([]);
    hooks.status?.('disconnected', code === 4000 ? undefined : `connection closed (${code})`);
  });

  return {
    sessionId: r.sessionId,
    sendChat(text) {
      const t = text.trim();
      if (t) r.send('chat', { text: t.slice(0, 200) });
    },
    async leave() {
      offs.forEach((off) => off());
      await r.leave();
    },
  };
}
