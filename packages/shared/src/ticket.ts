import type { z } from 'zod';
import { CaptureTokenPayload } from './capture.js';
import { JoinTicketPayload } from './realtime.js';

/**
 * Join tickets: `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`. apps/web signs one after
 * checking the invite (or the owner's session); apps/realtime verifies it with the same secret,
 * so the realtime server never reads the database. Web Crypto only (Node 20+ and browsers).
 */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('ticket secret must be at least 32 characters');
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Each token kind signs `<kind>:<body>`, so a join ticket can never pass as a capture token
 * (or the other way round) even though both use the same secret.
 */
async function signTicket<T>(kind: string, schema: z.ZodType<T>, payload: T, secret: string) {
  const body = b64url(enc.encode(JSON.stringify(schema.parse(payload))));
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    enc.encode(`${kind}:${body}`),
  );
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

async function verifyTicket<T extends { exp: number }>(
  kind: string,
  schema: z.ZodType<T>,
  ticket: string,
  secret: string,
  now: number,
): Promise<T | null> {
  const [body, sig, extra] = ticket.split('.');
  if (!body || !sig || extra !== undefined) return null;
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromB64url(sig),
      enc.encode(`${kind}:${body}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return null;
  }
  const res = schema.safeParse(parsed);
  return res.success && res.data.exp > now ? res.data : null;
}

export function signJoinTicket(payload: JoinTicketPayload, secret: string): Promise<string> {
  return signTicket('join', JoinTicketPayload, payload, secret);
}

/** The payload if the signature is valid and the ticket hasn't expired, else null. */
export function verifyJoinTicket(
  ticket: string,
  secret: string,
  now = Date.now(),
): Promise<JoinTicketPayload | null> {
  return verifyTicket('join', JoinTicketPayload, ticket, secret, now);
}

/** Capture token for QR pairing with the iOS app: uploads for one room only. */
export function signCaptureToken(payload: CaptureTokenPayload, secret: string): Promise<string> {
  return signTicket('capture', CaptureTokenPayload, payload, secret);
}

export function verifyCaptureToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<CaptureTokenPayload | null> {
  return verifyTicket('capture', CaptureTokenPayload, token, secret, now);
}
