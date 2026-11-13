import { describe, expect, it } from 'vitest';
import { verifyJoinTicket, type FloorPlan, type Room, type VisitResponse } from '@home-tour/shared';
import { fakeDeps, request } from './fakes';
import { createInvite, joinWithInvite, ownerVisit, previewInvite } from './visits';

const HOME = '3f0c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f60';
const ROOM = '7b1c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f62';
const TOKEN = 'a'.repeat(64);
const SECRET = 't'.repeat(40); // fakeDeps' ticketSecret
const plan: FloorPlan = {
  rooms: [{ roomId: ROOM, x: 0, z: 0, rotationYaw: 0 }],
  spawn: { x: 0, z: 0, yaw: 0 },
  scale: 1,
};
const room = (over: Partial<Room> = {}): Room => ({
  id: ROOM,
  homeId: HOME,
  name: 'Salon',
  status: 'ready',
  splatUrl: 'https://cdn.test/r/lod-meta.json',
  collisionUrl: 'https://cdn.test/r/collision.glb',
  seats: [],
  transform: { position: [0, 0, 0], rotationYaw: 0, scale: 1 },
  ...over,
});
const homeRow = { id: HOME, name: 'Our flat', floorPlan: plan, rooms: [room()] };
const guest = { name: 'Ayşe', avatarId: 'villager-f', tint: '#aa3355' };

describe('createInvite', () => {
  it('needs sign-in and returns the token', async () => {
    const { deps } = fakeDeps({
      create_invite: {
        data: [{ token: TOKEN, expires_at: '2026-12-01T00:00:00+00:00' }],
        error: null,
      },
    });
    expect((await createInvite(request('POST', undefined, null), { id: HOME }, deps)).status).toBe(
      401,
    );
    const res = await createInvite(request('POST'), { id: HOME }, deps);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ token: TOKEN, expiresAt: '2026-12-01T00:00:00.000Z' });
  });

  it('maps a foreign home to 404', async () => {
    const { deps } = fakeDeps({
      create_invite: { data: null, error: { code: 'P0002', message: 'home not found' } },
    });
    expect((await createInvite(request('POST'), { id: HOME }, deps)).status).toBe(404);
  });
});

describe('join with invite', () => {
  it('previews the home as anon', async () => {
    const { deps, db } = fakeDeps({ resolve_invite: { data: homeRow, error: null } });
    const res = await previewInvite({ token: TOKEN }, deps);
    expect(await res.json()).toEqual({ homeId: HOME, homeName: 'Our flat' });
    expect(db).toHaveBeenCalledWith(null);
  });

  it('404s malformed, expired or revoked tokens without hitting a bad query', async () => {
    const { deps, rpc } = fakeDeps({
      resolve_invite: { data: null, error: { code: 'P0002', message: 'invite not found' } },
    });
    expect((await previewInvite({ token: 'nope' }, deps)).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
    const res = await joinWithInvite(request('POST', guest, null), { token: TOKEN }, deps);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/expired|revoked/);
  });

  it('signs a guest ticket for this home', async () => {
    const { deps } = fakeDeps({ resolve_invite: { data: homeRow, error: null } });
    const res = await joinWithInvite(request('POST', guest, null), { token: TOKEN }, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as VisitResponse;
    expect(body).toMatchObject({
      homeId: HOME,
      homeName: 'Our flat',
      floorPlan: plan,
      realtimeUrl: 'ws://realtime.test',
    });
    const t = await verifyJoinTicket(body.ticket, SECRET);
    expect(t).toMatchObject({ homeId: HOME, name: 'Ayşe', avatarId: 'villager-f', role: 'guest' });
  });

  it('rejects bad names and characters', async () => {
    const { deps } = fakeDeps({ resolve_invite: { data: homeRow, error: null } });
    for (const body of [
      { ...guest, name: '   ' },
      { ...guest, name: 'x'.repeat(25) },
      { ...guest, avatarId: 'dragon' },
      { ...guest, tint: 'red' },
    ]) {
      expect(
        (await joinWithInvite(request('POST', body, null), { token: TOKEN }, deps)).status,
      ).toBe(400);
    }
  });

  it('409s a home without a floor plan, 500s without a ticket secret', async () => {
    const noPlan = fakeDeps({
      resolve_invite: { data: { ...homeRow, floorPlan: null }, error: null },
    });
    expect(
      (await joinWithInvite(request('POST', guest, null), { token: TOKEN }, noPlan.deps)).status,
    ).toBe(409);
    const noSecret = fakeDeps({ resolve_invite: { data: homeRow, error: null } });
    noSecret.deps.env.ticketSecret = null;
    expect(
      (await joinWithInvite(request('POST', guest, null), { token: TOKEN }, noSecret.deps)).status,
    ).toBe(500);
  });
});

describe('ownerVisit', () => {
  it('signs an owner ticket and drops rooms without files', async () => {
    const queued = room({
      id: '8b1c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f63',
      status: 'queued',
      splatUrl: null,
      collisionUrl: null,
    });
    const { deps, db } = fakeDeps({
      get_home: { data: { ...homeRow, rooms: [room(), queued], progress: [] }, error: null },
    });
    expect((await ownerVisit(request('POST', guest, null), { id: HOME }, deps)).status).toBe(401);
    const res = await ownerVisit(request('POST', guest), { id: HOME }, deps);
    const body = (await res.json()) as VisitResponse;
    expect(body.rooms.map((r) => r.id)).toEqual([ROOM]);
    expect((await verifyJoinTicket(body.ticket, SECRET))?.role).toBe('owner');
    expect(db).toHaveBeenCalledWith('user-jwt');
  });
});
