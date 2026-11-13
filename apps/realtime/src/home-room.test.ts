import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, type Room } from '@colyseus/sdk';
import {
  HOME_ROOM,
  SERVER_MESSAGES,
  signJoinTicket,
  type ChatBroadcast,
  type JoinTicketPayload,
} from '@home-tour/shared';
import { HomeRoom, config } from './home-room.ts';

const SECRET = 's'.repeat(40);
const HOME = '3f0c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f60';
const OTHER_HOME = '9a0c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f61';
const port = 30_000 + Math.floor(Math.random() * 20_000);
let server: Server;
const client = () => new Client(`ws://localhost:${port}`);

function ticket(over: Partial<JoinTicketPayload> = {}, secret = SECRET) {
  return signJoinTicket(
    {
      homeId: HOME,
      name: 'Guest',
      avatarId: 'villager-m',
      tint: '#4a7bd0',
      role: 'guest',
      exp: Date.now() + 60_000,
      ...over,
    },
    secret,
  );
}

async function join(over: Partial<JoinTicketPayload> = {}): Promise<Room> {
  const homeId = over.homeId ?? HOME;
  return client().joinOrCreate(HOME_ROOM, { homeId, ticket: await ticket(over) });
}

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const players = (r: Room): Map<string, any> => (r.state as any).players;

beforeAll(async () => {
  config.ticketSecret = SECRET;
  server = new Server({ transport: new WebSocketTransport(), greet: false } as never);
  server.define(HOME_ROOM, HomeRoom).filterBy(['homeId']);
  await server.listen(port);
});

afterAll(async () => {
  await server.gracefullyShutdown(false);
});

describe('HomeRoom', () => {
  it('rejects bad, foreign and expired tickets', async () => {
    await expect(
      client().joinOrCreate(HOME_ROOM, { homeId: HOME, ticket: 'nope' }),
    ).rejects.toThrow();
    await expect(
      client().joinOrCreate(HOME_ROOM, { homeId: HOME, ticket: await ticket({}, 'w'.repeat(40)) }),
    ).rejects.toThrow();
    await expect(
      client().joinOrCreate(HOME_ROOM, {
        homeId: HOME,
        ticket: await ticket({ homeId: OTHER_HOME }),
      }),
    ).rejects.toThrow();
    await expect(join({ exp: Date.now() - 1 })).rejects.toThrow();
  });

  it('relays transforms and anim, and keeps homes apart', async () => {
    const a = await join({ name: 'Ayse' });
    const b = await join({ name: 'Bora', avatarId: 'villager-f' });
    const other = await join({ homeId: OTHER_HOME });
    expect(b.roomId).toBe(a.roomId);
    expect(other.roomId).not.toBe(a.roomId);
    a.send('transform', { position: [1, 0, 2], yaw: 0.5 });
    a.send('anim', { state: 'walk' });
    await tick();
    const seen = players(b).get(a.sessionId);
    expect(seen).toMatchObject({ name: 'Ayse', placed: true, x: 1, z: 2, yaw: 0.5, anim: 'walk' });
    expect(players(b).get(b.sessionId)).toMatchObject({ avatarId: 'villager-f', placed: false });
    expect(players(other).size).toBe(1);
    // Invalid payloads don't move anyone.
    a.send('transform', { position: [1e9, 0, 0], yaw: 0 });
    a.send('anim', { state: 'fly' });
    await tick();
    expect(players(b).get(a.sessionId)).toMatchObject({ x: 1, anim: 'walk' });
    await Promise.all([a.leave(), b.leave(), other.leave()]);
  });

  it('caps a home at 8 players', async () => {
    const rooms = await Promise.all(Array.from({ length: 8 }, (_, i) => join({ name: `P${i}` })));
    expect(new Set(rooms.map((r) => r.roomId)).size).toBe(1);
    await expect(join({ name: 'P8' })).rejects.toThrow(/full/);
    const [first, second] = rooms;
    if (!first || !second) throw new Error('8 rooms expected');
    await first.leave();
    await tick();
    const late = await join({ name: 'P9' });
    expect(late.roomId).toBe(second.roomId);
    await Promise.all([...rooms.slice(1), late].map((r) => r.leave()));
  });

  it('gives each seat to one player and frees it on release and leave', async () => {
    const a = await join();
    const b = await join();
    const denied: string[] = [];
    b.onMessage(SERVER_MESSAGES.seatDenied, (m: { seatId: string }) => denied.push(m.seatId));
    a.send('seatClaim', { seatId: 'room1:seat-1' });
    await tick();
    b.send('seatClaim', { seatId: 'room1:seat-1' });
    await tick();
    expect(denied).toEqual(['room1:seat-1']);
    expect(players(b).get(a.sessionId).seatId).toBe('room1:seat-1');
    a.send('seatRelease', { seatId: 'room1:seat-1' });
    await tick();
    b.send('seatClaim', { seatId: 'room1:seat-1' });
    await tick();
    expect(players(a).get(b.sessionId).seatId).toBe('room1:seat-1');
    await b.leave();
    await tick();
    a.send('seatClaim', { seatId: 'room1:seat-1' });
    await tick();
    expect(players(a).get(a.sessionId).seatId).toBe('room1:seat-1');
    await a.leave();
  });

  it('relays chat to everyone and rate-limits it', async () => {
    const a = await join({ name: 'Ayse' });
    const b = await join();
    const got: ChatBroadcast[] = [];
    let limited = 0;
    b.onMessage(SERVER_MESSAGES.chat, (m: ChatBroadcast) => got.push(m));
    a.onMessage(SERVER_MESSAGES.chatLimited, () => limited++);
    a.onMessage(SERVER_MESSAGES.chat, () => {});
    for (let i = 0; i < 7; i++) a.send('chat', { text: `  hi ${i}  ` });
    a.send('chat', { text: 'x'.repeat(500) });
    await tick(300);
    expect(got.map((m) => m.text)).toEqual(['hi 0', 'hi 1', 'hi 2', 'hi 3', 'hi 4']);
    expect(got[0]).toMatchObject({ name: 'Ayse', sessionId: a.sessionId });
    expect(limited).toBe(2);
    await Promise.all([a.leave(), b.leave()]);
  });
});
