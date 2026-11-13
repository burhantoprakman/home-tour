/**
 * The viewer the web app embeds: `createViewer(canvas, { floorPlan, rooms, avatarId })`.
 *
 * Loads every placed room (streamed splat + collision.glb) where the floor plan puts it, merges
 * the collision meshes in world space, spawns the player's avatar at the plan's spawn point and
 * runs walk / third-person camera / sit. The room the avatar is in may use the finest splat LOD;
 * other rooms are capped one level coarser, all under the device's splat budget.
 *
 * Knows nothing about Supabase, auth or routes: it only gets URLs and data.
 */
import {
  AnimComponentSystem,
  AppBase,
  AppOptions,
  Asset,
  BLEND_NORMAL,
  CameraComponentSystem,
  Color,
  ContainerHandler,
  CULLFACE_NONE,
  DEVICETYPE_WEBGL2,
  DEVICETYPE_WEBGPU,
  Entity,
  FILLMODE_NONE,
  GSPLAT_BUDGET_TARGET,
  LAYERID_IMMEDIATE,
  GSplatComponentSystem,
  GSplatHandler,
  LightComponentSystem,
  Mesh,
  MeshInstance,
  PlaneGeometry,
  RenderComponentSystem,
  RESOLUTION_AUTO,
  StandardMaterial,
  TextureHandler,
  Vec2,
  Vec3,
  createGraphicsDevice,
  type GraphicsDevice,
} from 'playcanvas';
import {
  CHAT_BUBBLE_MS,
  type AnimState,
  type EmoteId,
  type FloorPlan,
  type Room,
  type Vec3 as Vec3Tuple,
  WORKER_OPTIONAL_FILES,
} from '@home-tour/shared';
import { InterpBuffer } from './net/interp.ts';
import {
  Avatar,
  avatarHeight,
  avatarScale,
  loadAvatarAsset,
  parseTint,
  radialTexture,
  type Clip,
} from './avatar.ts';
import { deviceTier, isMobileDevice, splatBudget, type DeviceInfo } from './budget.ts';
import { DEFAULT_CAMERA, ThirdPersonCamera } from './camera.ts';
import { ringDoorbell } from './bell.ts';
import { buildCollisionMesh, raycastDown, type CollisionMesh } from './collision.ts';
import { DoorMachine } from './doors.ts';
import { CapsuleController } from './controller.ts';
import { parseGlbTriangles, type TriangleSoup } from './glb.ts';
import { Input } from './input.ts';
import {
  currentRoom,
  mergeSoups,
  openFloorNear,
  soupBounds,
  soupToWorld,
  visibleRooms,
  worldSeats,
  type RoomBounds,
} from './rooms.ts';
import {
  SitMachine,
  nearestSeat,
  pickSeatOnScreen,
  seatsInRange,
  sitSpot,
  type SitState,
  type WorldSeat,
} from './seats.ts';

/** One walk speed, no run (plan decision). An unhurried indoor walk: ~2 steps/s with this clip. */
export const WALK_SPEED = 1.2;
/** Avatar slides onto the sit spot during the first part of the sit-down clip. */
const SIT_SLIDE_S = 0.45;
const TRANSFORM_HZ = 15;

export interface RemotePlayer {
  id: string;
  name?: string;
  avatarId: string;
  /** '#rrggbb' clothes tint. */
  tint?: string;
  /** Feet, world space. */
  position: Vec3Tuple;
  yaw: number;
  anim: AnimState;
  /** seatKey() of the seat this player holds, if any; it isn't offered to the local player. */
  seatId?: string | null;
}

/** Network id of a seat: worker seat ids are only unique within a room. */
export function seatKey(seat: { roomId: string; id: string }): string {
  return `${seat.roomId}:${seat.id}`;
}

/** An emote that doesn't come with a clip still shows (as idle) for this long. */
const EMOTE_FALLBACK_S = 2.5;
/** First-person eye height as a fraction of the avatar's height, standing and seated. */
const EYE_STANDING = 0.93;
const EYE_SEATED = 0.68;
/** Near clip: the third-person boom never gets this close; first person needs walls up close. */
const NEAR_THIRD = 0.2;
const NEAR_FIRST = 0.05;

export interface ViewerOptions {
  floorPlan: FloorPlan;
  /** The home's rooms; those placed in the floor plan with files are loaded. */
  rooms: Room[];
  avatarId: string;
  /** '#rrggbb' clothes tint of the local avatar. */
  avatarTint?: string;
  /** Where avatar GLBs live; default `/avatars/<id>.glb`. */
  avatarUrl?: (avatarId: string) => string;
  /** Dev page only. */
  dev?: {
    forceWebGL2?: boolean;
    splatBudget?: number;
    /** Also offer unconfirmed seats (imported rooms have none confirmed yet). */
    showUnconfirmedSeats?: boolean;
    /** C: collision mesh overlay, R: respawn. */
    keys?: boolean;
    /** Feet position overriding the floor plan spawn. */
    spawn?: Vec3Tuple;
  };
}

export interface ViewerStats {
  backend: 'webgpu' | 'webgl2';
  tier: string;
  mobile: boolean;
  fps: number;
  budget: number;
  drawn: number;
  /** Gaussians loaded across rooms, and whether every room is a streamed (budgeted) splat. */
  loaded: number;
  streamed: boolean;
  collisionTriangles: number;
  feet: Vec3Tuple;
  grounded: boolean;
  roomId: string | null;
  sit: SitState;
  /** Camera distance from its pivot (pulled in below 1.8 m) and pitch, for tuning. */
  cameraDistance: number;
  cameraPitch: number;
}

export interface ViewerEvents {
  ready: undefined;
  error: Error;
  /** About twice a second. */
  stats: ViewerStats;
  /** The local avatar's animation state changed. */
  anim: AnimState;
  /** Local avatar transform, at most 15 Hz while it changes. */
  transform: { position: Vec3Tuple; yaw: number };
  /** The local avatar sat on (seatKey) or left (null) a seat. */
  seat: { seatId: string | null };
}

export interface Viewer {
  on<K extends keyof ViewerEvents>(event: K, handler: (data: ViewerEvents[K]) => void): () => void;
  setRemotePlayers(players: RemotePlayer[]): void;
  /** Gets up (or stops walking to the seat): the server gave the seat to someone else. */
  releaseSeat(): void;
  /** Plays an emote on the local avatar until it ends or the player moves. */
  playEmote(id: EmoteId): void;
  /** A chat bubble over a player's head for CHAT_BUBBLE_MS; null = the local player. */
  say(playerId: string | null, text: string): void;
  dispose(): void;
}

export function createViewer(canvas: HTMLCanvasElement, options: ViewerOptions): Viewer {
  const handlers = new Map<keyof ViewerEvents, Set<(data: never) => void>>();
  const emit = <K extends keyof ViewerEvents>(event: K, data: ViewerEvents[K]) => {
    for (const h of handlers.get(event) ?? []) (h as (d: ViewerEvents[K]) => void)(data);
  };
  let disposed = false;
  let session: Session | null = null;
  let pendingPlayers: RemotePlayer[] | null = null;

  start(canvas, options, emit).then(
    (s) => {
      if (disposed) {
        s.dispose();
        return;
      }
      session = s;
      if (pendingPlayers) s.setRemotePlayers(pendingPlayers);
      emit('ready', undefined);
    },
    (err: unknown) => emit('error', err instanceof Error ? err : new Error(String(err))),
  );

  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(handler as (data: never) => void);
      return () => set.delete(handler as (data: never) => void);
    },
    setRemotePlayers(players) {
      if (session) session.setRemotePlayers(players);
      else pendingPlayers = players;
    },
    releaseSeat: () => session?.releaseSeat(),
    playEmote: (id) => session?.playEmote(id),
    say: (playerId, text) => session?.say(playerId, text),
    dispose() {
      disposed = true;
      session?.dispose();
      session = null;
      handlers.clear();
    },
  };
}

type Session = Omit<Viewer, 'on'>;

type Emit = <K extends keyof ViewerEvents>(event: K, data: ViewerEvents[K]) => void;

interface LoadedRoom {
  room: Room;
  entity: Entity;
  splat: Entity;
  asset: Asset;
  soup: TriangleSoup;
  /** camera.glb (splat occluder for the camera only), world space; null when the room has none. */
  cameraSoup: TriangleSoup | null;
  bounds: RoomBounds;
  lodMin: number;
}

async function start(
  canvas: HTMLCanvasElement,
  options: ViewerOptions,
  emit: Emit,
): Promise<Session> {
  const dev = options.dev ?? {};
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  const mobile = isMobileDevice({
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    uaDataMobile: nav.userAgentData?.mobile,
  });

  // --- Graphics device: WebGPU first, WebGL2 fallback. ------------------------------------
  const device: GraphicsDevice = await createGraphicsDevice(canvas, {
    deviceTypes: dev.forceWebGL2 ? [DEVICETYPE_WEBGL2] : [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
    antialias: false, // splats don't benefit from MSAA; saves bandwidth on phones
    powerPreference: 'high-performance',
  });
  device.maxPixelRatio = Math.min(window.devicePixelRatio, mobile ? 1.5 : 2);
  const info: DeviceInfo = { backend: device.isWebGPU ? 'webgpu' : 'webgl2', mobile };
  const budget = dev.splatBudget && dev.splatBudget > 0 ? dev.splatBudget : splatBudget(info);

  const appOptions = new AppOptions();
  appOptions.graphicsDevice = device;
  appOptions.componentSystems = [
    AnimComponentSystem,
    CameraComponentSystem,
    GSplatComponentSystem,
    LightComponentSystem,
    RenderComponentSystem,
  ];
  appOptions.resourceHandlers = [ContainerHandler, GSplatHandler, TextureHandler];
  const app = new AppBase(canvas);
  app.init(appOptions);
  app.setCanvasFillMode(FILLMODE_NONE);
  app.setCanvasResolution(RESOLUTION_AUTO);
  const resize = new ResizeObserver(() =>
    app.resizeCanvas(canvas.clientWidth, canvas.clientHeight),
  );
  resize.observe(canvas);
  app.resizeCanvas(canvas.clientWidth, canvas.clientHeight);

  // Global cap across all rooms. Only streamed (lod-meta.json) splats are reduced to fit it.
  app.scene.gsplat.splatBudget = budget;
  app.scene.gsplat.splatBudgetMode = GSPLAT_BUDGET_TARGET;
  app.scene.ambientLight = new Color(0.55, 0.55, 0.58);

  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: new Color(0.07, 0.07, 0.08),
    nearClip: NEAR_THIRD,
    farClip: 200,
    fov: 65,
  });
  app.root.addChild(camera);
  const sun = new Entity('sun');
  sun.addComponent('light', { type: 'directional', intensity: 0.9, castShadows: false });
  sun.setEulerAngles(50, 30, 0);
  app.root.addChild(sun);
  app.start();

  const destroyApp = () => {
    resize.disconnect();
    app.destroy();
  };

  // --- Rooms ------------------------------------------------------------------------------
  const { floorPlan } = options;
  const byId = new Map(options.rooms.map((r) => [r.id, r]));
  const placed = floorPlan.rooms.flatMap((p) => {
    const room = byId.get(p.roomId);
    return room?.splatUrl && room.collisionUrl
      ? [{ room, placement: p, splatUrl: room.splatUrl, collisionUrl: room.collisionUrl }]
      : [];
  });
  const avatarUrl = options.avatarUrl ?? ((id: string) => `/avatars/${id}.glb`);

  let loaded: LoadedRoom[];
  let avatarAsset: Asset;
  try {
    const roomLoads = placed.map(async ({ room, placement, splatUrl, collisionUrl }) => {
      const cameraUrl = new URL(WORKER_OPTIONAL_FILES.camera, new URL(collisionUrl, location.href)).href;
      const [asset, soup, cameraSoup] = await Promise.all([
        loadSplat(app, splatUrl),
        fetch(collisionUrl).then(async (r) => {
          if (!r.ok) throw new Error(`collision: HTTP ${r.status} for ${collisionUrl}`);
          return parseGlbTriangles(await r.arrayBuffer());
        }),
        // Optional: rooms built before camera.glb existed simply don't have one.
        fetch(cameraUrl)
          .then(async (r) => (r.ok ? parseGlbTriangles(await r.arrayBuffer()) : null))
          .catch(() => null),
      ]);
      const world = soupToWorld(soup, room.transform, placement, floorPlan.scale);
      // Floor plan placement -> Room.transform -> splat, matching soupToWorld.
      const entity = new Entity(`room ${room.name}`);
      entity.setLocalPosition(placement.x, 0, placement.z);
      entity.setLocalEulerAngles(0, (placement.rotationYaw * 180) / Math.PI, 0);
      entity.setLocalScale(floorPlan.scale, floorPlan.scale, floorPlan.scale);
      const local = new Entity('room-transform');
      const t = room.transform;
      local.setLocalPosition(t.position[0], t.position[1], t.position[2]);
      local.setLocalEulerAngles(0, (t.rotationYaw * 180) / Math.PI, 0);
      local.setLocalScale(t.scale, t.scale, t.scale);
      entity.addChild(local);
      const splat = new Entity('splat');
      splat.addComponent('gsplat', { asset });
      local.addChild(splat);
      app.root.addChild(entity);
      return {
        room,
        entity,
        splat,
        asset,
        soup: world,
        cameraSoup: cameraSoup && soupToWorld(cameraSoup, room.transform, placement, floorPlan.scale),
        bounds: soupBounds(room.id, world),
        lodMin: 0,
      };
    });
    const results = await Promise.allSettled(roomLoads);
    loaded = [];
    for (const r of results) {
      if (r.status === 'fulfilled') loaded.push(r.value);
      else emit('error', r.reason instanceof Error ? r.reason : new Error(String(r.reason)));
    }
    if (!loaded.length)
      throw new Error(placed.length ? 'No room could be loaded' : 'No placed room has files yet');
    avatarAsset = await loadAvatarAsset(app, avatarUrl(options.avatarId));
  } catch (err) {
    destroyApp();
    throw err;
  }

  const mesh: CollisionMesh = buildCollisionMesh(mergeSoups(loaded.map((r) => r.soup)));
  /** What the third-person camera keeps out of: collision.glb plus each room's camera.glb. */
  const cameraSoups = loaded.flatMap((r) => (r.cameraSoup ? [r.cameraSoup] : []));
  const cameraMesh: CollisionMesh = cameraSoups.length
    ? buildCollisionMesh(mergeSoups([...loaded.map((r) => r.soup), ...cameraSoups]), 0.25)
    : mesh;
  const bounds = loaded.map((r) => r.bounds);
  const seats: WorldSeat[] = loaded.flatMap(({ room }) => {
    const p = floorPlan.rooms.find((pl) => pl.roomId === room.id);
    return p ? worldSeats(room, p, floorPlan.scale) : [];
  });

  // Doors to rooms that were recorded separately; only doors whose target room loaded.
  const doors = (floorPlan.doors ?? []).filter((d) =>
    loaded.some((r) => r.room.id === d.to.roomId),
  );
  const doorMachine = new DoorMachine(doors);
  /** Rooms drawn right now (all of them unless the home has doors). */
  let shownRooms = new Set(loaded.map((r) => r.room.id));

  // --- Player -----------------------------------------------------------------------------
  const spawnPoint = (): Vec3Tuple => {
    if (dev.spawn) {
      const [x, y, z] = dev.spawn;
      const floor = raycastDown(mesh, x, y + 1, z, 3, 0.7);
      return floor ? [x, y + 1 - floor.distance, z] : [x, y + 0.5, z];
    }
    const { x, z } = floorPlan.spawn;
    const open = openFloorNear(mesh, x, z, floorPlan.spawn.yaw);
    if (open) return open;
    // Spawn not over a floor: centre of the nearest room, dropped by gravity.
    const b = bounds.find((r) => r.id === currentRoom(bounds, x, z)) ?? bounds[0];
    return b ? [(b.minX + b.maxX) / 2, 0.5, (b.minZ + b.maxZ) / 2] : [x, 0.5, z];
  };
  /** Below this the player fell out of the home (a hole in the collision mesh): respawn. */
  const killY = mesh.min.y - 3;
  let controller = new CapsuleController(mesh, spawnPoint());
  // The shoulder pivot is tuned for a 1.70 m body; shorter avatars get a lower camera.
  const cam = new ThirdPersonCamera((floorPlan.spawn.yaw * 180) / Math.PI, undefined, {
    height: (DEFAULT_CAMERA.height * avatarHeight(options.avatarId)) / 1.7,
  });
  const avatar = new Avatar(
    app,
    avatarAsset,
    parseTint(options.avatarTint),
    avatarScale(options.avatarId),
  );
  avatar.setYaw(floorPlan.spawn.yaw);
  const sit = new SitMachine(
    WALK_SPEED,
    avatar.duration('sitDown') || undefined,
    avatar.duration('standUp') || undefined,
    avatar.scale,
  );
  const shown = { x: controller.position.x, y: controller.position.y, z: controller.position.z };
  let slideFrom = { ...shown };

  // --- Seat rings -------------------------------------------------------------------------
  const ringTexture = radialTexture(app, (r) =>
    r > 0.62 && r < 0.95 ? 1 - Math.abs(r - 0.8) / 0.16 : 0,
  );
  const ringMaterial = (color: Color) => {
    const m = new StandardMaterial();
    m.useLighting = false;
    m.diffuse = new Color(0, 0, 0);
    m.emissive = color;
    m.opacityMap = ringTexture;
    m.opacityMapChannel = 'a';
    m.blendType = BLEND_NORMAL;
    m.depthWrite = false;
    m.cull = CULLFACE_NONE;
    m.update();
    return m;
  };
  const ringNormal = ringMaterial(new Color(0.45, 0.85, 1));
  const ringActive = ringMaterial(new Color(1, 0.85, 0.35));
  const ringMesh = Mesh.fromGeometry(
    device,
    new PlaneGeometry({ halfExtents: new Vec2(0.3, 0.3) }),
  );
  const rings = new Map<WorldSeat, Entity>();
  for (const seat of seats) {
    const e = new Entity(`seat ${seat.id}`);
    e.addComponent('render', {
      meshInstances: [new MeshInstance(ringMesh, ringNormal)],
      castShadows: false,
      // Drawn after the splats: they write no depth and would paint over the ring otherwise.
      layers: [LAYERID_IMMEDIATE],
    });
    e.setPosition(seat.x, seat.y + 0.03, seat.z);
    e.enabled = false;
    app.root.addChild(e);
    rings.set(seat, e);
  }
  let offered: WorldSeat[] = [];
  let target: WorldSeat | null = null;
  /** seatKeys other players hold (server-owned claims). */
  let occupied = new Set<string>();

  const requestSeat = (seat: WorldSeat | null) => {
    if (!seat || occupied.has(seatKey(seat))) return;
    sit.request(seat, controller.position);
  };

  // --- Input ------------------------------------------------------------------------------
  let collisionDebug: Entity | null = null;
  /** P: see through the avatar's eyes (own avatar hidden) instead of over its shoulder. */
  let firstPerson = false;
  const input = new Input(canvas, mobile, {
    interact() {
      if (sit.state === 'seated') sit.stand();
      else requestSeat(target);
    },
    tap(x, y) {
      const screen = new Vec3();
      const points = offered.flatMap((seat) => {
        camera.camera?.worldToScreen(new Vec3(seat.x, seat.y + 0.03, seat.z), screen);
        return screen.z > 0 ? [{ seat, x: screen.x, y: screen.y }] : [];
      });
      requestSeat(pickSeatOnScreen(points, x, y));
    },
    key(code) {
      if (code === 'KeyP') {
        firstPerson = !firstPerson;
        if (camera.camera) camera.camera.nearClip = firstPerson ? NEAR_FIRST : NEAR_THIRD;
        return;
      }
      if (!dev.keys) return;
      if (code === 'KeyC') {
        collisionDebug ??= buildCollisionDebug(app, device, mesh);
        collisionDebug.enabled = !collisionDebug.enabled;
      }
      if (code === 'KeyR') {
        sit.cancel();
        controller = new CapsuleController(mesh, spawnPoint());
      }
    },
  });

  // --- Remote players (fed by net/session.ts at the server's patch rate, drawn interpolated) --
  interface RemoteEntry {
    avatar: Avatar | null;
    data: RemotePlayer;
    key: string;
    buf: InterpBuffer;
  }
  const remotes = new Map<string, RemoteEntry>();
  const setRemotePlayers = (players: RemotePlayer[]) => {
    const seen = new Set<string>();
    const now = performance.now();
    occupied = new Set(players.flatMap((d) => (d.seatId ? [d.seatId] : [])));
    for (const data of players) {
      seen.add(data.id);
      const key = `${data.avatarId}|${data.tint ?? ''}`;
      const existing = remotes.get(data.id);
      const pose = { x: data.position[0], y: data.position[1], z: data.position[2], yaw: data.yaw };
      if (existing && existing.key === key) {
        existing.data = data;
        existing.buf.push(now, pose);
        continue;
      }
      existing?.avatar?.destroy();
      const entry: RemoteEntry = {
        avatar: null,
        data,
        key,
        buf: existing?.buf ?? new InterpBuffer(),
      };
      entry.buf.push(now, pose);
      remotes.set(data.id, entry);
      void loadAvatarAsset(app, avatarUrl(data.avatarId)).then(
        (asset) => {
          if (remotes.get(data.id) !== entry) return;
          entry.avatar = new Avatar(app, asset, parseTint(data.tint), avatarScale(data.avatarId));
          entry.avatar.setPosition(...data.position);
          entry.avatar.setYaw(data.yaw);
        },
        (err: unknown) => emit('error', err instanceof Error ? err : new Error(String(err))),
      );
    }
    for (const [id, r] of remotes) {
      if (seen.has(id)) continue;
      r.avatar?.destroy();
      remotes.delete(id);
      bubbles.get(id)?.el.remove();
      bubbles.delete(id);
    }
  };

  // --- Chat bubbles: DOM over the canvas, placed at each speaker's head every frame ---------
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  const host = canvas.parentElement;
  if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host?.appendChild(overlay);
  const doorFade = document.createElement('div');
  doorFade.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;';
  const doorLabel = document.createElement('div');
  doorLabel.style.cssText =
    'position:absolute;left:50%;top:18%;transform:translateX(-50%);padding:8px 14px;border-radius:999px;' +
    'background:rgba(0,0,0,.6);color:#fff;font:15px/1.3 system-ui,sans-serif;display:none;white-space:nowrap;';
  overlay.append(doorFade, doorLabel);
  const bubbles = new Map<string, { el: HTMLDivElement; until: number }>();
  const LOCAL = '\u0000local';
  const say = (playerId: string | null, text: string) => {
    const id = playerId ?? LOCAL;
    let b = bubbles.get(id);
    if (!b) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute;transform:translate(-50%,-100%);max-width:min(240px,60vw);padding:6px 10px;' +
        'border-radius:12px;background:rgba(255,255,255,.92);color:#111;font:14px/1.3 system-ui,sans-serif;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.25);overflow-wrap:anywhere;white-space:pre-wrap;';
      overlay.appendChild(el);
      bubbles.set(id, (b = { el, until: 0 }));
    }
    b.el.textContent = text;
    b.until = performance.now() + CHAT_BUBBLE_MS;
  };
  const headScreen = new Vec3();
  const placeBubbles = (now: number) => {
    for (const [id, b] of bubbles) {
      const r = id === LOCAL ? null : remotes.get(id);
      const who = id === LOCAL ? avatar : r?.avatar;
      const height =
        id === LOCAL ? avatarHeight(options.avatarId) : avatarHeight(r?.data.avatarId ?? '');
      if (now > b.until || !who) {
        b.el.remove();
        bubbles.delete(id);
        continue;
      }
      const p = who.entity.getPosition();
      camera.camera?.worldToScreen(new Vec3(p.x, p.y + height + 0.15, p.z), headScreen);
      // In first person your own bubble would sit on the camera; the chat panel shows it.
      const visible = headScreen.z > 0 && !(firstPerson && id === LOCAL);
      b.el.style.display = visible ? '' : 'none';
      if (visible) b.el.style.left = `${headScreen.x}px`;
      if (visible) b.el.style.top = `${headScreen.y}px`;
    }
  };

  // --- Emotes (local) ---------------------------------------------------------------------
  let emote: { id: EmoteId; until: number } | null = null;
  const playEmote = (id: EmoteId) => {
    if (sit.state !== 'none') return;
    const clip = `emote-${id}` as const;
    const len = avatar.has(clip) ? avatar.duration(clip) : EMOTE_FALLBACK_S;
    // Looping emotes (dance) run until the player moves; others for one play-through.
    emote = { id, until: performance.now() + (id === 'dance' ? Infinity : len * 1000) };
  };

  // --- Frame loop -------------------------------------------------------------------------
  let fps = 0;
  let lastFrame = performance.now();
  let statsTimer = 0;
  let roomTimer = 0;
  let roomId: string | null = null;
  let anim: AnimState = 'idle';
  let lastSeatId: string | null = null;
  let transformTimer = 0;
  let lastSent = '';
  let prevState: SitState = 'none';

  app.on('update', (dt: number) => {
    // Doors: ring, fade to black, move to the other room, fade back in.
    const door = doorMachine.update(
      dt,
      controller.position.x,
      controller.position.z,
      sit.state === 'none',
    );
    if (door.entered) {
      if (door.entered.bell) ringDoorbell();
      emote = null;
      const name = door.entered.label ?? 'Door';
      doorLabel.textContent = door.entered.bell ? `${name}: ringing the bell…` : `${name}…`;
      doorLabel.style.display = '';
    }
    if (door.teleport) {
      const to = door.teleport.to;
      sit.cancel();
      controller = new CapsuleController(
        mesh,
        openFloorNear(mesh, to.x, to.z, to.yaw) ?? [to.x, 0.5, to.z],
      );
      cam.yaw = (to.yaw * 180) / Math.PI;
      avatar.setYaw(to.yaw);
      roomTimer = 0;
      doorLabel.style.display = 'none';
    }
    doorFade.style.opacity = String(doorMachine.fade);
    if (controller.position.y < killY) {
      sit.cancel();
      controller = new CapsuleController(mesh, spawnPoint());
    }
    const look = input.takeLook();
    cam.look(look.yaw, look.pitch);
    const wantsMove = Math.hypot(input.move.x, input.move.y) > 0.1;
    const p = controller.position;
    const steer = sit.update(dt, { x: p.x, z: p.z, wantsMove });
    const state = sit.state;

    if (!sit.locked) {
      let vx: number, vz: number;
      if (doorMachine.locked) {
        vx = 0;
        vz = 0;
      } else if (steer) {
        vx = steer.vx;
        vz = steer.vz;
      } else {
        const b = cam.basis();
        vx = (b.fx * input.move.y + b.rx * input.move.x) * WALK_SPEED;
        vz = (b.fz * input.move.y + b.rz * input.move.x) * WALK_SPEED;
      }
      const x0 = p.x,
        z0 = p.z;
      controller.update(dt, vx, vz);
      const speed = dt > 0 ? Math.hypot(p.x - x0, p.z - z0) / dt : 0;
      shown.x = p.x;
      shown.y = p.y;
      shown.z = p.z;
      // First person: the body faces where you look (others see it), so strafing stays sideways.
      if (firstPerson && !steer) avatar.setYaw((cam.yaw * Math.PI) / 180);
      else if (Math.hypot(vx, vz) > 0.05) avatar.turnToward(Math.atan2(-vx, -vz), dt);
      if (emote && (speed > 0.15 || steer || performance.now() > emote.until)) emote = null;
      const emoteClip = emote ? (`emote-${emote.id}` as const) : null;
      if (emoteClip && avatar.has(emoteClip)) avatar.play(emoteClip, 0.2);
      else avatar.play(speed > 0.15 ? 'walk' : 'idle', 0.2, speed);
    } else {
      const seat = sit.seat;
      if (seat) {
        const spot = sitSpot(seat, avatar.scale);
        if (state === 'sittingDown' && prevState !== 'sittingDown') {
          slideFrom = { ...shown };
          if (sit.snapped) {
            // Blocked on the way: stand the capsule as near the seat as the room allows.
            controller.position.x = spot.x;
            controller.position.z = spot.z;
            controller.update(1 / 60, 0, 0);
          }
        }
        let clip: Clip = 'sit';
        let f = 1;
        let from = slideFrom;
        let to: { x: number; y: number; z: number } = spot;
        if (state === 'sittingDown') {
          clip = 'sitDown';
          f = Math.min(1, sit.time / SIT_SLIDE_S);
        } else if (state === 'standingUp') {
          clip = 'standUp';
          from = spot;
          to = controller.position;
          f = Math.min(1, sit.time / Math.max(0.1, sit.standUpSeconds));
        }
        const e = f * f * (3 - 2 * f);
        shown.x = from.x + (to.x - from.x) * e;
        shown.y = from.y + (to.y - from.y) * e;
        shown.z = from.z + (to.z - from.z) * e;
        if (state === 'sittingDown') avatar.turnToward(spot.yaw, dt * 1.2);
        avatar.play(clip, 0.25);
      }
    }
    if (state === 'none' && prevState === 'standingUp') {
      shown.x = controller.position.x;
      shown.y = controller.position.y;
      shown.z = controller.position.z;
    }
    prevState = state;
    avatar.setPosition(shown.x, shown.y, shown.z);

    // Seat rings: in-range seats glow, the nearest is the E target.
    offered = sit.locked
      ? []
      : seatsInRange(seats, controller.position, dev.showUnconfirmedSeats === true).filter(
          (s) => !occupied.has(seatKey(s)),
        );
    target = sit.state === 'approach' ? sit.seat : nearestSeat(offered, controller.position);
    const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 300);
    for (const [seat, e] of rings) {
      const on = offered.includes(seat) || seat === target;
      e.enabled = on && !sit.locked;
      if (!e.enabled) continue;
      const active = seat === target;
      const mi = e.render?.meshInstances[0];
      if (mi) mi.material = active ? ringActive : ringNormal;
      const s = active ? 1.1 + 0.08 * pulse : 0.9;
      e.setLocalScale(s, s, s);
    }
    ringActive.opacity = ringNormal.opacity = pulse;
    ringActive.update();
    ringNormal.update();

    // Camera.
    if (firstPerson) {
      const eye = avatarHeight(options.avatarId) * (sit.locked ? EYE_SEATED : EYE_STANDING);
      camera.setPosition(shown.x, shown.y + eye, shown.z);
      camera.setEulerAngles(cam.pitch, cam.yaw, 0);
      avatar.setOpacity(0);
    } else {
      // Seated: the camera moves round to the open side of the seat (see ThirdPersonCamera).
      const seatedSeat = sit.state === 'sittingDown' || sit.state === 'seated' ? sit.seat : null;
      cam.setSeated(seatedSeat ? sitSpot(seatedSeat, avatar.scale).yaw : null);
      const opacity = cam.update(dt, shown, cameraMesh);
      camera.setPosition(cam.position[0], cam.position[1], cam.position[2]);
      camera.setEulerAngles(cam.viewPitch, cam.yaw, 0);
      avatar.setOpacity(opacity);
    }

    // Remote avatars: interpolated ~100 ms behind the server.
    const nowMs = performance.now();
    for (const { avatar: a, data, buf } of remotes.values()) {
      const pose = a && buf.sample(nowMs);
      if (!a || !pose) continue;
      if (doors.length) {
        const there = currentRoom(bounds, pose.x, pose.z);
        a.entity.enabled = there === null || shownRooms.has(there);
      }
      const prev = a.entity.getPosition();
      const speed = dt > 0 ? Math.hypot(pose.x - prev.x, pose.z - prev.z) / dt : 0;
      a.setPosition(pose.x, pose.y, pose.z);
      a.setYaw(pose.yaw);
      const emoteClip = data.anim.startsWith('emote:')
        ? (`emote-${data.anim.slice(6)}` as Clip)
        : null;
      if (emoteClip && a.has(emoteClip)) a.play(emoteClip);
      else if (data.anim === 'sit') a.play('sit');
      else
        a.play(data.anim === 'walk' && speed > 0.05 ? 'walk' : 'idle', 0.2, Math.max(speed, 0.6));
    }
    placeBubbles(nowMs);

    // Current room gets the finest LOD; the others are capped one level coarser.
    roomTimer -= dt;
    if (roomTimer <= 0) {
      roomTimer = 0.5;
      roomId = currentRoom(bounds, controller.position.x, controller.position.z);
      if (doors.length) {
        shownRooms = visibleRooms(bounds, roomId);
        for (const r of loaded) r.entity.enabled = shownRooms.has(r.room.id);
      }
      for (const r of loaded) {
        const lodMin = r.room.id === roomId || loaded.length === 1 ? 0 : 1;
        if (lodMin === r.lodMin || !r.splat.gsplat) continue;
        r.lodMin = lodMin;
        r.splat.gsplat.lodRangeMin = lodMin;
      }
    }

    // Events.
    const nextAnim: AnimState = sit.locked
      ? 'sit'
      : emote
        ? `emote:${emote.id}`
        : avatar.clip === 'walk'
          ? 'walk'
          : 'idle';
    if (nextAnim !== anim) emit('anim', (anim = nextAnim));
    const seatId = sit.locked && sit.state !== 'standingUp' && sit.seat ? seatKey(sit.seat) : null;
    if (seatId !== lastSeatId) emit('seat', { seatId: (lastSeatId = seatId) });
    transformTimer -= dt;
    if (transformTimer <= 0) {
      const position: Vec3Tuple = [round(shown.x), round(shown.y), round(shown.z)];
      const yaw = round(avatar.yaw);
      const key = `${position.join()},${yaw}`;
      if (key !== lastSent) {
        lastSent = key;
        transformTimer = 1 / TRANSFORM_HZ;
        emit('transform', { position, yaw });
      }
    }

    // Real frame time: the engine clamps `dt` to 0.1 s, which would hide a slow device.
    const now = performance.now();
    const frame = (now - lastFrame) / 1000;
    lastFrame = now;
    if (frame > 0) fps = fps * 0.95 + (1 / frame) * 0.05;
    statsTimer -= dt;
    if (statsTimer <= 0) {
      statsTimer = 0.5;
      const res = loaded.map(
        (r) => r.asset.resource as { numSplats?: number; octree?: unknown } | undefined,
      );
      emit('stats', {
        backend: info.backend,
        tier: deviceTier(info),
        mobile,
        fps,
        budget,
        drawn: app.stats.frame.gsplats,
        loaded: res.reduce((n, r) => n + (r?.numSplats ?? 0), 0),
        streamed: res.every((r) => r?.octree !== undefined),
        collisionTriangles: mesh.triangleCount,
        feet: [controller.position.x, controller.position.y, controller.position.z],
        grounded: controller.grounded,
        roomId,
        sit: sit.state,
        cameraDistance: cam.distance,
        cameraPitch: cam.viewPitch,
      });
    }
  });

  return {
    setRemotePlayers,
    releaseSeat() {
      if (sit.state === 'approach') sit.cancel();
      else if (sit.state === 'sittingDown' || sit.state === 'seated') sit.forceStand();
    },
    playEmote,
    say,
    dispose() {
      input.dispose();
      for (const r of remotes.values()) r.avatar?.destroy();
      remotes.clear();
      overlay.remove();
      destroyApp();
    },
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function loadSplat(app: AppBase, url: string): Promise<Asset> {
  return new Promise<Asset>((resolve, reject) => {
    const asset = new Asset('splat', 'gsplat', { url });
    asset.once('load', () => resolve(asset));
    asset.once('error', (err: unknown) => reject(new Error(`splat ${url}: ${String(err)}`)));
    app.assets.add(asset);
    app.assets.load(asset);
  });
}

/** Translucent green overlay of the collision mesh (dev key C). */
function buildCollisionDebug(app: AppBase, device: GraphicsDevice, mesh: CollisionMesh): Entity {
  const m = new Mesh(device);
  m.setPositions(mesh.positions);
  m.update();
  const material = new StandardMaterial();
  material.useLighting = false;
  material.emissive = new Color(0.2, 1, 0.4);
  material.opacity = 0.25;
  material.blendType = BLEND_NORMAL;
  material.depthWrite = false;
  material.cull = CULLFACE_NONE;
  material.update();
  const entity = new Entity('collision-debug');
  entity.addComponent('render', { meshInstances: [new MeshInstance(m, material)] });
  entity.enabled = false;
  app.root.addChild(entity);
  return entity;
}
