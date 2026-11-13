import { CHAT_BURST, CHAT_WINDOW_MS, TRANSFORM_HZ } from '@home-tour/shared';

/** Transforms closer together than this are dropped (some jitter allowed under 1/TRANSFORM_HZ). */
export const MIN_TRANSFORM_GAP_MS = 0.8 * (1000 / TRANSFORM_HZ);

/** Sliding-window limiter: allow() is true for at most `burst` calls per `windowMs`. */
export class RateLimiter {
  private times: number[] = [];
  private readonly burst: number;
  private readonly windowMs: number;

  constructor(burst = CHAT_BURST, windowMs = CHAT_WINDOW_MS) {
    this.burst = burst;
    this.windowMs = windowMs;
  }

  allow(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.burst) return false;
    this.times.push(now);
    return true;
  }
}

/** Positions further than this from the home origin are rejected (homes are tens of metres). */
export const MAX_COORD_M = 500;
