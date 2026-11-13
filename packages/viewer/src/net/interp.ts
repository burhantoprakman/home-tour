/**
 * Remote avatar smoothing: keep the last few server samples and draw each player
 * INTERP_DELAY_MS in the past, lerping between the two samples around that time. At 15 Hz
 * patches that delay spans ~1.5 patches, so one late patch doesn't make an avatar stall.
 */

export const INTERP_DELAY_MS = 100;
/** Past the newest sample, extrapolate at most this long, then hold. */
const MAX_EXTRAPOLATE_MS = 150;
/** Further than this between samples: a teleport (respawn, reconnection), so snap. */
const SNAP_M = 3;
const KEEP = 12;

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Sample extends Pose {
  t: number;
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class InterpBuffer {
  private samples: Sample[] = [];

  /** Adds a server pose received at `t` (ms). Unchanged poses are skipped. */
  push(t: number, pose: Pose): void {
    const last = this.samples[this.samples.length - 1];
    if (
      last &&
      last.x === pose.x &&
      last.y === pose.y &&
      last.z === pose.z &&
      last.yaw === pose.yaw
    ) {
      // Still standing: refresh the time so a later move lerps from now, not from long ago.
      last.t = t;
      return;
    }
    if (last && Math.hypot(pose.x - last.x, pose.y - last.y, pose.z - last.z) > SNAP_M)
      this.samples = [];
    this.samples.push({ t, ...pose });
    if (this.samples.length > KEEP) this.samples.shift();
  }

  get empty(): boolean {
    return this.samples.length === 0;
  }

  /** The pose to draw at `now` (ms), INTERP_DELAY_MS behind. */
  sample(now: number): Pose | null {
    const s = this.samples;
    const first = s[0];
    if (!first) return null;
    const t = now - INTERP_DELAY_MS;
    if (s.length === 1 || t <= first.t)
      return { x: first.x, y: first.y, z: first.z, yaw: first.yaw };
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (a && b && t >= a.t) {
        // Past the newest sample (i is the last): extrapolate a little along the last segment.
        const span = Math.max(1, b.t - a.t);
        const over = i === s.length - 1 ? Math.min(t - a.t, span + MAX_EXTRAPOLATE_MS) : t - a.t;
        const f = Math.min(over / span, i === s.length - 1 ? 1 + MAX_EXTRAPOLATE_MS / span : 1);
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          z: a.z + (b.z - a.z) * f,
          yaw: wrap(a.yaw + wrap(b.yaw - a.yaw) * Math.min(f, 1)),
        };
      }
    }
    return { x: first.x, y: first.y, z: first.z, yaw: first.yaw };
  }
}
