/**
 * Third-person camera over the right shoulder (GTA-style on foot). Pure math over the collision
 * mesh, no engine imports: the viewer copies `position` / `pitch` / `yaw` onto its camera entity.
 *
 * Each frame it probes the boom against the collision mesh: head -> shoulder pivot (so a wall on
 * the right doesn't put the pivot inside it), then a small fan of rays from the pivot toward the
 * camera spot. If the player's pitch is blocked (a ceiling fan, a lamp) it tries lower booms
 * before shortening; the camera stays `margin` in front of whatever was hit, pulls in quickly
 * and eases back out slowly.
 * It probes `mesh`, which the viewer builds from collision.glb plus the room's optional camera.glb
 * (an occluder mesh voxelised from the splat itself), so it also keeps out of drawn furniture that
 * the coarse walking mesh leaves out.
 *
 * Seated (`setSeated`): the camera swings round to the open side of the seat (in front of the
 * sitter, where the room and the recorded video are) and stays within `seatedArc` of it, at a
 * lower pivot and a shorter boom; behind a seat is usually the sofa back or a wall.
 */
import { raycast, type CollisionMesh, type Vec3Like } from './collision.ts';

export interface CameraOptions {
  /** Desired distance from the shoulder pivot, metres. */
  distance: number;
  /** Pivot height above the feet. */
  height: number;
  /** Pivot offset to the avatar's right. */
  shoulder: number;
  /** Pitch limits, degrees (negative looks down). */
  minPitch: number;
  maxPitch: number;
  /** Gap kept between the camera and a blocking surface. */
  margin: number;
  minDistance: number;
  /** Exponential rates (1/s) for pulling in and easing back out. */
  pullInRate: number;
  easeOutRate: number;
  /** Avatar opacity fades from 1 at fadeStart to 0 at fadeEnd camera distance. */
  fadeStart: number;
  fadeEnd: number;
  /**
   * Extra boom elevations tried (degrees added to pitch, i.e. a lower camera looking more level)
   * when the player's pitch is blocked: rooms often have a ceiling fan or lamp right above the
   * avatar, and dropping under it keeps a usable distance instead of pulling in to the head.
   */
  dropSteps: readonly number[];
  /** Rate (1/s) at which the automatic drop follows its target. */
  dropRate: number;
  /**
   * Radius of the camera "probe" at full distance: the boom is tested with a centre ray plus four
   * rays fanned this far around the camera spot, so the camera also keeps clear of things the
   * thin centre ray just misses (corners, and splat floaters whose collision blob is smaller than
   * what is drawn).
   */
  probeRadius: number;
  /** Seated: boom length, pivot height as a fraction of `height`, half-width (deg) of the arc in
   * front of the seat the camera may orbit in, and how fast (1/s) it swings round on sitting. */
  seatedDistance: number;
  seatedHeight: number;
  seatedArc: number;
  alignRate: number;
  /** Rate (1/s) the pivot height follows sitting down / standing up. */
  heightRate: number;
}

// Tuned for real rooms (3-5 m across): a GTA-like 2.5 m boom is pulled in almost everywhere
// indoors, so the default is shorter and the shoulder offset smaller.
export const DEFAULT_CAMERA: CameraOptions = {
  // Far enough back that the avatar fills about a third of the screen height, not half.
  distance: 2.6,
  height: 1.7,
  shoulder: 0.35,
  minPitch: -60,
  maxPitch: 35,
  margin: 0.15,
  minDistance: 0.15,
  pullInRate: 18,
  easeOutRate: 2,
  fadeStart: 0.55,
  fadeEnd: 0.25,
  dropSteps: [0, 8, 16, 24],
  dropRate: 4,
  probeRadius: 0.12,
  seatedDistance: 1.9,
  seatedHeight: 0.62,
  seatedArc: 75,
  alignRate: 3,
  heightRate: 4,
};

/** Seated camera candidates, degrees from straight in front of the seat, in order of preference. */
const SEATED_CANDIDATES = [0, -20, 20, -40, 40, -60, 60, -75, 75] as const;

/** Wraps degrees to (-180, 180]. */
export function wrapDegrees(d: number): number {
  const r = ((((d + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
}

/** Never closer than this to a surface, whatever the smoothing says (near clip is 0.05 m). */
const HARD_GAP = 0.08;

/** Camera distance allowed by a ray hit at `hit` metres (null = nothing in the way). */
export function pullInDistance(
  hit: number | null,
  desired: number,
  margin: number,
  minDistance: number,
): number {
  if (hit === null) return desired;
  return Math.max(minDistance, Math.min(desired, hit - margin));
}

/**
 * Moves `current` toward `goal` exponentially: at `inRate` when the goal is closer (pull in), at
 * `outRate` when it is farther (ease out).
 */
export function smoothDistance(
  current: number,
  goal: number,
  dt: number,
  inRate: number,
  outRate: number,
): number {
  const rate = goal < current ? inRate : outRate;
  return goal + (current - goal) * Math.exp(-rate * Math.max(0, dt));
}

/** Avatar opacity for a camera distance. */
export function fadeForDistance(distance: number, start: number, end: number): number {
  return Math.min(1, Math.max(0, (distance - end) / (start - end)));
}

/**
 * Free boom length: the nearest hit of the centre ray and four rays from the same pivot aimed
 * `probeRadius` around the desired camera spot (measured along the centre ray), or null. The
 * rays fan out from the pivot rather than running parallel so none starts inside geometry next
 * to the head.
 */
function probeBoom(
  mesh: CollisionMesh,
  px: number,
  py: number,
  pz: number,
  b: readonly [number, number, number],
  rx: number,
  rz: number,
  o: CameraOptions,
  distance: number,
): number | null {
  // Perpendicular basis: the view's horizontal right vector and up' = b x right.
  const ux = b[1] * rz,
    uy = b[2] * rx - b[0] * rz,
    uz = -b[1] * rx;
  const reach = distance + o.margin;
  const k = o.probeRadius / reach;
  let best: number | null = null;
  for (const [sx, sy] of [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    let dx = b[0] + (rx * sx + ux * sy) * k,
      dy = b[1] + uy * sy * k,
      dz = b[2] + (rz * sx + uz * sy) * k;
    const len = Math.hypot(dx, dy, dz);
    dx /= len;
    dy /= len;
    dz /= len;
    const hit = raycast(mesh, px, py, pz, dx, dy, dz, reach * len);
    if (!hit) continue;
    const along = hit.distance * (dx * b[0] + dy * b[1] + dz * b[2]);
    if (best === null || along < best) best = along;
  }
  return best;
}

export class ThirdPersonCamera {
  readonly options: CameraOptions;
  /** Degrees about +Y; 0 looks down -Z. */
  yaw: number;
  /** Degrees; negative looks down. */
  pitch: number;
  /** Current (smoothed) distance from the pivot. */
  distance: number;
  /** Pitch the camera entity should use: `pitch` plus the automatic drop under obstacles. */
  viewPitch: number;
  private drop = 0;
  /** Seated: yaw (deg) that looks at the sitter from straight in front; null when standing. */
  private seatedFront: number | null = null;
  /** Seconds left of the automatic swing round after sitting down. */
  private align = 0;
  private pivotHeight: number;
  readonly position: [number, number, number] = [0, 0, 0];

  constructor(yaw = 0, pitch = -15, options: Partial<CameraOptions> = {}) {
    this.options = { ...DEFAULT_CAMERA, ...options };
    this.yaw = yaw;
    this.pitch = this.clampPitch(pitch);
    this.distance = this.options.distance;
    this.viewPitch = this.pitch;
    this.pivotHeight = this.options.height;
  }

  /**
   * Sitting: `facingYaw` is the direction the sitter faces (radians, 0 = -Z, the seat convention);
   * null when standing. Safe to call every frame: only a new seat starts the swing round.
   */
  setSeated(facingYaw: number | null): void {
    if (facingYaw === null) {
      this.seatedFront = null;
      this.align = 0;
      return;
    }
    // Camera yaw 0 sits on +Z looking -Z, so looking back at the sitter's face is facing + 180.
    const front = wrapDegrees((facingYaw * 180) / Math.PI + 180);
    if (this.seatedFront === null || Math.abs(wrapDegrees(front - this.seatedFront)) > 1) {
      this.seatedFront = front;
      this.align = 2.5;
    }
  }

  get seated(): boolean {
    return this.seatedFront !== null;
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = this.clampPitch(this.pitch + dPitch);
  }

  /** Horizontal forward / right unit vectors of the view, for camera-relative movement. */
  basis(): { fx: number; fz: number; rx: number; rz: number } {
    const r = (this.yaw * Math.PI) / 180;
    return { fx: -Math.sin(r), fz: -Math.cos(r), rx: Math.cos(r), rz: -Math.sin(r) };
  }

  /** Places the camera behind `feet`; returns the avatar opacity to use. */
  update(dt: number, feet: Vec3Like, mesh: CollisionMesh | null): number {
    const o = this.options;
    const k = Math.max(0, dt);
    const front = this.seatedFront;
    const desired = front === null ? o.distance : o.seatedDistance;
    const hGoal = front === null ? o.height : o.height * o.seatedHeight;
    this.pivotHeight = hGoal + (this.pivotHeight - hGoal) * Math.exp(-o.heightRate * k);
    const hx = feet.x,
      hy = feet.y + this.pivotHeight,
      hz = feet.z;

    if (front !== null) {
      // Keep the camera on the open side of the seat; swing to the clearest spot after sitting
      // down, or when the boom gets squeezed (the player looked round into the sofa back).
      let rel = Math.max(-o.seatedArc, Math.min(o.seatedArc, wrapDegrees(this.yaw - front)));
      if (mesh && (this.align > 0 || this.distance < desired * 0.5)) {
        const best = this.bestSeatedYaw(mesh, hx, hy, hz, front, desired);
        if (this.align > 0 || best.free > this.distance + 0.3) {
          rel += wrapDegrees(best.rel - rel) * (1 - Math.exp(-o.alignRate * k));
        }
        this.align = Math.max(0, this.align - k);
      }
      this.yaw = front + rel;
    }
    const { rx, rz } = this.basis();

    let shoulder = front === null ? o.shoulder : 0;
    const side = mesh && raycast(mesh, hx, hy, hz, rx, 0, rz, o.shoulder + o.margin);
    if (side) shoulder = Math.max(0, Math.min(o.shoulder, side.distance - o.margin));
    const px = hx + rx * shoulder,
      py = hy,
      pz = hz + rz * shoulder;

    const yaw = (this.yaw * Math.PI) / 180;
    // Free distance along the boom for a given extra drop (degrees). Backward = -view direction.
    const boom = (drop: number) => {
      const p = (Math.min(o.maxPitch, this.pitch + drop) * Math.PI) / 180;
      const b = [Math.sin(yaw) * Math.cos(p), -Math.sin(p), Math.cos(yaw) * Math.cos(p)] as const;
      return { b, hit: mesh ? probeBoom(mesh, px, py, pz, b, rx, rz, o, desired) : null };
    };

    // The player's own pitch if it has most of the distance, else the least drop that does,
    // else whichever drop gets farthest.
    let target = 0;
    if (mesh) {
      let bestFree = -1;
      for (const d of o.dropSteps) {
        if (d > 0 && this.pitch + d > o.maxPitch) break;
        const r = boom(d);
        const free = pullInDistance(r.hit, desired, o.margin, o.minDistance);
        if (free >= desired * 0.85) {
          target = d;
          break;
        }
        if (free > bestFree + 0.05) {
          bestFree = free;
          target = d;
        }
      }
    }
    this.drop = target + (this.drop - target) * Math.exp(-o.dropRate * Math.max(0, dt));
    this.viewPitch = Math.min(o.maxPitch, this.pitch + this.drop);

    const { b, hit: hitDistance } = boom(this.drop);
    const goal = pullInDistance(hitDistance, desired, o.margin, o.minDistance);
    this.distance = smoothDistance(this.distance, goal, dt, o.pullInRate, o.easeOutRate);
    if (hitDistance !== null) {
      this.distance = Math.min(this.distance, Math.max(o.minDistance, hitDistance - HARD_GAP));
    }

    this.position[0] = px + b[0] * this.distance;
    this.position[1] = py + b[1] * this.distance;
    this.position[2] = pz + b[2] * this.distance;
    return fadeForDistance(this.distance, o.fadeStart, o.fadeEnd);
  }

  /** Seated candidate (degrees from the seat's front) with the most free boom, preferring the front. */
  private bestSeatedYaw(
    mesh: CollisionMesh,
    hx: number,
    hy: number,
    hz: number,
    front: number,
    desired: number,
  ): { rel: number; free: number } {
    const o = this.options;
    const p = (this.pitch * Math.PI) / 180;
    let best = { rel: 0, free: -1 };
    for (const rel of SEATED_CANDIDATES) {
      if (Math.abs(rel) > o.seatedArc) continue;
      const y = ((front + rel) * Math.PI) / 180;
      const b = [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)] as const;
      const hit = probeBoom(mesh, hx, hy, hz, b, Math.cos(y), -Math.sin(y), o, desired);
      const free = pullInDistance(hit, desired, o.margin, o.minDistance);
      if (free >= desired * 0.85) return { rel, free };
      if (free > best.free + 0.05) best = { rel, free };
    }
    return best;
  }

  private clampPitch(p: number): number {
    return Math.max(this.options.minPitch, Math.min(this.options.maxPitch, p));
  }
}
