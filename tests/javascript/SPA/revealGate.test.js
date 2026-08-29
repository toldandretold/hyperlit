/**
 * RevealGate — the resume-curtain hold ("Finding your previous position…").
 *
 * Under test (resources/js/SPA/navigation/RevealGate.ts +
 * ProgressOverlayEnactor curtain mode):
 *  - completion() resolves immediately when unarmed (home/user/new-book paths
 *    must never stall on the gate)
 *  - arm() escalates a VISIBLE boot overlay into the opaque curtain (hlHold
 *    attr for the blade visibilitychange guard, go-to-top button, text) and
 *    refuses when the overlay is already gone (late-arm guard)
 *  - the 4s hard cap, user gestures (wheel), and Escape all release the hold
 *  - landed() + a quiet scroller resolves via the 400ms stability window;
 *    a scroller that keeps moving holds the gate
 *  - goToTop() scrolls the reader to 0, stamps a synthetic gesture (the
 *    cancel-all-corrections seam), and releases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LOADER_STATE_PATH = '../../../resources/js/pageLoad/currentLazyLoaderState';
const INTERNAL_NAV_PATH = '../../../resources/js/scrolling/internalNav';

function buildOverlayDom({ visible = true } = {}) {
  document.body.innerHTML = `
    <div id="initial-navigation-overlay" class="navigation-overlay"
         style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.3); z-index: 10000; pointer-events: none; display: ${visible ? 'block' : 'none'};">
      <div id="progress-overlay-wrapper">
        <p class="progress-text" id="page-load-progress-text">Loading...</p>
        <div class="progress-bar-container"><div class="progress-bar" id="page-load-progress-bar"></div></div>
        <p class="progress-details" id="page-load-progress-details">Initializing...</p>
      </div>
    </div>`;
  return document.getElementById('initial-navigation-overlay');
}

function makeScroller() {
  const el = document.createElement('div');
  let top = 1000;
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v) => { top = v; },
    configurable: true,
  });
  el.scrollTo = vi.fn((opts) => { top = opts?.top ?? 0; });
  document.body.appendChild(el);
  return el;
}

async function loadGate({ loader, navigateToInternalId } = {}) {
  vi.resetModules();
  vi.doMock(LOADER_STATE_PATH, () => ({
    currentLazyLoader: loader ?? null,
    setCurrentLazyLoader: vi.fn(),
  }));
  vi.doMock(INTERNAL_NAV_PATH, () => ({
    navigateToInternalId: navigateToInternalId ?? vi.fn(() => Promise.resolve({ success: true })),
  }));
  const { RevealGate } = await import('../../../resources/js/SPA/navigation/RevealGate');
  const { ProgressOverlayEnactor } = await import('../../../resources/js/SPA/navigation/ProgressOverlayEnactor');
  const { userScrollState } = await import('../../../resources/js/scrolling/navState');
  return { RevealGate, ProgressOverlayEnactor, userScrollState };
}

function resolvedWithin(promise, ms) {
  return Promise.race([
    promise.then(() => true),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);
}

describe('RevealGate resume-curtain hold', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock(LOADER_STATE_PATH);
    vi.doUnmock(INTERNAL_NAV_PATH);
  });

  it('completion() resolves immediately when unarmed', async () => {
    buildOverlayDom();
    const { RevealGate } = await loadGate();
    await expect(resolvedWithin(RevealGate.completion(), 50)).resolves.toBe(true);
  });

  it('refuses to arm when the overlay is already hidden (late-arm guard)', async () => {
    buildOverlayDom({ visible: false });
    const { RevealGate } = await loadGate();
    RevealGate.arm('book_1');
    expect(RevealGate.state).toBe('idle');
    await expect(resolvedWithin(RevealGate.completion(), 50)).resolves.toBe(true);
  });

  it('arms into curtain mode: hlHold attr, opaque, button, held completion; disarm releases', async () => {
    const overlay = buildOverlayDom();
    const { RevealGate } = await loadGate();
    RevealGate.arm('book_1');
    expect(RevealGate.state).toBe('holding');
    expect(overlay.dataset.hlHold).toBe('1');
    expect(document.getElementById('resume-curtain-top-btn')).toBeTruthy();
    expect(document.getElementById('page-load-progress-text').textContent)
      .toContain('Restoring your reading position');
    await expect(resolvedWithin(RevealGate.completion(), 80)).resolves.toBe(false);

    RevealGate.disarm();
    expect(RevealGate.state).toBe('idle');
    expect(overlay.dataset.hlHold).toBeUndefined();
    await expect(resolvedWithin(RevealGate.completion(), 50)).resolves.toBe(true);
  });

  it('progress updates cannot clobber the curtain text', async () => {
    buildOverlayDom();
    const { RevealGate, ProgressOverlayEnactor } = await loadGate();
    RevealGate.arm('book_1');
    ProgressOverlayEnactor.update(42, 'Loading annotations');
    expect(document.getElementById('page-load-progress-text').textContent)
      .toContain('Restoring your reading position');
    RevealGate.disarm();
  });

  it('releases at the 4s hard cap', async () => {
    buildOverlayDom();
    vi.useFakeTimers();
    const { RevealGate } = await loadGate();
    RevealGate.arm('book_1');
    expect(RevealGate.state).toBe('holding');
    vi.advanceTimersByTime(4100);
    expect(RevealGate.state).toBe('idle');
    vi.useRealTimers();
    await expect(resolvedWithin(RevealGate.completion(), 50)).resolves.toBe(true);
  });

  it('a wheel gesture during the hold reveals immediately', async () => {
    buildOverlayDom();
    const { RevealGate } = await loadGate();
    RevealGate.arm('book_1');
    window.dispatchEvent(new Event('wheel'));
    expect(RevealGate.state).toBe('idle');
  });

  it('Escape reveals in place', async () => {
    buildOverlayDom();
    const { RevealGate } = await loadGate();
    RevealGate.arm('book_1');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(RevealGate.state).toBe('idle');
  });

  it('ad-hoc Enactor.hide() is deferred while the curtain holds', async () => {
    const overlay = buildOverlayDom();
    const { RevealGate, ProgressOverlayEnactor } = await loadGate();
    RevealGate.arm('book_1');
    await ProgressOverlayEnactor.hide(); // internalNav's landing cleanup calls this
    expect(overlay.style.display).not.toBe('none');
    RevealGate.disarm();
    await ProgressOverlayEnactor.hide();
    expect(overlay.style.display).toBe('none');
  });

  it('a blade-escalated hold (hlHold set pre-JS, gate never armed) is cleaned by hide()', async () => {
    const overlay = buildOverlayDom();
    const { ProgressOverlayEnactor } = await loadGate();
    // The layout blade sets these at first paint, before RevealGate exists.
    overlay.dataset.hlHold = '1';
    overlay.style.background = 'rgba(9, 10, 13, 0.98)';
    await ProgressOverlayEnactor.hide();
    expect(overlay.dataset.hlHold).toBeUndefined();
    expect(overlay.style.display).toBe('none');
  });

  it('landed(): a quiet, unmoving scroller resolves via the stability window', async () => {
    buildOverlayDom();
    const { RevealGate } = await loadGate();
    const scroller = makeScroller();
    RevealGate.arm('book_1');
    RevealGate.landed(scroller, Promise.resolve({ success: true }));
    // 400ms continuous stability + rAF cadence: give it 1.5s.
    await expect(resolvedWithin(RevealGate.completion(), 1500)).resolves.toBe(true);
  }, 10000);

  it('landed(): a scroller that keeps moving holds the gate past the window', async () => {
    buildOverlayDom();
    const { RevealGate } = await loadGate();
    const scroller = makeScroller();
    RevealGate.arm('book_1');
    RevealGate.landed(scroller, Promise.resolve({ success: true }));
    const mover = setInterval(() => { scroller.scrollTop += 10; }, 30);
    const settled = await resolvedWithin(RevealGate.completion(), 700);
    clearInterval(mover);
    expect(settled).toBe(false);
    RevealGate.disarm();
  }, 10000);

  it('goToTop(): NAVIGATES to the first node (never a bare scrollTo-0 into the windowed DOM), stamps a synthetic gesture, saves, releases', async () => {
    buildOverlayDom();
    const scroller = makeScroller();
    const saveScrollPosition = vi.fn();
    const navigateToInternalId = vi.fn(() => Promise.resolve({ success: true }));
    const loader = {
      scrollableParent: scroller,
      saveScrollPosition,
      nodes: [{ startLine: 300 }, { startLine: 100.5 }, { startLine: 200 }],
    };
    const { RevealGate, userScrollState } = await loadGate({ loader, navigateToInternalId });
    const gestureBefore = userScrollState.lastGestureScrollTime;
    RevealGate.arm('book_1');
    RevealGate.goToTop();
    expect(RevealGate.state).toBe('idle');
    expect(userScrollState.lastGestureScrollTime).toBeGreaterThanOrEqual(gestureBefore);
    expect(userScrollState.isNavigating).toBe(false);
    // Dynamic imports + the 300ms save defer.
    await new Promise((r) => setTimeout(r, 450));
    expect(navigateToInternalId).toHaveBeenCalledWith('100.5', loader, false, 0);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(saveScrollPosition).toHaveBeenCalled();
  }, 10000);

  it('goToTop(): with no node map falls back to a plain scroll to 0', async () => {
    buildOverlayDom();
    const scroller = makeScroller();
    const saveScrollPosition = vi.fn();
    const navigateToInternalId = vi.fn(() => Promise.resolve({ success: true }));
    const { RevealGate } = await loadGate({
      loader: { scrollableParent: scroller, saveScrollPosition, nodes: [] },
      navigateToInternalId,
    });
    RevealGate.arm('book_1');
    RevealGate.goToTop();
    await new Promise((r) => setTimeout(r, 450));
    expect(navigateToInternalId).not.toHaveBeenCalled();
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(saveScrollPosition).toHaveBeenCalled();
  }, 10000);
});
