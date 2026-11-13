import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { HOME_ROOM } from '@home-tour/shared';
import { HomeRoom, config } from './home-room.ts';

const secret = process.env.REALTIME_TICKET_SECRET ?? '';
if (secret.length < 32) {
  console.error('REALTIME_TICKET_SECRET must be set (32+ chars, same value as apps/web)');
  process.exit(1);
}
config.ticketSecret = secret;

const port = Number(process.env.PORT ?? 2567);
const server = new Server({ transport: new WebSocketTransport() });
server.define(HOME_ROOM, HomeRoom).filterBy(['homeId']);
await server.listen(port);
console.log(`realtime listening on ws://localhost:${port}`);
