// Drag-to-move for the audio pill. The pill is fixed bottom-centre at
// z-index 999998, which is the right DEFAULT but lands on top of the edit
// toolbar and the corner button clusters on smaller screens. So movement is
// opt-in: until the user grabs the dotted grip the pill keeps its default
// position; once moved, the position persists as a fraction of the free
// viewport space (so it survives a resize or a different monitor) and
// double-clicking the grip puts it back.
//
// Lifecycle: created by initAudioPlayer, destroyed by destroyAudioPlayer. The
// pill's markup lives in reader.blade.php and PERSISTS across SPA navigation,
// so every listener MUST be removed in destroy() — same reason as
// PlayerBar.destroy (otherwise each reader re-entry stacks another drag).

import { verbose } from '../../utilities/logger';

const BAR_ID = 'audio-player-bar';
const GRIP_ID = 'audio-drag-handle';
const MOVED_CLASS = 'audio-player-bar--moved';
const DRAGGING_CLASS = 'audio-dragging';
const STORAGE_KEY = 'hyperlitAudioPillPos';
/** Keep this much clear of every viewport edge. */
const MARGIN = 8;
const NUDGE_PX = 10;
const NUDGE_BIG_PX = 40;

/**
 * xFrac/yFrac are 0..1 positions within the FREE space (viewport minus the
 * pill), not raw pixels and not a fraction of the viewport. A pill parked
 * bottom-right stays bottom-right on a different monitor, a centred one stays
 * centred, and the value is inherently clamp-safe.
 */
interface StoredPos {
  v: 1;
  xFrac: number;
  yFrac: number;
}

export interface PlayerDragHandle {
  destroy(): void;
  /** Back to the default bottom-centre position, forgetting the saved one. */
  reset(): void;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function initPlayerDrag(): PlayerDragHandle | null {
  const bar = document.getElementById(BAR_ID);
  const grip = document.getElementById(GRIP_ID);
  if (!bar || !grip) return null;

  const listeners: Array<[EventTarget, string, EventListener]> = [];
  const on = (target: EventTarget, type: string, listener: EventListener): void => {
    target.addEventListener(type, listener);
    listeners.push([target, type, listener]);
  };

  /** How far the pill's top-left may travel before it leaves the viewport. */
  function freeSpace(): { maxX: number; maxY: number } {
    const rect = bar!.getBoundingClientRect();
    const width = rect.width || bar!.offsetWidth;
    const height = rect.height || bar!.offsetHeight;

    return {
      maxX: Math.max(0, window.innerWidth - width - MARGIN * 2),
      maxY: Math.max(0, window.innerHeight - height - MARGIN * 2),
    };
  }

  /** Place by absolute px, clamped inside the viewport. */
  function placeAtPx(x: number, y: number): void {
    const { maxX, maxY } = freeSpace();
    const left = Math.min(MARGIN + maxX, Math.max(MARGIN, x));
    const top = Math.min(MARGIN + maxY, Math.max(MARGIN, y));
    bar!.classList.add(MOVED_CLASS);
    bar!.style.left = `${Math.round(left)}px`;
    bar!.style.top = `${Math.round(top)}px`;
  }

  function placeAtFrac(pos: StoredPos): void {
    const { maxX, maxY } = freeSpace();
    placeAtPx(MARGIN + clamp01(pos.xFrac) * maxX, MARGIN + clamp01(pos.yFrac) * maxY);
  }

  function save(): void {
    const { maxX, maxY } = freeSpace();
    const rect = bar!.getBoundingClientRect();
    const pos: StoredPos = {
      v: 1,
      xFrac: maxX > 0 ? clamp01((rect.left - MARGIN) / maxX) : 0,
      yFrac: maxY > 0 ? clamp01((rect.top - MARGIN) / maxY) : 0,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
    } catch { /* private mode — the pill just won't remember */ }
  }

  function load(): StoredPos | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw) as StoredPos;
      if (pos?.v !== 1 || typeof pos.xFrac !== 'number' || typeof pos.yFrac !== 'number') return null;
      if (Number.isNaN(pos.xFrac) || Number.isNaN(pos.yFrac)) return null;

      return pos;
    } catch {
      return null; // corrupt/legacy value — fall back to the default position
    }
  }

  function reset(): void {
    bar!.classList.remove(MOVED_CLASS);
    bar!.style.left = '';
    bar!.style.top = '';
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* private mode */ }
  }

  let dragging = false;
  let moved = false;
  let offsetX = 0;
  let offsetY = 0;

  on(grip, 'pointerdown', (ev) => {
    const e = ev as PointerEvent;
    if (e.button !== undefined && e.button !== 0) return;
    const rect = bar.getBoundingClientRect();
    dragging = true;
    moved = false;
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    // Anchor to left/top BEFORE the first move. Adding MOVED_CLASS mid-drag
    // drops the centring transform:translateX(-50%), which would make the pill
    // jump half its own width sideways on the first pointermove.
    placeAtPx(rect.left, rect.top);
    try {
      grip.setPointerCapture(e.pointerId);
    } catch { /* not supported (or a synthetic test event) — move still works */ }
    bar.classList.add(DRAGGING_CLASS);
    e.preventDefault();
  });

  on(grip, 'pointermove', (ev) => {
    const e = ev as PointerEvent;
    if (!dragging) return;
    moved = true;
    placeAtPx(e.clientX - offsetX, e.clientY - offsetY);
    e.preventDefault();
  });

  const endDrag = (ev: Event): void => {
    if (!dragging) return;
    dragging = false;
    const e = ev as PointerEvent;
    try {
      grip.releasePointerCapture(e.pointerId);
    } catch { /* never captured */ }
    bar.classList.remove(DRAGGING_CLASS);
    if (moved) save();
  };
  on(grip, 'pointerup', endDrag);
  on(grip, 'pointercancel', endDrag);
  on(grip, 'lostpointercapture', endDrag);

  on(grip, 'dblclick', (ev) => {
    ev.preventDefault();
    reset();
  });

  // Keyboard equivalent. The grip lives inside #audio-player-bar, which
  // PlaybackController's user-scroll listener exempts, so nudging with the
  // arrows does NOT disable follow mode.
  on(grip, 'keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key === 'Home') {
      e.preventDefault();
      reset();

      return;
    }
    const step = e.shiftKey ? NUDGE_BIG_PX : NUDGE_PX;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    e.preventDefault(); // stop the page scrolling under the nudge
    const rect = bar.getBoundingClientRect();
    placeAtPx(rect.left + dx, rect.top + dy);
    save();
  });

  on(window, 'resize', () => {
    const pos = load();
    if (pos) placeAtFrac(pos);
  });

  // The pill's WIDTH changes as the status text does ("1 / 30" → "Generating
  // audio…"), which can push a left/top-anchored pill off the right edge.
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      if (dragging || !bar.classList.contains(MOVED_CLASS)) return;
      const rect = bar.getBoundingClientRect();
      placeAtPx(rect.left, rect.top); // placeAtPx clamps
    });
    observer.observe(bar);
  }

  // `visibility: hidden` preserves layout, so this measures correctly even
  // while the pill is hidden — it fades in already in place.
  const stored = load();
  if (stored) placeAtFrac(stored);

  verbose.init('audioPlayer: pill drag armed', '/components/audioPlayer/playerDrag');

  return {
    reset,
    destroy(): void {
      for (const [target, type, listener] of listeners) {
        target.removeEventListener(type, listener);
      }
      listeners.length = 0;
      observer?.disconnect();
      observer = null;
      // The POSITION is intentionally left applied: the pill keeps its place
      // across SPA navigation, and init re-applies it from storage anyway.
    },
  };
}
