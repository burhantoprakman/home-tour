/**
 * 8 headless players in one home for DURATION_S: each walks a circle sending transforms at
 * TRANSFORM_HZ, switches walk/idle every few seconds and chats every 5 s. Prints per-player
 * bandwidth and how often each player saw the others move. Runs its own server.
 *
 *   pnpm --filter @home-tour/realtime loadtest [seconds]
 */
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, type Room } from '@colyseus/sdk';
import { HOME_ROOM, MAX_PLAYERS_PER_HOME, TRANSFORM_HZ, signJoinTicket } from '@home-tour/shared';
import { HomeRoom, config } from '../src/home-room.ts';

const DURATION_S = Number(process.argv[2] ?? 20);
const SECRET = 'l'.repeat(40);
const HOME = '3f0c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f60';
const port = 40_000 + Math.floor(Math.random() * 10_000);

config.ticketSecret = SECRET;
const server = new Server({ transport: new WebSocketTransport(), greet: false } as never);
server.define(HOME_ROOM, HomeRoom).filterBy(['homeId']);
await server.listen(port);

interface Bot {
  room: Room;
  down: number;
  up: number;
  /** Times another player's position changed, as seen by this bot. */
  moves: number;
  last: Map<string, string>;
}

const bots: Bot[] = [];
for (let i = 0; i < MAX_PLAYERS_PER_HOME; i++) {
  const ticket = await signJoinTicket(
    {
      homeId: HOME,
      name: `Bot ${i}`,
      avatarId: 'mannequin',
      tint: '#4a7bd0',
      role: 'guest',
      exp: Date.now() + 60_000,
    },
    SECRET,
  );
  const room = await new Client(`ws://localhost:${port}`).joinOrCreate(HOME_ROOM, {
    homeId: HOME,
    ticket,
  });
  const bot: Bot = { room, down: 0, up: 0, moves: 0, last: new Map() };
  const conn = room.connection as unknown as {
    transport: { ws: WebSocket };
    send(d: Uint8Array): void;
  };
  conn.transport.ws.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as ArrayBuffer | Blob | string;
    bot.down += typeof d === 'string' ? d.length : d instanceof Blob ? d.size : d.byteLength;
  });
  const send = conn.send.bind(conn);
  conn.send = (d) => {
    bot.up += d.length;
    send(d);
  };
  room.onMessage('chat', () => {});
  room.onStateChange((state: { players: Map<string, { x: number; z: number }> }) => {
    for (const [id, p] of state.players) {
      if (id === room.sessionId) continue;
      const key = `${p.x.toFixed(3)},${p.z.toFixed(3)}`;
      if (bot.last.get(id) !== key) bot.moves++;
      bot.last.set(id, key);
    }
  });
  bots.push(bot);
}

// Count only steady state, not the join handshakes.
for (const b of bots) b.down = b.up = b.moves = 0;
const t0 = Date.now();
const timers = bots.map((b, i) =>
  setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    const a = t * 0.5 + i;
    b.room.send('transform', { position: [3 * Math.cos(a), 0, 3 * Math.sin(a)], yaw: a });
  }, 1000 / TRANSFORM_HZ),
);
const animTimers = bots.map((b, i) =>
  setInterval(
    () => b.room.send('anim', { state: Math.random() < 0.5 ? 'walk' : 'idle' }),
    3000 + i * 100,
  ),
);
const chatTimers = bots.map((b, i) =>
  setInterval(() => b.room.send('chat', { text: `hello from ${i}` }), 5000),
);

await new Promise((r) => setTimeout(r, DURATION_S * 1000));
[...timers, ...animTimers, ...chatTimers].forEach(clearInterval);
const secs = (Date.now() - t0) / 1000;

const kbps = (bytes: number) => ((bytes * 8) / 1000 / secs).toFixed(1);
console.log(`${bots.length} players, ${secs.toFixed(1)} s, transforms at ${TRANSFORM_HZ} Hz`);
for (const [i, b] of bots.entries()) {
  const hz = b.moves / (bots.length - 1) / secs;
  console.log(
    `bot ${i}: down ${kbps(b.down)} kbit/s, up ${kbps(b.up)} kbit/s, others' updates ${hz.toFixed(1)} Hz each`,
  );
}
const avgDown = bots.reduce((s, b) => s + b.down, 0) / bots.length;
const avgUp = bots.reduce((s, b) => s + b.up, 0) / bots.length;
console.log(`average per player: down ${kbps(avgDown)} kbit/s, up ${kbps(avgUp)} kbit/s`);

await Promise.all(bots.map((b) => b.room.leave()));
await server.gracefullyShutdown(false);
