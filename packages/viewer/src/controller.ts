/**
 * Kinematic capsule character controller over a CollisionMesh. No physics engine.
 *
 * The capsule "floats": its lower sphere starts stepHeight + skin above the feet, so obstacles
 * lower than that never touch the body. A few downward rays under the capsule find the ground and
 * snap the feet to it (up by at most stepHeight, down by at most snapDown); anything taller blocks
 * the body and the capsule slides along it. Body pushes are horizontal only, except against
 * ceilings, so walls can't lift or sink the player.
 */
import type { Vec3 } from '@home-tour/shared';
import {
  closestSegmentTriangle,
  queryBox,
  raycastDown,
  type CollisionMesh,
  type Vec3Mut,
} from './collision.ts';

export interface CapsuleOptions {
  /** Total height, metres. */
  height: number;
  radius: number;
  /** Highest ledge the capsule walks up without jumping. */
  stepHeight: number;
  /** How far the feet follow the ground down (stairs, ramps) before the capsule falls. */
  snapDown: number;
  gravity: number;
  /** Steepest walkable slope, degrees. */
  maxSlopeDeg: number;
  /** Camera height above the feet. */
  eyeHeight: number;
}

export const DEFAULT_CAPSULE: CapsuleOptions = {
  height: 1.7,
  radius: 0.3,
  stepHeight: 0.2,
  snapDown: 0.3,
  gravity: 9.81,
  maxSlopeDeg: 50,
  eyeHeight: 1.6,
};

const SKIN = 0.05;
const MAX_DT = 0.1;
const MAX_FALL_SPEED = 30;
const RESOLVE_ITERATIONS = 4;

export class CapsuleController {
  readonly options: CapsuleOptions;
  /** Feet position (bottom of the capsule), world space. */
  readonly position: Vec3Mut;
  velocityY = 0;
  grounded = false;
  private readonly mesh: CollisionMesh;
  private readonly minUpness: number;
  private readonly segA: Vec3Mut = { x: 0, y: 0, z: 0 };
  private readonly segB: Vec3Mut = { x: 0, y: 0, z: 0 };
  private readonly onSeg: Vec3Mut = { x: 0, y: 0, z: 0 };
  private readonly onTri: Vec3Mut = { x: 0, y: 0, z: 0 };

  constructor(mesh: CollisionMesh, spawn: Vec3, options: Partial<CapsuleOptions> = {}) {
    this.mesh = mesh;
    this.options = { ...DEFAULT_CAPSULE, ...options };
    this.position = { x: spawn[0], y: spawn[1], z: spawn[2] };
    this.minUpness = Math.cos((this.options.maxSlopeDeg * Math.PI) / 180);
  }

  /** Eye position for a first-person camera. */
  eye(): Vec3 {
    const p = this.position;
    return [p.x, p.y + this.options.eyeHeight, p.z];
  }

  /**
   * Advances the controller.
   * @param dt seconds since the last update (clamped to 0.1 s)
   * @param moveX desired horizontal velocity along world X, m/s
   * @param moveZ desired horizontal velocity along world Z, m/s
   */
  update(dt: number, moveX: number, moveZ: number): void {
    dt = Math.min(Math.max(dt, 0), MAX_DT);
    if (dt === 0) return;
    const { radius } = this.options;
    // Sub-step so no step moves more than half a radius: keeps thin walls from tunnelling.
    const fall = this.grounded ? 0 : Math.abs(this.velocityY) + this.options.gravity * dt;
    const travel = Math.max(Math.hypot(moveX, moveZ), fall) * dt;
    const steps = Math.min(32, Math.max(1, Math.ceil(travel / (radius * 0.5))));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h, moveX, moveZ);
  }

  private step(dt: number, moveX: number, moveZ: number) {
    const p = this.position;
    const o = this.options;
    p.x += moveX * dt;
    p.z += moveZ * dt;
    if (!this.grounded) {
      this.velocityY = Math.max(this.velocityY - o.gravity * dt, -MAX_FALL_SPEED);
      p.y += this.velocityY * dt;
    }
    this.resolveBody();
    this.snapToGround();
  }

  /** Pushes the capsule body out of nearby triangles. */
  private resolveBody() {
    const p = this.position;
    const { radius: r, height, stepHeight } = this.options;
    const mesh = this.mesh;
    for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
      let moved = false;
      const bottom = p.y + stepHeight + SKIN + r;
      const top = Math.max(bottom, p.y + height - r);
      queryBox(mesh, p.x - r, bottom - r, p.z - r, p.x + r, top + r, p.z + r, (t) => {
        // Re-read the segment: earlier triangles in this pass may have moved the capsule.
        const b = p.y + stepHeight + SKIN + r;
        const tp = Math.max(b, p.y + height - r);
        this.segA.x = this.segB.x = p.x;
        this.segA.z = this.segB.z = p.z;
        this.segA.y = b;
        this.segB.y = tp;
        const d2 = closestSegmentTriangle(mesh, t, this.segA, this.segB, this.onSeg, this.onTri);
        if (d2 >= r * r) return;
        const d = Math.sqrt(d2);
        let nx: number, ny: number, nz: number;
        if (d > 1e-6) {
          nx = (this.onSeg.x - this.onTri.x) / d;
          ny = (this.onSeg.y - this.onTri.y) / d;
          nz = (this.onSeg.z - this.onTri.z) / d;
        } else {
          // Segment touches the triangle: push along its normal, away from the old side.
          nx = mesh.normals[t * 3] ?? 0;
          ny = mesh.normals[t * 3 + 1] ?? 0;
          nz = mesh.normals[t * 3 + 2] ?? 0;
        }
        const depth = r - d;
        if (ny < -0.7) {
          // Ceiling over the head.
          p.y += ny * depth;
          this.velocityY = Math.min(this.velocityY, 0);
          moved = true;
          return;
        }
        const hl = Math.hypot(nx, nz);
        if (hl < 1e-3) return; // floor-like contact under the body; ground snap owns that
        const push = Math.min(depth / hl, r);
        p.x += (nx / hl) * push;
        p.z += (nz / hl) * push;
        moved = true;
      });
      if (!moved) break;
    }
  }

  /** Finds the highest walkable ground under the capsule and snaps the feet to it. */
  private snapToGround() {
    const p = this.position;
    const { radius, stepHeight, snapDown } = this.options;
    const startY = p.y + stepHeight + SKIN;
    const reach = stepHeight + SKIN + (this.grounded ? snapDown : 0);
    const off = radius * 0.5;
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const x = p.x + (i === 1 ? off : i === 2 ? -off : 0);
      const z = p.z + (i === 3 ? off : i === 4 ? -off : 0);
      const hit = raycastDown(this.mesh, x, startY, z, reach, this.minUpness);
      if (hit && hit.distance < best) best = hit.distance;
    }
    if (best === Infinity) {
      this.grounded = false;
      return;
    }
    const groundY = startY - best;
    if (this.grounded || p.y <= groundY + 1e-4 || this.velocityY <= 0) {
      p.y = groundY;
      this.grounded = true;
      this.velocityY = 0;
    }
  }
}
