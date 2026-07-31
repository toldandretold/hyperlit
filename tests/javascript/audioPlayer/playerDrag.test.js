/**
 * The audio pill is fixed bottom-centre and covers the edit toolbar / corner
 * buttons on smaller screens, so playerDrag.ts lets the user move it. The things
 * that can silently break it:
 *   - the pill must never be draggable off screen (or it's gone for good);
 *   - the saved position must survive a viewport change, hence the fraction-of-
 *     free-space encoding rather than raw pixels;
 *   - destroy() must actually unhook, because the pill's markup lives in the
 *     blade and persists across SPA navigation — a leaked listener means every
 *     reader re-entry stacks another drag (the bug PlayerBar.destroy exists for).
 *
 * happy-dom's getBoundingClientRect returns zeros, so the pill's rect is stubbed
 * to track its own inline left/top — which is what the real layout would do.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initPlayerDrag } from '../../../resources/js/components/audioPlayer/playerDrag';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn(), error: vi.fn() },
  verbose: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  isVerboseEnabled: () => false,
}));

const STORAGE_KEY = 'hyperlitAudioPillPos';
const MOVED = 'audio-player-bar--moved';
const WIDTH = 300;
const HEIGHT = 60;
/** Where the un-moved, bottom-centred pill sits in the stub layout. */
const DEFAULT_LEFT = 350;
const DEFAULT_TOP = 730;

let bar;
let grip;
let handle;

function setViewport(width, height) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
}

function buildPill() {
  document.body.innerHTML = '';
  bar = document.createElement('div');
  bar.id = 'audio-player-bar';
  grip = document.createElement('button');
  grip.id = 'audio-drag-handle';
  grip.className = 'audio-drag-handle';
  bar.appendChild(grip);
  document.body.appendChild(bar);

  // Tracks the inline position the way a real fixed element would.
  bar.getBoundingClientRect = () => {
    const left = bar.style.left ? parseFloat(bar.style.left) : DEFAULT_LEFT;
    const top = bar.style.top ? parseFloat(bar.style.top) : DEFAULT_TOP;

    return {
      left, top, right: left + WIDTH, bottom: top + HEIGHT,
      x: left, y: top, width: WIDTH, height: HEIGHT, toJSON() {},
    };
  };
  grip.setPointerCapture = () => {};
  grip.releasePointerCapture = () => {};
}

function firePointer(target, type, { clientX = 0, clientY = 0, button = 0, pointerId = 1 } = {}) {
  const Ctor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
  const event = new Ctor(type, { clientX, clientY, button, bubbles: true, cancelable: true });
  if (event.pointerId === undefined) Object.defineProperty(event, 'pointerId', { value: pointerId });
  target.dispatchEvent(event);

  return event;
}

/** Grab the grip at its centre and drag the pill by (dx, dy). */
function drag(dx, dy) {
  const from = { clientX: DEFAULT_LEFT + 7, clientY: DEFAULT_TOP + 30 };
  firePointer(grip, 'pointerdown', from);
  firePointer(grip, 'pointermove', { clientX: from.clientX + dx, clientY: from.clientY + dy });
  firePointer(grip, 'pointerup', { clientX: from.clientX + dx, clientY: from.clientY + dy });
}

function stored() {
  const raw = localStorage.getItem(STORAGE_KEY);

  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  localStorage.clear();
  setViewport(1000, 800);
  buildPill();
  handle = initPlayerDrag();
});

afterEach(() => {
  handle?.destroy();
  handle = null;
});

describe('dragging the pill', () => {
  it('moves it, marks it moved, and remembers where', () => {
    drag(-200, -200);

    expect(bar.classList.contains(MOVED)).toBe(true);
    expect(parseFloat(bar.style.left)).toBe(DEFAULT_LEFT - 200);
    expect(parseFloat(bar.style.top)).toBe(DEFAULT_TOP - 200);
    expect(stored()).toMatchObject({ v: 1 });
    expect(stored().xFrac).toBeGreaterThan(0);
    expect(stored().yFrac).toBeGreaterThan(0);
  });

  it('cannot be dragged off the bottom-right of the screen', () => {
    drag(5000, 5000);

    expect(parseFloat(bar.style.left)).toBe(1000 - WIDTH - 8);
    expect(parseFloat(bar.style.top)).toBe(800 - HEIGHT - 8);
  });

  it('cannot be dragged off the top-left of the screen', () => {
    drag(-5000, -5000);

    expect(parseFloat(bar.style.left)).toBe(8);
    expect(parseFloat(bar.style.top)).toBe(8);
  });

  it('ignores a non-primary button', () => {
    firePointer(grip, 'pointerdown', { clientX: 360, clientY: 740, button: 2 });
    firePointer(grip, 'pointermove', { clientX: 100, clientY: 100 });

    expect(bar.classList.contains(MOVED)).toBe(false);
  });

  it('does not save a click that never moved', () => {
    firePointer(grip, 'pointerdown', { clientX: 357, clientY: 760 });
    firePointer(grip, 'pointerup', { clientX: 357, clientY: 760 });

    expect(stored()).toBeNull();
  });
});

describe('remembering the position', () => {
  it('restores it on the next init', () => {
    drag(-200, -150);
    const left = bar.style.left;
    const top = bar.style.top;

    handle.destroy();
    buildPill();
    handle = initPlayerDrag();

    expect(bar.classList.contains(MOVED)).toBe(true);
    expect(bar.style.left).toBe(left);
    expect(bar.style.top).toBe(top);
  });

  it('clamps a remembered position back on screen on a much smaller viewport', () => {
    drag(300, 0); // over toward the right edge
    handle.destroy();

    setViewport(400, 300);
    buildPill();
    handle = initPlayerDrag();

    const rect = bar.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(400);
    expect(rect.bottom).toBeLessThanOrEqual(300);
  });

  it('re-clamps when the window is resized under it', () => {
    drag(300, 0);

    setViewport(500, 400);
    window.dispatchEvent(new window.Event('resize'));

    const rect = bar.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(500);
    expect(rect.bottom).toBeLessThanOrEqual(400);
  });

  it('ignores a corrupt or legacy stored value and keeps the default position', () => {
    handle.destroy();
    localStorage.setItem(STORAGE_KEY, '{not json');
    buildPill();
    handle = initPlayerDrag();

    expect(bar.classList.contains(MOVED)).toBe(false);
    expect(bar.style.left).toBe('');
  });

  it('ignores a stored value from a future/unknown schema', () => {
    handle.destroy();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, x: 10, y: 10 }));
    buildPill();
    handle = initPlayerDrag();

    expect(bar.classList.contains(MOVED)).toBe(false);
  });
});

describe('reset and keyboard', () => {
  it('double-clicking the grip puts the pill back and forgets the position', () => {
    drag(-200, -200);

    grip.dispatchEvent(new window.Event('dblclick', { bubbles: true, cancelable: true }));

    expect(bar.classList.contains(MOVED)).toBe(false);
    expect(bar.style.left).toBe('');
    expect(bar.style.top).toBe('');
    expect(stored()).toBeNull();
  });

  it('nudges with the arrow keys, further with Shift', () => {
    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(parseFloat(bar.style.left)).toBe(DEFAULT_LEFT + 10);

    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
    expect(parseFloat(bar.style.left)).toBe(DEFAULT_LEFT + 50);

    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(parseFloat(bar.style.top)).toBe(DEFAULT_TOP - 10);

    expect(stored()).toMatchObject({ v: 1 });
  });

  it('Home resets', () => {
    drag(-200, -200);

    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));

    expect(bar.classList.contains(MOVED)).toBe(false);
    expect(stored()).toBeNull();
  });

  it('leaves other keys alone', () => {
    grip.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));

    expect(bar.classList.contains(MOVED)).toBe(false);
  });
});

describe('SPA lifecycle', () => {
  it('stops responding after destroy, so reader re-entry cannot stack drags', () => {
    handle.destroy();
    handle = null;

    drag(-200, -200);

    expect(bar.classList.contains(MOVED)).toBe(false);
    expect(bar.style.left).toBe('');
  });

  it('leaves the applied position alone on destroy — the pill keeps its place', () => {
    drag(-200, -200);
    const left = bar.style.left;

    handle.destroy();
    handle = null;

    expect(bar.style.left).toBe(left);
    expect(bar.classList.contains(MOVED)).toBe(true);
  });

  it('is a no-op when the pill markup is not on the page', () => {
    handle.destroy();
    document.body.innerHTML = '';

    expect(initPlayerDrag()).toBeNull();
  });
});
