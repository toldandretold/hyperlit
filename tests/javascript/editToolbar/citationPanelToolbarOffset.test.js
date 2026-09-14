/**
 * The blurred citation-results panel must sit exactly ON TOP of the edit
 * toolbar, offset by the toolbar's MEASURED height.
 *
 * THE BUG THIS LOCKS: `#citation-toolbar-results` hardcoded `bottom: 52px`
 * (desktop) / `bottom: 40px` (mobile) as a guess at the toolbar's height. The
 * real box is its padding + the control inside it + `env(safe-area-inset-bottom)`
 * — ~63px on desktop (14px top padding + ~31px search input + 18px bottom
 * padding) and ~67px+inset on mobile (12px / 24px padding). The panel outranks
 * the toolbar at `z-index: 9999999`, so being ~27px short on mobile meant the
 * blurred panel painted over the upper half of the citation search input: the
 * user typed into a field the results were covering.
 *
 * Note the keyboard-open path never had this bug — `KeyboardManager` already
 * positions the panel from a measured `toolbarHeight`. It was only the CSS
 * (keyboard-closed: desktop, and any window narrower than 769px) that guessed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  EDIT_TOOLBAR_HEIGHT_VAR,
  getEditToolbarHeight,
  publishEditToolbarHeight,
  trackEditToolbarHeight,
  untrackEditToolbarHeight,
} from '../../../resources/js/utilities/viewportMetrics';

const CSS = readFileSync(
  resolve(__dirname, '../../../resources/css/components/citationMode.css'),
  'utf8',
);

/** Build the toolbar with a settable measured height. */
function buildToolbar(height) {
  document.body.innerHTML = '<div id="edit-toolbar"></div>';
  const toolbar = document.getElementById('edit-toolbar');
  let current = height;
  Object.defineProperty(toolbar, 'offsetHeight', {
    get: () => current,
    configurable: true,
  });
  return { toolbar, setHeight: (next) => { current = next; } };
}

const publishedOffset = () =>
  document.documentElement.style.getPropertyValue(EDIT_TOOLBAR_HEIGHT_VAR);

describe('citation results panel — offset is the toolbar\'s measured height', () => {
  afterEach(() => {
    untrackEditToolbarHeight();
    document.documentElement.style.removeProperty(EDIT_TOOLBAR_HEIGHT_VAR);
    document.body.innerHTML = '';
    delete global.ResizeObserver;
    vi.restoreAllMocks();
  });

  it('publishes the toolbar height, not a hardcoded guess', () => {
    buildToolbar(67);
    publishEditToolbarHeight();
    expect(publishedOffset()).toBe('67px');
    // The mobile guess this replaced would have left 27px of the input covered.
    expect(publishedOffset()).not.toBe('40px');
  });

  it('reads 0 when the toolbar is absent, and publishes nothing', () => {
    document.body.innerHTML = '';
    expect(getEditToolbarHeight()).toBe(0);
    publishEditToolbarHeight();
    expect(publishedOffset()).toBe('');
  });

  it('ignores a 0 measurement rather than dropping the panel to the viewport floor', () => {
    const { setHeight } = buildToolbar(63);
    publishEditToolbarHeight();
    expect(publishedOffset()).toBe('63px');

    // Toolbar leaves the layout for a frame (display:none during a mode swap).
    setHeight(0);
    publishEditToolbarHeight();
    expect(publishedOffset()).toBe('63px');
  });

  it('re-publishes when the toolbar changes height (icon buttons -> text input)', () => {
    let fire;
    global.ResizeObserver = class {
      constructor(cb) { fire = cb; }
      observe() {}
      disconnect() {}
    };

    const { setHeight } = buildToolbar(60);
    trackEditToolbarHeight();
    expect(publishedOffset()).toBe('60px');

    // Entering citation mode swaps 28px icon buttons for the taller search input.
    setHeight(63);
    fire();
    expect(publishedOffset()).toBe('63px');
  });

  it('tracking is a no-op without a toolbar, and untrack disconnects', () => {
    const disconnect = vi.fn();
    global.ResizeObserver = class {
      observe() {}
      disconnect = disconnect;
    };

    document.body.innerHTML = '';
    expect(() => trackEditToolbarHeight()).not.toThrow();
    expect(disconnect).not.toHaveBeenCalled();

    buildToolbar(63);
    trackEditToolbarHeight();
    untrackEditToolbarHeight();
    expect(disconnect).toHaveBeenCalled();
  });

  it('CSS offsets the panel by the variable at every breakpoint, with no bare-px guess left', () => {
    const bottoms = [...CSS.matchAll(/#citation-toolbar-results\s*\{[^}]*?\n\s*bottom:\s*([^;]+);/g)]
      .map((m) => m[1].trim());

    // Desktop rule + the max-width: 768px override.
    expect(bottoms.length).toBeGreaterThanOrEqual(2);
    bottoms.forEach((value) => {
      expect(value).toContain(`var(${EDIT_TOOLBAR_HEIGHT_VAR}`);
      // A bare pixel offset is only allowed as the var's fallback.
      expect(value).not.toMatch(/^\d+px$/);
    });
  });
});
