/**
 * Doors between rooms that were recorded separately (FloorPlan.doors). Walking into a door's
 * circle rings the bell (if it has one), fades to black, moves the player to the door's target
 * and fades back in. Pure state machine, no engine or audio imports: viewer.ts drives it once
 * per frame and does the ringing, fading and moving.
 */
import type { Door } from '@home-tour/shared';

export type DoorPhase = 'idle' | 'ringing' | 'fadeOut' | 'fadeIn';

export interface DoorTiming {
  /** Seconds between the bell and the fade, so the ding-dong is heard first. */
  ring: number;
  /** Seconds for a door without a bell. */
  knockless: number;
  /** Seconds for each of fade out / fade in. */
  fade: number;
}

export const DOOR_TIMING: DoorTiming = { ring: 1.6, knockless: 0.2, fade: 0.45 };

export interface DoorStep {
  /** The player just walked into this door: ring it (if `bell`) and show its label. */
  entered?: Door;
  /** Black now: move the player to `door.to`. */
  teleport?: Door;
}

/** The door whose circle contains (x, z); the nearest centre wins when circles overlap. */
export function doorAt(doors: readonly Door[], x: number, z: number): Door | null {
  let best: Door | null = null;
  let bestD = Infinity;
  for (const d of doors) {
    const dist = Math.hypot(x - d.x, z - d.z);
    if (dist <= d.radius && dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}

export class DoorMachine {
  phase: DoorPhase = 'idle';
  door: Door | null = null;
  time = 0;
  /**
   * A door fires only after the player has been outside every door circle. Starts false so a
   * spawn (or an arrival) inside a circle doesn't send the player straight back.
   */
  private armed = false;

  private readonly doors: readonly Door[];
  private readonly timing: DoorTiming;

  constructor(doors: readonly Door[], timing: DoorTiming = DOOR_TIMING) {
    this.doors = doors;
    this.timing = timing;
  }

  /** True while a door is in use: no walking. */
  get locked(): boolean {
    return this.phase !== 'idle';
  }

  /** Opacity (0..1) of the black screen. */
  get fade(): number {
    const f = Math.min(1, this.time / this.timing.fade);
    if (this.phase === 'fadeOut') return f;
    if (this.phase === 'fadeIn') return 1 - f;
    return 0;
  }

  /** `canUse` is false while sitting or walking to a seat. */
  update(dt: number, x: number, z: number, canUse = true): DoorStep {
    this.time += dt;
    switch (this.phase) {
      case 'idle': {
        const d = doorAt(this.doors, x, z);
        if (!d) {
          this.armed = true;
          return {};
        }
        if (!this.armed || !canUse) return {};
        this.armed = false;
        this.door = d;
        this.phase = 'ringing';
        this.time = 0;
        return { entered: d };
      }
      case 'ringing':
        if (this.time >= (this.door?.bell ? this.timing.ring : this.timing.knockless)) {
          this.phase = 'fadeOut';
          this.time = 0;
        }
        return {};
      case 'fadeOut':
        if (this.time >= this.timing.fade && this.door) {
          const door = this.door;
          this.phase = 'fadeIn';
          this.time = 0;
          return { teleport: door };
        }
        return {};
      case 'fadeIn':
        if (this.time >= this.timing.fade) {
          this.phase = 'idle';
          this.door = null;
          this.time = 0;
        }
        return {};
    }
  }
}
