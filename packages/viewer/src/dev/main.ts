/**
 * Viewer dev page: drives `createViewer` exactly as the web app does, from URL params.
 *
 * Query params:
 *   splat=<url>&collision=<url>   one room (.sog | lod-meta.json | .ply + collision.glb) at the origin
 *   seats=all | <url>             show unconfirmed seats too; one-room mode loads seats.json from
 *                                 <url>, or (seats=all) from next to the collision file
 *   home=<url>                    a JSON file { floorPlan, rooms } (see /homes/salon-two-rooms.json)
 *   avatar=<id>                   villager-m | villager-f | villager-m-beard | mannequin
 *   tint=rrggbb                   clothes colour
 *   gpu=webgl2                    force the WebGL2 fallback
 *   budget=<n>                    override the tier's splat budget (testing only)
 *   spawn=x,y,z                   feet position (default: the floor plan's spawn)
 *   look=yaw                      initial view yaw in degrees (one-room mode)
 *   mp[=<home uuid>]              multiplayer: join the realtime server (start apps/realtime);
 *                                 tabs with the same home share it. Tickets come from this dev
 *                                 server (vite.config.ts), signed with REALTIME_TICKET_SECRET
 *   name=<text>                   display name in mp mode (default: Guest <n>)
 *   realtime=<ws url>             realtime server (default ws://localhost:2567)
 */
/// <reference types="vite/client" />
import {
  FloorPlan,
  Room,
  WORKER_OUTPUT_FILES,
  WorkerSeats,
  AvatarId,
  type Seat,
  type Vec3,
} from '@home-tour/shared';
import {
  createViewer,
  visitHome,
  type Viewer,
  type ViewerOptions,
  type ViewerStats,
} from '../index.ts';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('app') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const warn = document.getElementById('warn') as HTMLDivElement;

// Avatars live in packages/viewer/public/avatars (outside this page's root); Vite resolves them.
const avatarFiles = import.meta.glob('../../public/avatars/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const avatarUrl = (id: string) =>
  avatarFiles[`../../public/avatars/${id}.glb`] ?? `/avatars/${id}.glb`;

interface Home {
  floorPlan: FloorPlan;
  rooms: Room[];
}

const DEV_HOME = '00000000-0000-4000-8000-000000000000';
const DEV_ROOM = '00000000-0000-4000-8000-000000000001';

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

/** One room at the origin from ?splat=&collision=(&seats=). */
async function singleRoom(splatUrl: string, collisionUrl: string): Promise<Home> {
  const seatsParam = params.get('seats');
  let seats: Seat[] = [];
  if (seatsParam) {
    const url =
      seatsParam === 'all'
        ? new URL(WORKER_OUTPUT_FILES.seats, new URL(collisionUrl, location.href)).href
        : seatsParam;
    try {
      seats = WorkerSeats.parse(await fetchJson(url));
    } catch (err) {
      warn.textContent = `seats: ${String(err)}`;
    }
  }
  const look = Number(params.get('look')?.split(',')[0] ?? 0);
  return {
    floorPlan: {
      rooms: [{ roomId: DEV_ROOM, x: 0, z: 0, rotationYaw: 0 }],
      spawn: { x: 0, z: 0, yaw: ((Number.isFinite(look) ? look : 0) * Math.PI) / 180 },
      scale: 1,
    },
    rooms: [
      {
        id: DEV_ROOM,
        homeId: DEV_HOME,
        name: 'Dev room',
        status: 'ready',
        splatUrl: new URL(splatUrl, location.href).href,
        collisionUrl: new URL(collisionUrl, location.href).href,
        seats,
        transform: { position: [0, 0, 0], rotationYaw: 0, scale: 1 },
      },
    ],
  };
}

async function main() {
  const homeUrl = params.get('home');
  const splatUrl = params.get('splat');
  const collisionUrl = params.get('collision');
  let home: Home;
  if (homeUrl) {
    const json = (await fetchJson(homeUrl)) as { floorPlan?: unknown; rooms?: unknown };
    home = { floorPlan: FloorPlan.parse(json.floorPlan), rooms: Room.array().parse(json.rooms) };
  } else if (splatUrl && collisionUrl) home = await singleRoom(splatUrl, collisionUrl);
  else {
    warn.textContent = `Pass ?splat=…/${WORKER_OUTPUT_FILES.splat}&collision=…/${WORKER_OUTPUT_FILES.collision}, ?home=<json>, or pick a link.`;
    return;
  }

  const spawn = params.get('spawn')?.split(',').map(Number);
  const budget = Number(params.get('budget'));
  const avatarId = AvatarId.catch('villager-m').parse(params.get('avatar'));
  const tint = `#${params.get('tint') ?? '4a7bd0'}`;
  const dev: ViewerOptions['dev'] = {
    forceWebGL2: params.get('gpu') === 'webgl2',
    ...(budget > 0 ? { splatBudget: budget } : {}),
    showUnconfirmedSeats: params.has('seats'),
    keys: true,
    ...(spawn?.length === 3 && spawn.every(Number.isFinite)
      ? { spawn: spawn as unknown as Vec3 }
      : {}),
  };
  let viewer: Viewer;
  let dispose: () => void;
  if (params.has('mp')) {
    const homeId = params.get('mp') || DEV_HOME;
    const name = params.get('name') ?? `Guest ${Math.floor(Math.random() * 90 + 10)}`;
    const q = new URLSearchParams({ home: homeId, name, avatar: avatarId, tint: tint.slice(1) });
    const res = await fetch(`/__dev/ticket?${q}`);
    const { ticket, error } = (await res.json()) as { ticket?: string; error?: string };
    if (!ticket) {
      warn.textContent = `No dev ticket: ${error ?? res.status}. Is REALTIME_TICKET_SECRET in .env?`;
      return;
    }
    const visit = visitHome(canvas, {
      homeId,
      floorPlan: home.floorPlan,
      rooms: home.rooms,
      ticket,
      realtimeUrl: params.get('realtime') ?? 'ws://localhost:2567',
      avatarId,
      tint,
      avatarUrl,
      dev,
    });
    viewer = visit.viewer;
    dispose = visit.dispose;
  } else {
    viewer = createViewer(canvas, {
      floorPlan: home.floorPlan,
      rooms: home.rooms,
      avatarId,
      avatarTint: tint,
      avatarUrl,
      dev,
    });
    dispose = () => viewer.dispose();
  }
  viewer.on('error', (err) => {
    warn.textContent = String(err);
    console.error(err);
  });
  viewer.on('stats', showStats);
  viewer.on('seat', ({ seatId }) => console.info(seatId ? `sat on ${seatId}` : 'stood up'));
  // Remote-player smoke test: ?ghost=1 puts a second avatar next to the spawn.
  if (params.has('ghost')) {
    const { x, z } = home.floorPlan.spawn;
    viewer.setRemotePlayers([
      {
        id: 'ghost',
        avatarId: 'villager-f',
        tint: '#c0504d',
        position: [x + 1, 0, z - 1],
        yaw: 0,
        anim: 'idle',
      },
    ]);
  }
  window.addEventListener('pagehide', dispose);
}

function showStats(s: ViewerStats) {
  if (!s.streamed && s.loaded > s.budget) {
    warn.textContent =
      `Over budget: ${fmt(s.loaded)} splats in a non-streamed bundle render in full; ` +
      `the ${fmt(s.budget)} cap only applies to streamed lod-meta.json splats.`;
  }
  const [x, y, z] = s.feet;
  hud.textContent = [
    `backend ${s.backend}  tier ${s.tier}${s.mobile ? ' (mobile)' : ''}  fps ${s.fps.toFixed(0)}`,
    `budget ${fmt(s.budget)}  drawn ${fmt(s.drawn)}  loaded ${fmt(s.loaded)}${s.streamed ? ' (streamed)' : ''}`,
    `collision ${fmt(s.collisionTriangles)} tris  room ${s.roomId?.slice(0, 8) ?? '-'}`,
    `camera ${s.cameraDistance.toFixed(2)} m back, pitch ${s.cameraPitch.toFixed(0)}`,
    `feet ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}  ${s.grounded ? 'grounded' : 'air'}  ${s.sit}`,
  ].join('\n');
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

main().catch((err: unknown) => {
  warn.textContent = String(err);
  console.error(err);
});
