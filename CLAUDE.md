# Home Tour

Browser-first app: a homeowner uploads one phone video per room, the backend turns each room into a Gaussian splat with a hidden collision mesh, and up to 8 friends and family hang out in the home as preset avatars (walk, sit, text chat, emotes).

Full product plan: Home Tour – Browser-First MVP Plan (Claude Docs). This file is the build guide.

## Principles

- **Ship the MVP, not a platform.** Build only what the current step needs. No plugin systems, no abstractions for features we don't have yet.
- **One owner per folder.** Each agent works only inside its folders. Cross-folder changes go through `packages/shared` types.
- **Boring tech, few dependencies.** Ask before adding a dependency that isn't listed below.
- **Rendering stays in the browser.** GPUs only build homes; they never serve guests.
- **v1 has no privacy tools** (no blur, no hidden rooms). Don't build them.

## Stack

| Layer | Choice |
| --- | --- |
| Monorepo | pnpm workspaces, TypeScript strict |
| Web app + API | Next.js (App Router), route handlers for the API |
| Auth, DB, storage | Supabase (Postgres, Auth, Storage); splats served via CDN |
| 3D viewer | PlayCanvas Engine, WebGPU with WebGL2 fallback |
| Realtime | Colyseus (Node) |
| GPU pipeline | Python 3.12: ffmpeg, COLMAP/GLOMAP, gsplat (MCMC), splat-transform (Node CLI) |
| GPU hosting | Modal (serverless, scale to zero) |
| Tests | Vitest (TS), pytest (Python), Playwright (smoke) |

## Repo layout

```
apps/
  web/          Next.js owner app, guest join page, API routes      -> web-app-engineer
  realtime/     Colyseus server                                     -> realtime-engineer
packages/
  viewer/       PlayCanvas client: splats, collision, avatars, input -> viewer-engineer
  shared/       Types + message schemas used by everything else     -> any agent, small PRs
worker/         Python GPU pipeline (Modal app)                     -> pipeline-engineer
supabase/
  migrations/   SQL schema                                          -> web-app-engineer
```

## Agents

| Agent | Owns | Use for |
| --- | --- | --- |
| `pipeline-engineer` | `worker/` | Video → splat → collision → seats → streamed SOG |
| `viewer-engineer` | `packages/viewer/` | Rendering, splat budget, character controller, sitting, avatars |
| `web-app-engineer` | `apps/web/`, `supabase/` | Auth, homes/rooms, uploads, status, floor plan editor, invites |
| `realtime-engineer` | `apps/realtime/` + viewer's net adapter | Sessions, transforms, seats, chat, emotes |
| `reviewer` | read-only | Review each step against this file before it's marked done |

Run independent steps in parallel (e.g. pipeline + viewer in Step 1). Always finish a step with `reviewer`.

## Core contracts (packages/shared)

Keep these small and stable; change them first, then update both sides.

- `Room` — `id, homeId, name, status ('queued'|'solving'|'training'|'preview'|'ready'|'failed'), splatUrl, collisionUrl, seats: Seat[], transform`
- `Seat` — `id, position [x,y,z], facingYaw, confirmed: boolean`
- `FloorPlan` — `rooms: { roomId, x, z, rotationYaw }[], spawn: { x, z, yaw }, scale`
- Realtime messages — `transform`, `anim` (`idle|walk|sit|emote:<id>`), `seatClaim`, `seatRelease`, `chat`
- Worker output per room — `room.sog` (streamed SOG bundle), `collision.glb`, `seats.json`, `meta.json` (gaussianCount, floorY, scale)

## Budgets (don't exceed without asking)

- Splats drawn: 1M mobile, 3M desktop, 500k on WebGL2 fallback
- Gaussians per room: ~3M (MCMC cap)
- Avatar: ~10k triangles, one shared rig, 6–8 presets
- Realtime: transforms at 10–15 Hz, max 8 players per home
- Processing: preview < 15 min, final < 60 min per room

## Build steps

Each step ends with its "done when" check passing and a `reviewer` pass.

### Step 0 — Scaffold (web-app-engineer)
1. Create the pnpm monorepo with the layout above, shared `tsconfig`, ESLint, Prettier.
2. Add `packages/shared` with the contracts above.
3. Add `.env.example` (Supabase URL/keys, Modal token, CDN base URL, realtime URL).

Done when: `pnpm install && pnpm build && pnpm test` pass on an empty project.

### Step 1 — Spike: walk a real room (pipeline-engineer + viewer-engineer, parallel)
1. pipeline: a local CLI `worker/run_local.py <video>` that outputs `room.sog`, `collision.glb`, `meta.json` for one room.
2. viewer: a dev page in `packages/viewer` that loads a SOG + collision file and lets a capsule walk with WASD, with the splat budget applied.

Done when: a real room video becomes a walkable scene on desktop Chrome and a mid-range Android phone.
**Gate:** if it doesn't feel convincing on a phone, fix capture quality before Step 2.

### Step 2 — Automated pipeline (pipeline-engineer, then web-app-engineer)
1. pipeline: wrap stages in a Modal function; write outputs to storage; report stage + progress to the `jobs` table; emit preview (7k iters) then final (30k).
2. pipeline: add blur filtering, floor leveling, scale estimate, seat detection (`seats.json`).
3. web-app: `POST /homes/:id/rooms` returns a resumable upload URL; upload completion enqueues the Modal job.

Done when: uploading a video via the API produces a ready room on the CDN with no manual steps.

### Step 3 — Owner app (web-app-engineer)
1. Supabase schema: `users, homes, rooms, jobs, invites` + row-level security (owner-only writes).
2. Sign-in (magic link + Google), create home, add room with recording tips, resumable upload.
3. Status screen via server-sent events from `jobs`.
4. Floor plan editor: top-down drag/rotate rooms, confirm seats, set spawn, scale slider. Saves `FloorPlan`.

Done when: an owner can go from sign-up to a saved floor plan with two rooms.

### Step 4 — Avatars and movement (viewer-engineer)
1. Load multiple rooms by floor plan; prioritize the current room in the budget.
2. Preset characters (CC0 or licensed pack), shared animations: idle, walk, sit, 6 emotes; blob shadow.
3. Third-person camera with wall pull-in; mobile joystick + drag-to-look.
4. Sitting: highlight confirmed seats, tap/E to sit.

Done when: one person can walk a two-room home and sit on a couch on desktop and mobile.

### Step 5 — Multiplayer (realtime-engineer, with web-app-engineer for invites)
1. Colyseus room per home: join/leave, 8-player cap, transform relay, anim state, server-owned seat claims, rate-limited chat.
2. Viewer net adapter: interpolate remote avatars, chat bubbles (5 s) + chat panel, emote wheel.
3. web-app: invite links (`POST /homes/:id/invites`, `GET /join/:token`), guest name + character picker.

Done when: 8 browser tabs (mixed desktop/mobile emulation) share one home smoothly.

### Step 6 — Polish and friends beta (all, reviewer leads)
1. Process 5 real homes; fix the worst capture and collision failures.
2. Tune splat budgets per device tier; check WebGL2 fallback.
3. Playwright smoke test: sign up → upload → join via invite → chat.
4. Invite the first families.

Done when: 5 homes are hosting real visits without blocking bugs.

## Commands

```
pnpm dev              # web + realtime + viewer dev page
pnpm test             # all TS tests
pnpm lint
cd worker && pytest   # pipeline tests
modal deploy worker/app.py
```

## Conventions

- Small PRs, one step or sub-step each, with a one-paragraph summary.
- No secrets in code; use `.env` and Modal/Supabase secrets.
- Every API route validates input with zod schemas from `packages/shared`.
- Log pipeline stage timings and GPU seconds to `jobs` — we track cost per home.
- When unsure about scope, check the Out of scope list in the plan and leave it out.
