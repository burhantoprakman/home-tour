/**
 * One call for a visit: viewer + realtime session + HUD over `canvas`. The web visit page and
 * the dev page (?mp) both use it.
 */
import type { AvatarId, FloorPlan, Room } from '@home-tour/shared';
import { isMobileDevice } from '../budget.ts';
import { createViewer, type Viewer, type ViewerOptions } from '../viewer.ts';
import { createHud } from './hud.ts';
import { joinHome, type HomeSession } from './session.ts';

export interface VisitOptions {
  homeId: string;
  floorPlan: FloorPlan;
  rooms: Room[];
  ticket: string;
  realtimeUrl: string;
  avatarId: AvatarId;
  tint: string;
  avatarUrl?: ViewerOptions['avatarUrl'];
  dev?: ViewerOptions['dev'];
}

export interface Visit {
  viewer: Viewer;
  /** Resolves once joined; rejects if the realtime room refused us (the HUD shows why). */
  session: Promise<HomeSession>;
  dispose(): void;
}

export function visitHome(canvas: HTMLCanvasElement, opts: VisitOptions): Visit {
  const viewer = createViewer(canvas, {
    floorPlan: opts.floorPlan,
    rooms: opts.rooms,
    avatarId: opts.avatarId,
    avatarTint: opts.tint,
    ...(opts.avatarUrl ? { avatarUrl: opts.avatarUrl } : {}),
    ...(opts.dev ? { dev: opts.dev } : {}),
  });
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  const mobile = isMobileDevice({
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    uaDataMobile: nav.userAgentData?.mobile,
  });
  let session: HomeSession | null = null;
  const hud = createHud(canvas.parentElement ?? document.body, {
    mobile,
    sendChat: (text) => session?.sendChat(text),
    emote: (id) => viewer.playEmote(id),
  });
  const joining = joinHome(viewer, opts, {
    status: (s, reason) => hud.setStatus(s, reason),
    chat: (line, mine) => hud.addChat(line, mine),
    chatLimited: () => hud.notice('Slow down: too many messages.'),
    players: (p) => hud.setPlayers(p),
  }).then((s) => (session = s));
  joining.catch(() => {}); // surfaced through the HUD status
  return {
    viewer,
    session: joining,
    dispose() {
      void session?.leave();
      hud.dispose();
      viewer.dispose();
    },
  };
}
