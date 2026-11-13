/**
 * A preset avatar: one body GLB from public/avatars (mesh on the shared rig plus its clips),
 * a per-person clothes tint, a blob shadow and fading for when the camera is close.
 *
 * The GLBs face +Z (glTF convention); the model is turned 180 degrees so avatar yaw follows the
 * Seat / realtime convention (0 = facing -Z).
 */
import {
  ADDRESS_CLAMP_TO_EDGE,
  Asset,
  BLEND_NORMAL,
  Color,
  DITHER_BAYER8,
  DITHER_NONE,
  Entity,
  FILTER_LINEAR,
  LAYERID_IMMEDIATE,
  Mesh,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  PlaneGeometry,
  StandardMaterial,
  Texture,
  Vec2,
  type AnimTrack,
  type AppBase,
  type Material,
} from 'playcanvas';
import { AVATAR_IDS, type AvatarId, type EmoteId } from '@home-tour/shared';

/** Preset bodies built by scripts/build-avatars.ts. */
export { AVATAR_IDS, type AvatarId };

/** Standing height of each body as built (top of the head, metres). */
const BUILT_HEIGHT: Record<AvatarId, number> = {
  'villager-m': 1.84,
  'villager-f': 1.78,
  'villager-m-beard': 1.81,
  mannequin: 1.83,
};
/** Default shown heights: 1.40 m for men, 1.30 m for women (the mannequin counts as a man). */
export const AVATAR_HEIGHT: Record<AvatarId, number> = {
  'villager-m': 1.4,
  'villager-f': 1.3,
  'villager-m-beard': 1.4,
  mannequin: 1.4,
};

/** Shown height of `id`, metres (1.7 for unknown ids, which are not rescaled). */
export function avatarHeight(id: string): number {
  return id in AVATAR_HEIGHT ? AVATAR_HEIGHT[id as AvatarId] : 1.7;
}

/** Uniform scale that shows `id` at its default height (1 for unknown ids). */
export function avatarScale(id: string): number {
  return id in AVATAR_HEIGHT ? AVATAR_HEIGHT[id as AvatarId] / BUILT_HEIGHT[id as AvatarId] : 1;
}

/** Clip names inside every avatar GLB; emote clips are `emote-<EmoteId>` (optional). */
export type Clip = 'idle' | 'walk' | 'sitDown' | 'sit' | 'standUp' | `emote-${EmoteId}`;
const LOOPING: Record<Clip, boolean> = {
  idle: true,
  walk: true,
  sitDown: false,
  sit: true,
  standUp: false,
  'emote-wave': false,
  'emote-dance': true,
  'emote-clap': false,
  'emote-cheer': false,
  'emote-yes': false,
  'emote-no': false,
};

/**
 * The walk clip's ground speed at built size (m/s): how fast a planted foot slides back, measured
 * by forward kinematics on UAL1 `Walk_Loop` (1.33 s cycle). Playback is scaled to the real speed so
 * feet don't skate; the old guess of 1.3 played it too slowly and made the steps look huge.
 */
const WALK_CLIP_SPEED = 0.94;
/** Turn rate toward the walk direction, rad/s. */
const TURN_RATE = 10;

const containers = new Map<string, Promise<Asset>>();

/** Loads (once per URL) an avatar GLB container. */
export function loadAvatarAsset(app: AppBase, url: string): Promise<Asset> {
  let p = containers.get(url);
  if (!p) {
    p = new Promise<Asset>((resolve, reject) => {
      const asset = new Asset(url, 'container', { url });
      asset.once('load', () => resolve(asset));
      asset.once('error', (err: unknown) => reject(new Error(`avatar ${url}: ${String(err)}`)));
      app.assets.add(asset);
      app.assets.load(asset);
    });
    containers.set(url, p);
  }
  return p;
}

/** Parses '#rrggbb' into a colour (null if malformed). */
export function parseTint(hex: string | undefined): Color | null {
  const m = hex && /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export class Avatar {
  /** Feet position, yaw about +Y. */
  readonly entity: Entity;
  yaw = 0;
  clip: Clip | null = null;
  private readonly model: Entity;
  private readonly shadow: Entity;
  private readonly materials: StandardMaterial[] = [];
  private opacity = 1;
  private readonly durations = new Map<Clip, number>();
  /** Model scale (see avatarScale); strides shrink with it. */
  readonly scale: number;

  constructor(app: AppBase, container: Asset, tint: Color | null, scale = 1) {
    this.scale = scale;
    this.entity = new Entity('avatar');
    const resource = container.resource as {
      instantiateRenderEntity(): Entity;
      animations: Asset[];
    };
    this.model = resource.instantiateRenderEntity();
    this.model.setLocalEulerAngles(0, 180, 0);
    this.model.setLocalScale(scale, scale, scale);
    this.entity.addChild(this.model);

    // Per-avatar material copies: tint and fade must not leak to other avatars of the same body.
    const copies = new Map<Material, StandardMaterial>();
    for (const render of this.model.findComponents('render') as unknown as {
      meshInstances: MeshInstance[];
    }[]) {
      for (const mi of render.meshInstances) {
        if (!mi.material) continue;
        let copy = copies.get(mi.material);
        if (!copy) {
          copy = (mi.material as StandardMaterial).clone();
          if (tint && copy.name === 'Tint') copy.diffuse = tint;
          copy.update();
          copies.set(mi.material, copy);
          this.materials.push(copy);
        }
        mi.material = copy;
      }
    }

    this.model.addComponent('anim', { activate: true });
    const anim = this.model.anim;
    for (const a of resource.animations) {
      const track = a.resource as AnimTrack;
      const name = track.name as Clip;
      if (!(name in LOOPING)) continue;
      anim?.assignAnimation(name, track, undefined, 1, LOOPING[name]);
      this.durations.set(name, track.duration);
    }

    this.shadow = new Entity('blob-shadow');
    this.shadow.addComponent('render', {
      meshInstances: [new MeshInstance(blobMesh(app), blobMaterial(app))],
      castShadows: false,
      // After the splats, which would otherwise paint the floor over it.
      layers: [LAYERID_IMMEDIATE],
    });
    this.shadow.setLocalPosition(0, 0.015, 0);
    this.entity.addChild(this.shadow);
    app.root.addChild(this.entity);
    this.play('idle', 0);
  }

  /** Whether the GLB has this clip (emotes are optional). */
  has(clip: Clip): boolean {
    return this.durations.has(clip);
  }

  /** Clip length in seconds (0 if the GLB lacks it). */
  duration(clip: Clip): number {
    return this.durations.get(clip) ?? 0;
  }

  setPosition(x: number, y: number, z: number): void {
    this.entity.setPosition(x, y, z);
  }

  setYaw(yaw: number): void {
    this.yaw = yaw;
    this.entity.setEulerAngles(0, (yaw * 180) / Math.PI, 0);
  }

  /** Turns smoothly toward `target` (radians). */
  turnToward(target: number, dt: number): void {
    const d = wrapAngle(target - this.yaw);
    const step = TURN_RATE * dt;
    this.setYaw(wrapAngle(this.yaw + Math.max(-step, Math.min(step, d))));
  }

  /** Cross-fades to `clip`. Walk playback speed follows `speed` (m/s). */
  play(clip: Clip, blend = 0.2, speed = WALK_CLIP_SPEED): void {
    const anim = this.model.anim;
    if (!anim) return;
    anim.speed = clip === 'walk' ? Math.max(0.5, speed / (WALK_CLIP_SPEED * this.scale)) : 1;
    if (this.clip === clip) return;
    this.clip = clip;
    anim.baseLayer?.transition(clip, blend);
  }

  /** 1 = solid, 0 = hidden (camera inside the avatar). */
  setOpacity(opacity: number): void {
    const o = Math.round(opacity * 20) / 20;
    if (o === this.opacity) return;
    this.opacity = o;
    this.model.enabled = o > 0;
    // Dithered (screen-door) transparency: still opaque and depth-written, so the fade never
    // shows the inside of the body the way alpha blending of a double-sided mesh does.
    for (const m of this.materials) {
      m.opacity = o;
      m.opacityDither = o < 1 ? DITHER_BAYER8 : DITHER_NONE;
      m.update();
    }
  }

  setShadowVisible(visible: boolean): void {
    this.shadow.enabled = visible;
  }

  destroy(): void {
    this.entity.destroy();
    for (const m of this.materials) m.destroy();
  }
}

export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  a = ((a % twoPi) + twoPi) % twoPi;
  return a > Math.PI ? a - twoPi : a;
}

// --- Blob shadow: one soft dark disc, shared by every avatar ----------------------------------

let blob: { mesh: Mesh; material: StandardMaterial; app: AppBase } | null = null;

function blobShared(app: AppBase) {
  if (blob?.app === app) return blob;
  const mesh = Mesh.fromGeometry(
    app.graphicsDevice,
    new PlaneGeometry({ halfExtents: new Vec2(0.38, 0.38) }),
  );
  const material = new StandardMaterial();
  material.useLighting = false;
  material.diffuse = new Color(0, 0, 0);
  material.emissive = new Color(0, 0, 0);
  material.opacityMap = radialTexture(app, (r) => 0.55 * Math.max(0, 1 - r) ** 1.5);
  material.opacityMapChannel = 'a';
  material.blendType = BLEND_NORMAL;
  material.depthWrite = false;
  material.update();
  blob = { mesh, material, app };
  return blob;
}
const blobMesh = (app: AppBase) => blobShared(app).mesh;
const blobMaterial = (app: AppBase) => blobShared(app).material;

/** A 64x64 white texture whose alpha is `alpha(r)` for r = distance from the centre, 0..1. */
export function radialTexture(app: AppBase, alpha: (r: number) => number): Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
        const o = (y * size + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha(r))));
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  const texture = new Texture(app.graphicsDevice, {
    width: size,
    height: size,
    format: PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  texture.setSource(canvas);
  return texture;
}
