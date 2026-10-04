/**
 * footnoteTapExtender — the mobile coordinate-based tap zone around footnote /
 * citation / hypercite markers. Its search is BLIND TO STACKING: it scans the
 * whole document by raw coordinates, so without a layer guard a tap on a menu
 * button sitting OVER a citation found the covered citation, preventDefault'ed
 * the touchend (suppressing the synthetic click the menu button needed) and
 * opened the citation THROUGH the panel — the "tapping a menu row presses the
 * link beneath it" bug (user-container flyout over reader text, 2026-10).
 *
 * The invariant pinned here: the extender only converts taps whose hit-tested
 * TARGET lies on book content (.main-content or a hyperlit container). Chrome
 * stacked on top — menus, flyouts, overlays, toolbars — always wins, with no
 * per-surface denylist to keep current.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/hyperlitContainer/footnotesCitations', () => ({
  handleFootnoteOrCitationClick: vi.fn(),
}));
vi.mock('../../../resources/js/scrolling/index', () => ({
  isActivelyScrollingForLinkBlock: () => false,
}));

import { initFootnoteTapExtender } from '../../../resources/js/hyperlitContainer/footnoteTapExtender';
import { handleFootnoteOrCitationClick } from '../../../resources/js/hyperlitContainer/footnotesCitations';

/** Stub a fixed viewport rect on an element (happy-dom rects are all zeros). */
function rect(el, { left, top, width, height }) {
  el.getBoundingClientRect = () => ({
    left, top, width, height,
    right: left + width,
    bottom: top + height,
    x: left, y: top,
    toJSON: () => {},
  });
}

/** Dispatch a fabricated touch event on document with one touch point. */
function touch(type, target, x, y) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const point = { target, clientX: x, clientY: y };
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [point] });
  Object.defineProperty(ev, 'changedTouches', { value: [point] });
  Object.defineProperty(ev, 'target', { value: target });
  const pd = vi.spyOn(ev, 'preventDefault');
  document.dispatchEvent(ev);
  return pd;
}

describe('footnoteTapExtender layer guard', () => {
  let extender;
  let main, sup, menuBtn;
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    // The extender only installs on coarse-pointer devices.
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });

    document.body.innerHTML = `
      <main id="book_1" class="main-content">
        <p id="100">Some text <sup fn-count-id="1" id="fnA">1</sup> more text</p>
      </main>
      <div id="user-container" class="open">
        <button id="statsBtn" class="menu-row-btn">Stats</button>
      </div>
    `;
    main = document.querySelector('.main-content');
    sup = document.getElementById('fnA');
    menuBtn = document.getElementById('statsBtn');

    // The citation marker sits at (100,100); the menu button is stacked
    // directly over the same spot (fixed flyout covering the text).
    rect(sup, { left: 100, top: 100, width: 12, height: 12 });
    rect(menuBtn, { left: 60, top: 90, width: 140, height: 36 });

    extender = initFootnoteTapExtender();
    vi.mocked(handleFootnoteOrCitationClick).mockClear();
  });

  afterEach(() => {
    extender?.destroy();
    window.matchMedia = realMatchMedia;
    document.body.innerHTML = '';
  });

  it('a tap hitting a menu button stacked over a citation is NOT converted (no handler, no preventDefault)', () => {
    touch('touchstart', menuBtn, 105, 105);
    const pd = touch('touchend', menuBtn, 105, 105);

    expect(handleFootnoteOrCitationClick).not.toHaveBeenCalled();
    // preventDefault on touchend would suppress the synthetic click the menu
    // button's own click handler depends on — it must never fire here.
    expect(pd).not.toHaveBeenCalled();
  });

  it('a tap on a full-screen overlay over content is NOT converted either', () => {
    const overlay = document.createElement('div');
    overlay.id = 'user-overlay';
    overlay.className = 'active';
    document.body.appendChild(overlay);
    rect(overlay, { left: 0, top: 0, width: 800, height: 600 });

    touch('touchstart', overlay, 105, 105);
    const pd = touch('touchend', overlay, 105, 105);

    expect(handleFootnoteOrCitationClick).not.toHaveBeenCalled();
    expect(pd).not.toHaveBeenCalled();
  });

  it('POSITIVE control: a near-miss tap on the reader text itself still extends to the marker', () => {
    // Target is the paragraph (content context), 6px left of the sup — inside
    // the 8px main-content zone. This is the case the extender exists for,
    // and it keeps the guard from "fixing" the bug by bailing on everything.
    const p = document.getElementById('100');
    touch('touchstart', p, 94, 106);
    const pd = touch('touchend', p, 94, 106);

    expect(handleFootnoteOrCitationClick).toHaveBeenCalledTimes(1);
    expect(handleFootnoteOrCitationClick).toHaveBeenCalledWith(sup);
    expect(pd).toHaveBeenCalled();
  });
});
