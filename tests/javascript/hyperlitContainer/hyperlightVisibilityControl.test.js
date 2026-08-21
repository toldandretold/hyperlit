/**
 * Per-highlight visibility control (hyperlitContainer/hyperlightVisibilityControl.ts):
 * the pure HTML builder, the document-delegated singleton lifecycle (create-once init,
 * destroy, stale-state clearing), panel open/close via delegation, and the happy-path
 * flip (endpoint POST → data-state repaint → sticky default stored).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/indexedDB/index', () => {
  const fakeReq = () => {
    const r = {};
    setTimeout(() => { r.result = undefined; r.onsuccess && r.onsuccess(); }, 0);
    return r;
  };
  return {
    openDatabase: vi.fn().mockResolvedValue({
      transaction: () => {
        const tx = { objectStore: () => ({ get: fakeReq, put: vi.fn() }) };
        setTimeout(() => { tx.oncomplete && tx.oncomplete(); }, 1);
        return tx;
      },
    }),
  };
});
vi.mock('../../../resources/js/utilities/modalFocusTrap', () => ({
  trapModalFocus: vi.fn(() => vi.fn()),
}));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  alertDialog: vi.fn().mockResolvedValue(undefined),
  confirmDialog: vi.fn().mockResolvedValue(true),
}));

import {
  buildHyperlightVisibilityControlHtml,
  initHyperlightVisibility,
  destroyHyperlightVisibility,
} from '../../../resources/js/hyperlitContainer/hyperlightVisibilityControl';

const flush = () => new Promise((r) => setTimeout(r, 5));

function mountContainer(state = 'public') {
  const host = document.createElement('div');
  host.id = 'hyperlit-container';
  host.innerHTML = buildHyperlightVisibilityControlHtml('HL_test1', 'book_1', state);
  document.body.appendChild(host);
  return host.querySelector('.hl-visibility-control');
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

afterEach(() => {
  destroyHyperlightVisibility();
  vi.restoreAllMocks();
});

describe('buildHyperlightVisibilityControlHtml', () => {
  it('emits a class-addressed control with instance data attrs and two options', () => {
    const control = mountContainer('public');
    expect(control).not.toBeNull();
    expect(control.id).toBe(''); // per-instance: never the source container's singleton id
    expect(control.dataset.state).toBe('public');
    expect(control.dataset.highlightId).toBe('HL_test1');
    expect(control.dataset.book).toBe('book_1');

    const options = [...control.querySelectorAll('.visibility-option')].map((o) => o.dataset.target);
    expect(options).toEqual(['public', 'private']); // Encrypt deliberately absent (root-book-only)

    expect(control.querySelector('.visibility-option[data-target="public"]').classList.contains('active')).toBe(true);
    expect(control.querySelector('.visibility-option[data-target="private"]').classList.contains('active')).toBe(false);
    expect(control.querySelector('.visibility-trigger').getAttribute('aria-expanded')).toBe('false');
  });

  it('marks the private option active for a private highlight', () => {
    const control = mountContainer('private');
    expect(control.dataset.state).toBe('private');
    expect(control.querySelector('.visibility-option[data-target="private"]').classList.contains('active')).toBe(true);
  });
});

describe('delegated open/close lifecycle', () => {
  it('opens the panel on trigger click and closes on outside click', () => {
    const control = mountContainer();
    initHyperlightVisibility();

    control.querySelector('.visibility-trigger').click();
    expect(control.classList.contains('vis-open')).toBe(true);
    expect(control.querySelector('.visibility-panel').style.display).toBe('block');
    expect(control.querySelector('.visibility-trigger').getAttribute('aria-expanded')).toBe('true');
    // Click-catcher appended to the container (shared .visibility-overlay class)
    expect(document.querySelector('#hyperlit-container > .visibility-overlay')).not.toBeNull();

    document.body.click();
    expect(control.classList.contains('vis-open')).toBe(false);
    expect(document.querySelector('#hyperlit-container > .visibility-overlay')).toBeNull();
  });

  it('init is create-once and clears stale open-panel state on re-entry', () => {
    const control = mountContainer();
    initHyperlightVisibility();
    control.querySelector('.visibility-trigger').click();
    expect(control.classList.contains('vis-open')).toBe(true);

    // SPA re-entry: re-init must close the stale panel, and a single click must
    // still toggle exactly once (no duplicate document listeners).
    initHyperlightVisibility();
    expect(control.classList.contains('vis-open')).toBe(false);
    control.querySelector('.visibility-trigger').click();
    expect(control.classList.contains('vis-open')).toBe(true);
  });

  it('destroy removes the delegated listener', () => {
    const control = mountContainer();
    initHyperlightVisibility();
    destroyHyperlightVisibility();
    control.querySelector('.visibility-trigger').click();
    expect(control.classList.contains('vis-open')).toBe(false);
  });

  it('in a STACKED layer the overlay is appended to that layer, not the base container', () => {
    // A highlight-in-a-highlight renders in .hyperlit-container-stacked — the
    // click-catcher must cover the layer the control lives in (regression: it
    // was hardcoded to #hyperlit-container by id).
    const base = document.createElement('div');
    base.id = 'hyperlit-container';
    document.body.appendChild(base);
    const stacked = document.createElement('div');
    stacked.className = 'hyperlit-container-stacked';
    stacked.innerHTML = buildHyperlightVisibilityControlHtml('HL_nested1', 'book_1/HL_parent', 'public');
    document.body.appendChild(stacked);
    initHyperlightVisibility();

    stacked.querySelector('.visibility-trigger').click();
    expect(stacked.querySelector(':scope > .visibility-overlay')).not.toBeNull();
    expect(base.querySelector(':scope > .visibility-overlay')).toBeNull();

    document.body.click();
    expect(stacked.querySelector(':scope > .visibility-overlay')).toBeNull();
  });
});

describe('applying a flip', () => {
  it('same-state option click just closes the panel without a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const control = mountContainer('public');
    initHyperlightVisibility();
    control.querySelector('.visibility-trigger').click();

    control.querySelector('.visibility-option[data-target="public"]').click();
    await flush();
    expect(control.classList.contains('vis-open')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flip to private POSTs the endpoint, repaints state, and stores the sticky default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, subBookId: 'book_1/HL_test1', visibility: 'private' }), { status: 200 }),
    );
    const control = mountContainer('public');
    initHyperlightVisibility();
    control.querySelector('.visibility-trigger').click();

    control.querySelector('.visibility-option[data-target="private"]').click();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/db/sub-books/visibility');
    expect(JSON.parse(opts.body)).toEqual({ parentBook: 'book_1', itemId: 'HL_test1', visibility: 'private' });

    expect(control.dataset.state).toBe('private');
    expect(control.querySelector('.visibility-option[data-target="private"]').classList.contains('active')).toBe(true);
    expect(control.classList.contains('vis-open')).toBe(false);
    expect(localStorage.getItem('hyperlit_default_hl_visibility')).toBe('private');
  });

  it('a failed POST restores state and does not store a sticky default', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }));
    const control = mountContainer('public');
    initHyperlightVisibility();
    control.querySelector('.visibility-trigger').click();

    control.querySelector('.visibility-option[data-target="private"]').click();
    await flush();

    expect(control.dataset.state).toBe('public');
    expect(localStorage.getItem('hyperlit_default_hl_visibility')).toBeNull();
  });
});

describe('panel edge flip', () => {
  /**
   * happy-dom does no layout, so model the two CSS anchorings by hand: unflipped the
   * panel's LEFT edge sits at the control's left (`left: 0`); flipped, its RIGHT edge
   * sits at the control's right (`right: 0`).
   */
  function stubRects(control, { hostLeft, hostRight, ctrlLeft, ctrlRight, panelWidth = 170 }) {
    const host = document.getElementById('hyperlit-container');
    const panel = control.querySelector('.visibility-panel');
    host.getBoundingClientRect = () => ({
      left: hostLeft, right: hostRight, top: 0, bottom: 400,
      width: hostRight - hostLeft, height: 400,
    });
    panel.getBoundingClientRect = () => {
      const left = control.classList.contains('vis-flip-left') ? ctrlRight - panelWidth : ctrlLeft;
      return { left, right: left + panelWidth, top: 0, bottom: 80, width: panelWidth, height: 80 };
    };
  }

  it('flips left when the default rightward drop would spill past the clip edge', () => {
    const control = mountContainer();
    // Phone-ish: 300px-wide container, control sitting two thirds along the author row.
    stubRects(control, { hostLeft: 0, hostRight: 300, ctrlLeft: 200, ctrlRight: 230 });
    initHyperlightVisibility();

    control.querySelector('.visibility-trigger').click();
    // Unflipped the panel would end at 370, well past the 300 clip edge — labels cut off.
    expect(control.classList.contains('vis-flip-left')).toBe(true);
  });

  it('leaves the panel left-aligned when it already fits', () => {
    const control = mountContainer();
    stubRects(control, { hostLeft: 0, hostRight: 300, ctrlLeft: 10, ctrlRight: 40 });
    initHyperlightVisibility();

    control.querySelector('.visibility-trigger').click();
    expect(control.classList.contains('vis-flip-left')).toBe(false);
  });

  it('does not flip when flipping would only overflow the OTHER edge', () => {
    const control = mountContainer();
    // Container narrower than the panel: it overflows either way, so keep the default
    // anchoring, which at least keeps the meaning-bearing icons on screen.
    stubRects(control, { hostLeft: 0, hostRight: 150, ctrlLeft: 100, ctrlRight: 130 });
    initHyperlightVisibility();

    control.querySelector('.visibility-trigger').click();
    expect(control.classList.contains('vis-flip-left')).toBe(false);
  });

  it('clears the flip on close so a reopen re-measures from scratch', () => {
    const control = mountContainer();
    stubRects(control, { hostLeft: 0, hostRight: 300, ctrlLeft: 200, ctrlRight: 230 });
    initHyperlightVisibility();

    control.querySelector('.visibility-trigger').click();
    expect(control.classList.contains('vis-flip-left')).toBe(true);

    document.body.click();
    expect(control.classList.contains('vis-flip-left')).toBe(false);
  });
});
