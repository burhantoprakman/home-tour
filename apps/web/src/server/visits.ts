import {
  CreateInviteResponse,
  FloorPlan,
  IdParam,
  InviteTokenParam,
  Room,
  VisitRequest,
  signJoinTicket,
  type InvitePreview,
  type JoinTicketPayload,
  type VisitResponse,
} from '@home-tour/shared';
import { z } from 'zod';
import { dbErrorResponse } from './errors';
import { apiError, bearerToken, json, readJson } from './http';
import type { RouteDeps } from './rooms';

/** Join tickets only have to survive until the visit page opens its socket. */
export const TICKET_TTL_MS = 10 * 60_000;

const VisitHomeRow = z.object({
  id: z.uuid(),
  name: z.string(),
  floorPlan: FloorPlan.nullable(),
  rooms: z.array(Room),
});

const InviteRow = z.object({ token: z.string(), expires_at: z.string().nullable() });

function badRow(what: string, issue: unknown): Response {
  console.error(`[api] unexpected ${what} row`, issue);
  return apiError(500, 'Something went wrong');
}

/** POST /api/homes/:id/invites — owner creates a share link. */
export async function createInvite(
  req: Request,
  params: unknown,
  deps: RouteDeps,
): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const id = IdParam.safeParse(params);
  if (!id.success) return apiError(400, 'Invalid home id');
  const { data, error } = await deps
    .db(token)
    .rpc<unknown>('create_invite', { p_home_id: id.data.id });
  if (error) return dbErrorResponse(error);
  const row = z.tuple([InviteRow]).safeParse(data);
  if (!row.success) return badRow('invite', row.error.issues);
  const [inv] = row.data;
  const body = CreateInviteResponse.safeParse({
    token: inv.token,
    expiresAt: inv.expires_at === null ? null : new Date(inv.expires_at).toISOString(),
  });
  if (!body.success) return badRow('invite', body.error.issues);
  return json<CreateInviteResponse>(body.data, 201);
}

async function resolveInvite(params: unknown, deps: RouteDeps) {
  const p = InviteTokenParam.safeParse(params);
  if (!p.success) return apiError(404, 'This invite link is not valid');
  const { data, error } = await deps
    .db(null)
    .rpc<unknown>('resolve_invite', { p_token: p.data.token });
  if (error) {
    return error.code === 'P0002'
      ? apiError(404, 'This invite link has expired or was revoked')
      : dbErrorResponse(error);
  }
  const row = VisitHomeRow.safeParse(data);
  return row.success ? row.data : badRow('invite home', row.error.issues);
}

/** GET /api/join/:token — the home's name for the join page. No sign-in. */
export async function previewInvite(params: unknown, deps: RouteDeps): Promise<Response> {
  const home = await resolveInvite(params, deps);
  if (home instanceof Response) return home;
  return json<InvitePreview>({ homeId: home.id, homeName: home.name });
}

async function visit(
  req: Request,
  home: z.infer<typeof VisitHomeRow>,
  role: JoinTicketPayload['role'],
  deps: RouteDeps,
): Promise<Response> {
  const body = VisitRequest.safeParse(await readJson(req));
  if (!body.success) return apiError(400, 'Pick a name (up to 24 characters) and a character');
  if (!deps.env.ticketSecret) {
    console.error('[api] REALTIME_TICKET_SECRET is not set (32+ chars)');
    return apiError(500, 'Visits are not set up on this server');
  }
  if (!home.floorPlan || home.floorPlan.rooms.length === 0) {
    return apiError(409, "This home isn't ready to visit yet: the owner hasn't placed any rooms");
  }
  const ticket = await signJoinTicket(
    { homeId: home.id, ...body.data, role, exp: Date.now() + TICKET_TTL_MS },
    deps.env.ticketSecret,
  );
  return json<VisitResponse>({
    homeId: home.id,
    homeName: home.name,
    rooms: home.rooms,
    floorPlan: home.floorPlan,
    ticket,
    realtimeUrl: deps.env.realtimeUrl,
  });
}

/** POST /api/join/:token — a guest's name + character -> the home and a join ticket. */
export async function joinWithInvite(
  req: Request,
  params: unknown,
  deps: RouteDeps,
): Promise<Response> {
  const home = await resolveInvite(params, deps);
  if (home instanceof Response) return home;
  return visit(req, home, 'guest', deps);
}

/** POST /api/homes/:id/visit — the owner visits their own home. */
export async function ownerVisit(
  req: Request,
  params: unknown,
  deps: RouteDeps,
): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return apiError(401, 'Sign in first');
  const id = IdParam.safeParse(params);
  if (!id.success) return apiError(400, 'Invalid home id');
  const { data, error } = await deps.db(token).rpc<unknown>('get_home', { p_home_id: id.data.id });
  if (error) return dbErrorResponse(error);
  const row = VisitHomeRow.safeParse(data);
  if (!row.success) return badRow('home', row.error.issues);
  // Owners see every room; only published ones can be loaded.
  const rooms = row.data.rooms.filter((r) => r.splatUrl && r.collisionUrl);
  return visit(req, { ...row.data, rooms }, 'owner', deps);
}
