/**
 * Player input. Desktop: WASD / arrows to walk, mouse (pointer lock, click the canvas) to look,
 * E to sit. Mobile: a virtual joystick on the left half, drag on the right half to look, tap a
 * seat ring to sit. The viewer reads `move` and `takeLook()` every frame.
 */

/** Degrees of camera rotation per pixel of mouse / finger movement. */
const MOUSE_SENSITIVITY = 0.15;
const TOUCH_SENSITIVITY = 0.3;
/** Joystick knob travel, CSS pixels. */
const STICK_RADIUS = 56;
/** A touch that moves less than this and ends within TAP_MS is a tap. */
const TAP_SLOP = 12;
const TAP_MS = 300;

export interface InputHandlers {
  /** E pressed. */
  interact(): void;
  /** Tap at canvas-relative CSS pixel coordinates. */
  tap(x: number, y: number): void;
  /** Any other key (dev shortcuts). */
  key?(code: string): void;
}

export class Input {
  /** Walk input: x = right, y = forward, each -1..1 (length <= 1). */
  readonly move = { x: 0, y: 0 };
  private readonly keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private stick: { id: number; x0: number; y0: number; x: number; y: number } | null = null;
  private readonly lookTouches = new Map<
    number,
    { x: number; y: number; x0: number; y0: number; t0: number }
  >();
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly cleanup: (() => void)[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly mobile: boolean;
  private readonly handlers: InputHandlers;
  /** Canvas offset in the page when the joystick touch began. */
  private originX = 0;
  private originY = 0;

  constructor(canvas: HTMLCanvasElement, mobile: boolean, handlers: InputHandlers) {
    this.canvas = canvas;
    this.mobile = mobile;
    this.handlers = handlers;
    [this.base, this.knob] = this.makeStick();
    const on = <K extends keyof WindowEventMap>(
      target: Window | HTMLElement,
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    on(canvas, 'click', () => {
      if (!this.mobile && document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    });
    on(window, 'mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.lookX += e.movementX * MOUSE_SENSITIVITY;
      this.lookY += e.movementY * MOUSE_SENSITIVITY;
    });
    on(window, 'keydown', (e) => {
      if (isTyping(e.target)) return;
      this.keys.add(e.code);
      if (e.code === 'KeyE' && !e.repeat) this.handlers.interact();
      else if (!e.repeat) this.handlers.key?.(e.code);
      this.updateKeys();
    });
    on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
      this.updateKeys();
    });
    on(window, 'blur', () => {
      this.keys.clear();
      this.updateKeys();
    });

    on(canvas, 'touchstart', (e) => this.touchStart(e), { passive: false });
    on(canvas, 'touchmove', (e) => this.touchMove(e), { passive: false });
    on(canvas, 'touchend', (e) => this.touchEnd(e));
    on(canvas, 'touchcancel', (e) => this.touchEnd(e));
  }

  /** Camera rotation (degrees yaw, degrees pitch) accumulated since the last call. */
  takeLook(): { yaw: number; pitch: number } {
    const out = { yaw: -this.lookX, pitch: -this.lookY };
    this.lookX = this.lookY = 0;
    return out;
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.base.remove();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private updateKeys() {
    if (this.stick) return;
    const k = this.keys;
    const y =
      Number(k.has('KeyW') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown'));
    const x =
      Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('ArrowLeft'));
    const len = Math.hypot(x, y) || 1;
    this.move.x = x / len;
    this.move.y = y / len;
  }

  private touchStart(e: TouchEvent) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    for (const t of Array.from(e.changedTouches)) {
      const x = t.clientX - rect.left;
      const y = t.clientY - rect.top;
      if (!this.stick && x < rect.width / 2) {
        this.stick = { id: t.identifier, x0: x, y0: y, x, y };
        this.originX = rect.left;
        this.originY = rect.top;
        this.showStick(true);
      } else {
        this.lookTouches.set(t.identifier, { x, y, x0: x, y0: y, t0: performance.now() });
      }
    }
    this.updateStick();
  }

  private touchMove(e: TouchEvent) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    for (const t of Array.from(e.changedTouches)) {
      const x = t.clientX - rect.left;
      const y = t.clientY - rect.top;
      if (this.stick?.id === t.identifier) {
        this.stick.x = x;
        this.stick.y = y;
        continue;
      }
      const look = this.lookTouches.get(t.identifier);
      if (!look) continue;
      this.lookX += (x - look.x) * TOUCH_SENSITIVITY;
      this.lookY += (y - look.y) * TOUCH_SENSITIVITY;
      look.x = x;
      look.y = y;
    }
    this.updateStick();
  }

  private touchEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (this.stick?.id === t.identifier) {
        this.stick = null;
        this.showStick(false);
        this.move.x = this.move.y = 0;
        continue;
      }
      const look = this.lookTouches.get(t.identifier);
      if (!look) continue;
      this.lookTouches.delete(t.identifier);
      const moved = Math.hypot(look.x - look.x0, look.y - look.y0);
      if (moved < TAP_SLOP && performance.now() - look.t0 < TAP_MS)
        this.handlers.tap(look.x, look.y);
    }
  }

  private updateStick() {
    const s = this.stick;
    if (!s) return;
    let dx = s.x - s.x0;
    let dy = s.y - s.y0;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx = (dx / len) * STICK_RADIUS;
      dy = (dy / len) * STICK_RADIUS;
    }
    this.move.x = dx / STICK_RADIUS;
    this.move.y = -dy / STICK_RADIUS;
    const left = this.originX + s.x0 - STICK_RADIUS;
    const top = this.originY + s.y0 - STICK_RADIUS;
    this.base.style.transform = `translate(${left}px, ${top}px)`;
    this.knob.style.transform = `translate(${STICK_RADIUS - 22 + dx}px, ${STICK_RADIUS - 22 + dy}px)`;
  }

  private showStick(visible: boolean) {
    this.base.style.display = visible ? 'block' : 'none';
  }

  /** Joystick visuals: a ring under the thumb's start point and a knob that follows it. */
  private makeStick(): [HTMLDivElement, HTMLDivElement] {
    const base = document.createElement('div');
    const knob = document.createElement('div');
    Object.assign(base.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${STICK_RADIUS * 2}px`,
      height: `${STICK_RADIUS * 2}px`,
      borderRadius: '50%',
      border: '2px solid rgb(255 255 255 / 0.5)',
      background: 'rgb(0 0 0 / 0.15)',
      boxSizing: 'border-box',
      pointerEvents: 'none',
      display: 'none',
      zIndex: '10',
    });
    Object.assign(knob.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '44px',
      height: '44px',
      borderRadius: '50%',
      background: 'rgb(255 255 255 / 0.6)',
    });
    base.appendChild(knob);
    document.body.appendChild(base);
    return [base, knob];
  }
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}
