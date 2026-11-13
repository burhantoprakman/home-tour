/**
 * A two-tone "ding-dong" doorbell synthesised with Web Audio (no sound file to host). Browsers
 * only start audio after a user gesture; by the time a player has walked to a door they have
 * clicked or tapped the canvas, so the context can resume. Without Web Audio it stays silent.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** One bell strike: a sine with a quieter octave and a slightly sharp fifth, decaying. */
function strike(ac: AudioContext, at: number, freq: number, length: number) {
  const out = ac.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(0.35, at + 0.01);
  out.gain.exponentialRampToValueAtTime(0.0001, at + length);
  out.connect(ac.destination);
  for (const [mult, level] of [
    [1, 1],
    [2, 0.35],
    [3.01, 0.12],
  ] as const) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    g.gain.value = level;
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + length);
  }
}

/** Plays ding (E5) - dong (C5). */
export function ringDoorbell(): void {
  const ac = audio();
  if (!ac) return;
  void ac.resume().catch(() => {});
  const t = ac.currentTime + 0.02;
  strike(ac, t, 659.25, 1.1);
  strike(ac, t + 0.55, 523.25, 1.6);
}
