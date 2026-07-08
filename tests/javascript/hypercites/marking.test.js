/**
 * Regression test for resources/js/hypercites/marking.ts
 *
 * Bug it locks down: pasting a cross-book citation promotes the SOURCE hypercite
 * single→couple in storage, but the SAME tab never refreshed the on-screen source
 * marking (the broadcast self-skips and only re-renders the CURRENT book; the paste
 * handler's old bare `element.className = newStatus` left the marker dim — missing
 * the --hypercite-intensity var a real render sets — and unclickable, since the
 * couple/poly click listener was never (re)attached). marking.restampHyperciteStatusInDOM
 * does the full render-equivalent re-stamp; these tests pin that contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the listeners leaf so we don't pull the whole hypercite/container graph
// into the test, and so we can assert the couple/poly listener is (re)attached.
// vi.hoisted: the mock factory is hoisted above imports, so the spy must be too.
const { attachUnderlineClickListeners } = vi.hoisted(() => ({
  attachUnderlineClickListeners: vi.fn(),
}));
vi.mock('../../../resources/js/hypercites/listeners', () => ({
  attachUnderlineClickListeners,
}));

import { restampHyperciteStatusInDOM } from '../../../resources/js/hypercites/marking';

beforeEach(() => {
  document.body.innerHTML = '';
  attachUnderlineClickListeners.mockClear();
});

function makeSourceMarker(id, cls = 'single') {
  const u = document.createElement('u');
  u.id = id;
  u.className = cls;
  u.textContent = 'cited source text';
  document.body.appendChild(u);
  return u;
}

describe('restampHyperciteStatusInDOM', () => {
  it('promotes single → couple: class, intensity var, and listener re-attached', () => {
    const u = makeSourceMarker('hypercite_16kuh38', 'single');

    const n = restampHyperciteStatusInDOM('hypercite_16kuh38', 'couple');

    expect(n).toBe(1);
    expect(u.className).toBe('couple');
    // couple/poly must carry the inline intensity var a fresh render sets —
    // a bare className flip left this empty, so the source stayed visually dim.
    expect(u.style.getPropertyValue('--hypercite-intensity')).toBe('0.3');
    // the click-to-navigate handler only lives on couple/poly markers, so a
    // freshly-promoted couple must have listeners (re)attached.
    expect(attachUnderlineClickListeners).toHaveBeenCalledTimes(1);
  });

  it('clears the intensity var when demoting back to single', () => {
    const u = makeSourceMarker('hypercite_x', 'couple');
    u.style.setProperty('--hypercite-intensity', '0.3');

    restampHyperciteStatusInDOM('hypercite_x', 'single');

    expect(u.className).toBe('single');
    expect(u.style.getPropertyValue('--hypercite-intensity')).toBe('');
  });

  it('updates EVERY rendered instance (e.g. source panel + sub-book container)', () => {
    const a = makeSourceMarker('hypercite_dup', 'single');
    const b = makeSourceMarker('hypercite_dup', 'single');

    const n = restampHyperciteStatusInDOM('hypercite_dup', 'poly');

    expect(n).toBe(2);
    expect(a.className).toBe('poly');
    expect(b.className).toBe('poly');
  });

  it('is a safe no-op when the source marker is not in the DOM (navigate-away case)', () => {
    const n = restampHyperciteStatusInDOM('hypercite_absent', 'couple');
    expect(n).toBe(0);
    expect(attachUnderlineClickListeners).not.toHaveBeenCalled();
  });

  it('never touches the citing <a class="open-icon"> arrow that shares no id/tag', () => {
    const arrow = document.createElement('a');
    arrow.id = 'hypercite_arrow';
    arrow.className = 'open-icon';
    arrow.textContent = '↗';
    document.body.appendChild(arrow);

    const n = restampHyperciteStatusInDOM('hypercite_arrow', 'couple');

    // matches only <u> markers — the arrow anchor is left untouched
    expect(n).toBe(0);
    expect(arrow.className).toBe('open-icon');
  });

  it('ignores empty/missing arguments', () => {
    makeSourceMarker('hypercite_y', 'single');
    expect(restampHyperciteStatusInDOM('', 'couple')).toBe(0);
    expect(restampHyperciteStatusInDOM('hypercite_y', '')).toBe(0);
  });
});
