import { describe, expect, it } from 'vitest';
import {
  signCaptureToken,
  signJoinTicket,
  verifyCaptureToken,
  verifyJoinTicket,
} from './ticket.js';
import type { JoinTicketPayload } from './realtime.js';

const SECRET = 'x'.repeat(40);
const payload: JoinTicketPayload = {
  homeId: '3f0c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f60',
  name: 'Ayşe',
  avatarId: 'villager-f',
  tint: '#4a7bd0',
  role: 'guest',
  exp: 2_000_000_000_000,
};

describe('join tickets', () => {
  it('round-trips', async () => {
    const t = await signJoinTicket(payload, SECRET);
    expect(await verifyJoinTicket(t, SECRET, 1_000)).toEqual(payload);
  });

  it('rejects a wrong secret, a tampered body and an expired ticket', async () => {
    const t = await signJoinTicket(payload, SECRET);
    expect(await verifyJoinTicket(t, 'y'.repeat(40), 1_000)).toBeNull();
    const [, sig] = t.split('.');
    const [forged] = (await signJoinTicket({ ...payload, role: 'owner' }, 'z'.repeat(40))).split(
      '.',
    );
    expect(await verifyJoinTicket(`${forged}.${sig}`, SECRET, 1_000)).toBeNull();
    expect(await verifyJoinTicket(t, SECRET, payload.exp + 1)).toBeNull();
  });

  it('rejects garbage', async () => {
    for (const t of ['', 'a', 'a.b', 'a.b.c', '!!!.???']) {
      expect(await verifyJoinTicket(t, SECRET)).toBeNull();
    }
  });

  it('refuses short secrets', async () => {
    await expect(signJoinTicket(payload, 'short')).rejects.toThrow(/32/);
  });
});

describe('capture tokens', () => {
  const cap = {
    roomId: '3f0c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f61',
    homeId: '3f0c8a6e-6b7e-4c5a-9a59-1b2c3d4e5f60',
    exp: 2_000_000_000_000,
  };

  it('round-trips and expires', async () => {
    const t = await signCaptureToken(cap, SECRET);
    expect(await verifyCaptureToken(t, SECRET, 1_000)).toEqual(cap);
    expect(await verifyCaptureToken(t, SECRET, cap.exp + 1)).toBeNull();
    expect(await verifyCaptureToken(t, 'y'.repeat(40), 1_000)).toBeNull();
  });

  it('is not interchangeable with a join ticket', async () => {
    const join = await signJoinTicket(payload, SECRET);
    expect(await verifyCaptureToken(join, SECRET, 1_000)).toBeNull();
    const capture = await signCaptureToken(cap, SECRET);
    expect(await verifyJoinTicket(capture, SECRET, 1_000)).toBeNull();
  });
});
