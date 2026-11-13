/**
 * In-visit overlay, plain DOM over the viewer canvas: chat panel (log + input), emote wheel
 * (Q or the 🙂 button; 1-6 picks), who's here, and the connection banner. Used by the web
 * visit page and the viewer dev page alike.
 */
import {
  CHAT_MAX_LENGTH,
  EMOTE_IDS,
  MAX_PLAYERS_PER_HOME,
  type ChatBroadcast,
  type EmoteId,
} from '@home-tour/shared';
import type { NetStatus, PlayerInfo } from './session.ts';

export const EMOTE_LABELS: Record<EmoteId, string> = {
  wave: '👋 Wave',
  dance: '💃 Dance',
  clap: '👏 Clap',
  cheer: '🙌 Cheer',
  yes: '👍 Yes',
  no: '👎 No',
};

const LOG_LINES = 50;

export interface Hud {
  addChat(line: ChatBroadcast, mine: boolean): void;
  notice(text: string): void;
  setPlayers(players: PlayerInfo[]): void;
  setStatus(status: NetStatus, reason?: string): void;
  dispose(): void;
}

const css = `
.ht-hud{position:absolute;inset:0;pointer-events:none;font:14px/1.35 system-ui,sans-serif;color:#fff}
.ht-hud button{font:inherit;cursor:pointer}
.ht-chat{position:absolute;left:12px;bottom:12px;width:min(340px,calc(100% - 24px));pointer-events:auto;display:flex;flex-direction:column;gap:6px}
.ht-log{max-height:30vh;overflow-y:auto;background:rgba(0,0,0,.45);border-radius:10px;padding:6px 10px;display:flex;flex-direction:column;gap:2px}
.ht-log:empty{display:none}
.ht-log b{font-weight:600;margin-right:4px}
.ht-log .me b{color:#ffd76a}
.ht-log .sys{opacity:.75;font-style:italic}
.ht-row{display:flex;gap:6px}
.ht-input{flex:1;min-width:0;padding:8px 10px;border-radius:10px;border:0;background:rgba(255,255,255,.92);color:#111;font:inherit}
.ht-btn{padding:8px 12px;border-radius:10px;border:0;background:rgba(0,0,0,.55);color:#fff}
.ht-who{position:absolute;right:12px;top:12px;background:rgba(0,0,0,.45);border-radius:10px;padding:6px 10px;max-width:45%}
.ht-who ul{margin:4px 0 0;padding:0;list-style:none}
.ht-banner{position:absolute;left:50%;top:12px;transform:translateX(-50%);background:#b3261e;padding:6px 12px;border-radius:10px;display:none}
.ht-wheel{position:absolute;left:50%;top:50%;width:240px;height:240px;margin:-120px 0 0 -120px;display:none;pointer-events:auto}
.ht-wheel button{position:absolute;width:88px;height:44px;margin:-22px 0 0 -44px;border-radius:22px;border:0;background:rgba(0,0,0,.7);color:#fff}
.ht-wheel button:hover,.ht-wheel button:focus{background:#2f6fd6;outline:none}
.ht-hint{opacity:.7;font-size:12px}
@media (max-width:600px){.ht-log{max-height:22vh}.ht-hint{display:none}}
`;

export function createHud(
  container: HTMLElement,
  actions: { sendChat(text: string): void; emote(id: EmoteId): void; mobile: boolean },
): Hud {
  const style = document.createElement('style');
  style.textContent = css;
  const root = document.createElement('div');
  root.className = 'ht-hud';
  root.innerHTML = `
    <div class="ht-banner" role="status"></div>
    <div class="ht-who"><span class="ht-count"></span><ul></ul></div>
    <div class="ht-wheel" role="menu" aria-label="Emotes"></div>
    <div class="ht-chat">
      <div class="ht-log" aria-live="polite"></div>
      <form class="ht-row">
        <input class="ht-input" maxlength="${CHAT_MAX_LENGTH}" placeholder="Say something…" aria-label="Chat message" enterkeyhint="send" />
        <button type="button" class="ht-btn ht-emote" aria-label="Emotes">🙂</button>
      </form>
      <span class="ht-hint">Enter to chat · Q for emotes · E to sit · P first person</span>
    </div>`;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.append(style, root);

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const log = $<HTMLDivElement>('.ht-log');
  const form = $<HTMLFormElement>('form');
  const input = $<HTMLInputElement>('.ht-input');
  const wheel = $<HTMLDivElement>('.ht-wheel');
  const banner = $<HTMLDivElement>('.ht-banner');
  const count = $<HTMLSpanElement>('.ht-count');
  const who = $<HTMLUListElement>('.ht-who ul');

  const addLine = (cls: string, name: string | null, text: string) => {
    const div = document.createElement('div');
    div.className = cls;
    if (name) {
      const b = document.createElement('b');
      b.textContent = `${name}:`;
      div.append(b);
    }
    div.append(document.createTextNode(text));
    log.append(div);
    while (log.childElementCount > LOG_LINES) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  };

  // Emote wheel: six buttons on a circle; 1-6 pick while it's open.
  EMOTE_IDS.forEach((id, i) => {
    const a = (i / EMOTE_IDS.length) * Math.PI * 2 - Math.PI / 2;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = EMOTE_LABELS[id];
    b.title = `${i + 1}`;
    b.style.left = `${120 + Math.cos(a) * 88}px`;
    b.style.top = `${120 + Math.sin(a) * 88}px`;
    b.addEventListener('click', () => pick(id));
    wheel.append(b);
  });
  let wheelOpen = false;
  const setWheel = (open: boolean) => {
    wheelOpen = open;
    wheel.style.display = open ? 'block' : 'none';
    if (open && document.pointerLockElement) document.exitPointerLock();
  };
  const pick = (id: EmoteId) => {
    setWheel(false);
    actions.emote(id);
  };
  $<HTMLButtonElement>('.ht-emote').addEventListener('click', () => setWheel(!wheelOpen));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) actions.sendChat(text);
    input.value = '';
    // Phones keep the keyboard up for a reply; desktop returns to walking.
    if (!actions.mobile) input.blur();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.target === input) {
      if (e.key === 'Escape') input.blur();
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (document.pointerLockElement) document.exitPointerLock();
      input.focus();
    } else if (e.code === 'KeyQ' && !e.repeat) {
      setWheel(!wheelOpen);
    } else if (wheelOpen && e.key === 'Escape') {
      setWheel(false);
    } else if (wheelOpen && /^Digit[1-6]$/.test(e.code)) {
      const id = EMOTE_IDS[Number(e.code.slice(5)) - 1];
      if (id) pick(id);
    }
  };
  window.addEventListener('keydown', onKey);

  return {
    addChat(line, mine) {
      addLine(mine ? 'me' : '', line.name, line.text);
    },
    notice(text) {
      addLine('sys', null, text);
    },
    setPlayers(players) {
      count.textContent = `Here now: ${players.length}/${MAX_PLAYERS_PER_HOME}`;
      who.replaceChildren(
        ...players.map((p) => {
          const li = document.createElement('li');
          li.textContent = p.self ? `${p.name} (you)` : p.name;
          return li;
        }),
      );
    },
    setStatus(status, reason) {
      const text =
        status === 'reconnecting'
          ? 'Connection lost, reconnecting…'
          : status === 'disconnected'
            ? `Disconnected${reason ? `: ${reason}` : ''}`
            : status === 'connecting'
              ? 'Connecting…'
              : '';
      banner.textContent = text;
      banner.style.display = text ? 'block' : 'none';
      banner.style.background = status === 'connecting' ? 'rgba(0,0,0,.55)' : '#b3261e';
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      root.remove();
      style.remove();
    },
  };
}
