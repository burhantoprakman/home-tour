/**
 * Sitting: which seats are offered, which one E / a tap picks, and the walk-there-then-sit state
 * machine. Pure logic; the viewer draws the rings and plays the clips.
 *
 * Seat positions are world space (already placed by the floor plan). A seat's position is the
 * centre of its surface and `facingYaw` the direction a sitter faces (0 = -Z).
 */

export interface WorldSeat {
  id: string;
  roomId: string;
  x: number;
  y: number;
  z: number;
  facingYaw: number;
  confirmed: boolean;
}

/** Seats within this horizontal distance of the feet glow and can be picked. */
export const SEAT_RANGE = 2;
/** Max height difference between feet and seat surface (same floor). */
const SEAT_MAX_RISE = 1.2;

/**
 * The sit clip puts the hips SIT_BACK metres behind the avatar's feet origin and the seat contact
 * SIT_HEIGHT above it (measured on the shared rig; see scripts/build-avatars.ts).
 */
export const SIT_BACK = 0.33;
export const SIT_HEIGHT = 0.47;

export function seatsInRange(
  seats: readonly WorldSeat[],
  feet: { x: number; y: number; z: number },
  showUnconfirmed: boolean,
  range = SEAT_RANGE,
): WorldSeat[] {
  return seats.filter(
    (s) =>
      (s.confirmed || showUnconfirmed) &&
      Math.hypot(s.x - feet.x, s.z - feet.z) <= range &&
      Math.abs(s.y - feet.y) <= SEAT_MAX_RISE,
  );
}

export function nearestSeat(
  seats: readonly WorldSeat[],
  feet: { x: number; z: number },
): WorldSeat | null {
  let best: WorldSeat | null = null;
  let bestD = Infinity;
  for (const s of seats) {
    const d = Math.hypot(s.x - feet.x, s.z - feet.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** The on-screen seat nearest a tap, if within `radius` CSS pixels. */
export function pickSeatOnScreen<T>(
  points: readonly { seat: T; x: number; y: number }[],
  tapX: number,
  tapY: number,
  radius = 48,
): T | null {
  let best: T | null = null;
  let bestD = radius;
  for (const p of points) {
    const d = Math.hypot(p.x - tapX, p.y - tapY);
    if (d <= bestD) {
      bestD = d;
      best = p.seat;
    }
  }
  return best;
}

/** Where the avatar's feet go to sit on `seat`, and which way it faces; `scale` = avatar scale. */
export function sitSpot(
  seat: WorldSeat,
  scale = 1,
): { x: number; y: number; z: number; yaw: number } {
  const fx = -Math.sin(seat.facingYaw),
    fz = -Math.cos(seat.facingYaw);
  return {
    x: seat.x + fx * SIT_BACK * scale,
    y: seat.y - SIT_HEIGHT * scale,
    z: seat.z + fz * SIT_BACK * scale,
    yaw: seat.facingYaw,
  };
}

export type SitState = 'none' | 'approach' | 'sittingDown' | 'seated' | 'standingUp';

export interface SitInput {
  /** Feet position now. */
  x: number;
  z: number;
  /** The player is pushing a move input (cancels the approach, stands up when seated). */
  wantsMove: boolean;
}

/** Arrived when the feet are this close to the sit spot. */
const ARRIVE = 0.12;
/** Close enough to snap when blocked (the seat itself usually blocks the last half metre). */
const SNAP_NEAR = 1.0;
/** Blocked this long near the seat -> snap; anywhere -> snap (plan: "blocked > 2 s"). */
const BLOCKED_NEAR_S = 0.25;
const BLOCKED_FAR_S = 2;

/**
 * idle -> (request) approach -> sittingDown -> seated -> (move) standingUp -> none.
 * During `approach` the machine steers: `update` returns the walk velocity to feed the controller.
 */
export class SitMachine {
  state: SitState = 'none';
  seat: WorldSeat | null = null;
  /** Seconds in the current state. */
  time = 0;
  /** True when the last approach ended by snapping instead of arriving. */
  snapped = false;
  private blocked = 0;
  private lastX = 0;
  private lastZ = 0;

  readonly walkSpeed: number;
  readonly sitDownSeconds: number;
  readonly standUpSeconds: number;
  readonly scale: number;

  constructor(walkSpeed: number, sitDownSeconds = 1.3, standUpSeconds = 1.03, scale = 1) {
    this.walkSpeed = walkSpeed;
    this.scale = scale;
    this.sitDownSeconds = sitDownSeconds;
    this.standUpSeconds = standUpSeconds;
  }

  /** Starts walking to `seat` (ignored while sitting or getting up). */
  request(seat: WorldSeat, from: { x: number; z: number }): void {
    if (this.state !== 'none' && this.state !== 'approach') return;
    this.seat = seat;
    this.enter('approach');
    this.blocked = 0;
    this.lastX = from.x;
    this.lastZ = from.z;
  }

  /** Advances the machine. Returns the steering velocity while approaching, else null. */
  update(dt: number, input: SitInput): { vx: number; vz: number } | null {
    this.time += dt;
    switch (this.state) {
      case 'none':
        return null;
      case 'approach': {
        const seat = this.seat;
        if (!seat || input.wantsMove) {
          this.cancel();
          return null;
        }
        const spot = sitSpot(seat, this.scale);
        const dx = spot.x - input.x,
          dz = spot.z - input.z;
        const dist = Math.hypot(dx, dz);
        const moved = Math.hypot(input.x - this.lastX, input.z - this.lastZ);
        this.lastX = input.x;
        this.lastZ = input.z;
        // Blocked: covering under a third of the distance the walk speed should give.
        if (dt > 0 && moved < this.walkSpeed * dt * 0.33) this.blocked += dt;
        else this.blocked = 0;
        if (dist <= ARRIVE) {
          this.snapped = false;
          this.enter('sittingDown');
          return null;
        }
        if ((this.blocked > BLOCKED_NEAR_S && dist <= SNAP_NEAR) || this.blocked > BLOCKED_FAR_S) {
          this.snapped = true;
          this.enter('sittingDown');
          return null;
        }
        const speed = Math.min(this.walkSpeed, dist / Math.max(dt, 1e-3));
        return { vx: (dx / dist) * speed, vz: (dz / dist) * speed };
      }
      case 'sittingDown':
        if (this.time >= this.sitDownSeconds) this.enter('seated');
        return null;
      case 'seated':
        if (input.wantsMove) this.enter('standingUp');
        return null;
      case 'standingUp':
        if (this.time >= this.standUpSeconds) {
          this.seat = null;
          this.enter('none');
        }
        return null;
    }
  }

  /** True while the avatar is on (or getting onto / off) the seat: movement is locked. */
  get locked(): boolean {
    return this.state === 'sittingDown' || this.state === 'seated' || this.state === 'standingUp';
  }

  /** Gets up from the seat (same as a move input while seated). */
  stand(): void {
    if (this.state === 'seated') this.enter('standingUp');
  }

  /** Gets up now, even halfway through sitting down (the seat was taken). */
  forceStand(): void {
    if (this.state === 'sittingDown' || this.state === 'seated') this.enter('standingUp');
  }

  cancel(): void {
    this.seat = null;
    this.enter('none');
  }

  private enter(state: SitState) {
    this.state = state;
    this.time = 0;
  }
}
