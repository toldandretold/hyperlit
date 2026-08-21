/**
 * Regression net for the fixed right-hand panels' height sizing
 * (`resources/js/utilities/viewportMetrics.ts` + the KeyboardManager pass that drives it).
 *
 * THE BUG THIS LOCKS: tapping "Ask" in the brain-query panel set the question field to
 * contentEditable=false, which blurred it. KeyboardManager.handleFocusOut then eagerly
 * flipped `isKeyboardOpen = false` and re-measured the panel WHILE the iOS keyboard was
 * still animating down — so the panel got pinned to a keyboard-sized max-height. The real
 * `visualViewport` resize that followed could never undo it, because every branch in
 * processViewportChange is gated on the keyboard being open or on
 * `keyboardOpen !== this.isKeyboardOpen`, and by then BOTH sides were already false. The
 * panel stayed short for the whole streaming phase, so the status checklist (and its
 * progress animation) scrolled out of sight with nothing to bring it back.
 *
 * Secondary invariant: sizing is measured off `visualViewport`, never `window.innerHeight`
 * — on mobile innerHeight is the LARGE viewport (browser chrome collapsed), so a panel
 * sized from it extends under the URL/tab bar and its bottom is unreachable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  PANEL_TOP_MARGIN,
  getVisibleBottom,
  getPanelMaxHeight,
  resizeOpenPanels,
} from '../../../resources/js/utilities/viewportMetrics';

/** Stand in for visualViewport, and let a test move it like a real keyboard would. */
function installViewport({ height, offsetTop = 0, innerHeight = 745 }) {
  const listeners = { resize: [], scroll: [] };
  const vv = {
    height,
    offsetTop,
    addEventListener: (type, fn) => listeners[type]?.push(fn),
    removeEventListener: (type, fn) => {
      const arr = listeners[type];
      if (arr) arr.splice(arr.indexOf(fn), 1);
    },
  };
  window.visualViewport = vv;
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, writable: true, configurable: true });
  return {
    vv,
    /** Resize the visual viewport and fire the event, the way a keyboard transition does. */
    set(next) {
      Object.assign(vv, next);
      listeners.resize.forEach((fn) => fn());
    },
  };
}

/** The panel + the edit toolbar whose height is subtracted as the bottom gap. */
function buildDom({ toolbarHeight = 54, open = true } = {}) {
  document.body.innerHTML = `
    <div id="app-container"></div>
    <div id="hyperlit-container" class="container-panel ${open ? 'open' : 'hidden'}"><div class="scroller"></div></div>
    <div id="edit-toolbar"></div>
  `;
  const toolbar = document.getElementById('edit-toolbar');
  Object.defineProperty(toolbar, 'offsetHeight', { value: toolbarHeight, configurable: true });
  return document.getElementById('hyperlit-container');
}

const px = (el) => parseFloat(el.style.maxHeight);

describe('viewportMetrics — panel sizing basis', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.visualViewport;
    vi.restoreAllMocks();
  });

  it('measures from the VISIBLE viewport, not window.innerHeight', () => {
    // Mobile Safari with chrome expanded: innerHeight (745) overshoots what is on screen (640).
    installViewport({ height: 640, offsetTop: 0, innerHeight: 745 });
    buildDom({ toolbarHeight: 54 });

    expect(getVisibleBottom()).toBe(640);
    expect(getPanelMaxHeight()).toBe(640 - PANEL_TOP_MARGIN - 54);
    // The innerHeight-derived answer would have been 675 — 105px of panel under the URL bar.
    expect(getPanelMaxHeight()).not.toBe(745 - PANEL_TOP_MARGIN - 54);
  });

  it('uses offsetTop + height, since a position:fixed panel anchors to the layout viewport', () => {
    installViewport({ height: 400, offsetTop: 300, innerHeight: 745 });
    buildDom({ toolbarHeight: 54 });
    expect(getVisibleBottom()).toBe(700);
    expect(getPanelMaxHeight()).toBe(700 - PANEL_TOP_MARGIN - 54);
  });

  it('falls back to innerHeight only when the visualViewport API is absent', () => {
    installViewport({ height: 640, innerHeight: 745 });
    delete window.visualViewport;
    buildDom({ toolbarHeight: 54 });
    expect(getVisibleBottom()).toBe(745);
  });

  it('resizeOpenPanels only touches an OPEN base panel', () => {
    installViewport({ height: 640, innerHeight: 745 });
    const closed = buildDom({ toolbarHeight: 54, open: false });
    resizeOpenPanels();
    expect(closed.style.maxHeight).toBe('');

    closed.classList.add('open');
    resizeOpenPanels();
    expect(px(closed)).toBe(640 - PANEL_TOP_MARGIN - 54);
  });

  it('resizeOpenPanels sizes stacked layers off the same formula as the base', () => {
    installViewport({ height: 640, innerHeight: 745 });
    const base = buildDom({ toolbarHeight: 54 });
    const stacked = document.createElement('div');
    stacked.className = 'hyperlit-container-stacked';
    document.body.appendChild(stacked);

    resizeOpenPanels();
    expect(px(stacked)).toBe(px(base));
  });
});

describe('KeyboardManager — panel height survives the keyboard closing', () => {
  let KeyboardManager;

  beforeEach(async () => {
    vi.resetModules();
    ({ KeyboardManager } = await import('../../../resources/js/components/utilities/keyboardManager'));
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete window.visualViewport;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-measures on a SETTLED resize after focusout already flipped isKeyboardOpen', async () => {
    vi.useFakeTimers();
    const viewport = installViewport({ height: 640, offsetTop: 0, innerHeight: 745 });
    const panel = buildDom({ toolbarHeight: 54 });

    const km = new KeyboardManager();
    // iOS is the platform the bug lives on, and it is also the branch that compares against
    // the visual height captured at init (640) rather than innerHeight — without this the
    // keyboard heuristic misreads a chrome-shrunk 640/745 viewport as "keyboard open".
    km.isIOS = true;
    const fullHeight = 640 - PANEL_TOP_MARGIN - 54;

    // 1. User taps the question field: keyboard opens, panel legitimately shrinks.
    km.state.focusedElement = document.createElement('div');
    viewport.set({ height: 300, offsetTop: 0 });
    vi.advanceTimersByTime(200);
    expect(km.isKeyboardOpen).toBe(true);
    expect(px(panel)).toBe(300 - PANEL_TOP_MARGIN - 54);

    // 2. Tapping "Ask" sets contentEditable=false, which blurs the field with a null
    //    relatedTarget. The deferred close fires 80ms later — long before iOS has finished
    //    animating the keyboard away, so this re-measure reads a still-shrunken viewport.
    km.handleFocusOut({ relatedTarget: null });
    vi.advanceTimersByTime(80);
    expect(km.isKeyboardOpen).toBe(false);
    expect(px(panel)).toBe(300 - PANEL_TOP_MARGIN - 54); // stale — the bug's starting state

    // 3. Keyboard finishes closing; the real resize lands. Pre-fix this was a no-op because
    //    the transition gate saw false !== false, so the panel stayed short forever.
    viewport.set({ height: 640, offsetTop: 0 });
    vi.advanceTimersByTime(200);

    expect(px(panel)).toBe(fullHeight);
    km.destroy();
  });

  it('re-measures on a non-keyboard resize (rotation / mobile URL-bar collapse)', async () => {
    vi.useFakeTimers();
    const viewport = installViewport({ height: 640, offsetTop: 0, innerHeight: 745 });
    const panel = buildDom({ toolbarHeight: 54 });

    const km = new KeyboardManager();
    panel.style.maxHeight = '570px'; // whatever it was sized to before the viewport moved

    // Chrome collapses on scroll: no keyboard involved, both keyboard flags stay false.
    viewport.set({ height: 700, offsetTop: 0 });
    vi.advanceTimersByTime(200);

    expect(px(panel)).toBe(700 - PANEL_TOP_MARGIN - 54);
    km.destroy();
  });
});
