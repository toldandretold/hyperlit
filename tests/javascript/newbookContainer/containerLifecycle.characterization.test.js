/**
 * Characterization tests for NewBookContainerManager (resources/js/components/newbookContainer/index.ts).
 *
 * These pin the CURRENT open/close/positioning behaviour through the public surface so a
 * forthcoming modular refactor can be proven behaviour-preserving. Written to pass against
 * the pre-refactor code; they must stay green through the split.
 *
 * happy-dom notes: CSS transitions never fire, so animation completion is driven manually
 * via either a dispatched `transitionend` event OR the 500ms fallback timeout (fake timers).
 * getBoundingClientRect returns zeros, so the button rect is stubbed. requestAnimationFrame
 * is stubbed to run synchronously for deterministic style assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Isolate the unit from heavy transitive imports of the base ContainerManager / index.
vi.mock('../../../resources/js/app', () => ({ book: {} }));
vi.mock('../../../resources/js/components/cloudRef/editIndicator', () => ({
  isProcessing: () => false,
  isComplete: () => true,
}));
vi.mock('../../../resources/js/SPA/navigation/navigationRegistry', () => ({
  navigate: vi.fn().mockResolvedValue(undefined),
}));

import { NewBookContainerManager } from '../../../resources/js/components/newbookContainer/index';

const BUTTONS_HTML =
  '<button id="createNewBook">New</button><button id="importBook">Import</button>';

function setViewport(width) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

function stubRect(button, { left, right, top = 10, bottom = 40 }) {
  button.getBoundingClientRect = () => ({
    top, bottom, left, right, x: left, y: top, width: right - left, height: bottom - top,
    toJSON() {},
  });
}

function buildDom({ leftAnchored = false } = {}) {
  document.body.innerHTML = '';

  const overlay = document.createElement('div');
  overlay.id = 'source-overlay';
  document.body.appendChild(overlay);

  let parent = document.body;
  if (leftAnchored) {
    const nav = document.createElement('div');
    nav.id = 'logoNavMenu';
    document.body.appendChild(nav);
    parent = nav;
  }

  const button = document.createElement('button');
  button.id = 'newBookButton';
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = '+';
  button.appendChild(icon);
  parent.appendChild(button);

  const container = document.createElement('div');
  container.id = 'newbook-container';
  container.className = 'hidden loading';
  container.innerHTML = BUTTONS_HTML;
  document.body.appendChild(container);

  return { overlay, button, container };
}

function makeManager() {
  return new NewBookContainerManager('newbook-container', 'source-overlay', 'newBookButton', ['main-content']);
}

beforeEach(() => {
  // Synchronous rAF so opacity/positioning writes land before assertions.
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('open (buttons mode)', () => {
  it('desktop, right-anchored: positions below-right of the button and fades in', () => {
    setViewport(1200);
    const { button, container, overlay } = buildDom();
    stubRect(button, { left: 1100, right: 1150 });
    const mgr = makeManager();

    mgr.openContainer();

    expect(mgr.isOpen).toBe(true);
    expect(container.style.display).toBe('block');
    expect(container.style.opacity).toBe('1');
    expect(container.style.width).toBe('160px');
    expect(container.style.top).toBe('48px');       // rect.bottom (40) + 8
    expect(container.style.right).toBe('50px');      // innerWidth (1200) - rect.right (1150)
    expect(container.style.left).toBe('');
    expect(overlay.classList.contains('active')).toBe(true);
    expect(overlay.style.display).toBe('block');
    expect(button.querySelector('.icon').classList.contains('tilted')).toBe(true);
  });

  it('desktop, left-anchored (inside #logoNavMenu): anchors to the button left edge', () => {
    setViewport(1200);
    const { button, container } = buildDom({ leftAnchored: true });
    stubRect(button, { left: 30, right: 80 });
    const mgr = makeManager();

    mgr.openContainer();

    expect(container.style.left).toBe('30px');       // rect.left
    expect(container.style.right).toBe('');
    expect(container.style.top).toBe('48px');
  });
});

describe('close — both completion paths converge to the same end state', () => {
  function assertClosedEndState(container, overlay) {
    expect(container.classList.contains('hidden')).toBe(true);
    expect(container.style.display).toBe('none');
    expect(container.style.left).toBe('');
    expect(container.style.right).toBe('');
    expect(container.style.top).toBe('');
    expect(container.style.transform).toBe('');
    expect(overlay.style.display).toBe('none');
  }

  it('via dispatched transitionend', () => {
    setViewport(1200);
    const { button, container, overlay } = buildDom();
    stubRect(button, { left: 1100, right: 1150 });
    const mgr = makeManager();

    mgr.openContainer();
    mgr.closeContainer();
    expect(mgr.isOpen).toBe(false);

    container.dispatchEvent(new Event('transitionend'));
    assertClosedEndState(container, overlay);
  });

  it('via the 500ms fallback timeout', () => {
    vi.useFakeTimers();
    setViewport(1200);
    const { button, container, overlay } = buildDom();
    stubRect(button, { left: 1100, right: 1150 });
    const mgr = makeManager();

    mgr.openContainer();
    mgr.closeContainer();
    expect(mgr.isOpen).toBe(false);

    vi.runOnlyPendingTimers();
    assertClosedEndState(container, overlay);
  });

  it('a close interrupts an in-flight open animation (overlay-click-mid-open)', () => {
    setViewport(1200);
    const { button, container, overlay } = buildDom();
    stubRect(button, { left: 1100, right: 1150 });
    const mgr = makeManager();

    mgr.openContainer();            // open animation armed (isAnimating, type "open")
    mgr.closeContainer();           // must take over rather than no-op
    expect(mgr.isOpen).toBe(false);

    container.dispatchEvent(new Event('transitionend'));
    expect(container.style.display).toBe('none');
  });
});

describe('open directly in form mode (geometry the refactor must preserve)', () => {
  it('desktop, right-anchored: 400px, below the button, anchored right', () => {
    setViewport(1200);
    const { button, container } = buildDom();
    stubRect(button, { left: 1100, right: 1150 });
    const mgr = makeManager();

    mgr.openContainer('form');

    expect(container.style.width).toBe('400px');
    expect(container.style.height).toBe('80vh');
    expect(container.style.top).toBe('48px');        // rect.bottom (40) + 8
    expect(container.style.padding).toBe('0px');
    expect(container.style.right).toBe('50px');       // innerWidth - rect.right
    expect(container.style.left).toBe('');
    expect(container.style.opacity).toBe('1');
  });

  it('desktop, left-anchored: 400px, docked to viewport top-left', () => {
    setViewport(1200);
    const { button, container } = buildDom({ leftAnchored: true });
    stubRect(button, { left: 30, right: 80 });
    const mgr = makeManager();

    mgr.openContainer('form');

    expect(container.style.width).toBe('400px');
    expect(container.style.top).toBe('50px');
    expect(container.style.left).toBe('50px');
    expect(container.style.right).toBe('');
  });

  it('mobile, left-anchored: full-width sheet', () => {
    setViewport(400);
    const { button, container } = buildDom({ leftAnchored: true });
    stubRect(button, { left: 10, right: 60 });
    const mgr = makeManager();

    mgr.openContainer('form');

    expect(container.style.width).toBe('370px');      // innerWidth (400) - 30
    expect(container.style.maxWidth).toBe('370px');
    expect(container.style.height).toBe('calc(100vh - 100px)');
    expect(container.style.top).toBe('50px');
    expect(container.style.padding).toBe('15px');
    expect(container.style.left).toBe('15px');
  });

  it('mobile, right-anchored: width sized from the button right edge', () => {
    setViewport(400);
    const { button, container } = buildDom();
    stubRect(button, { left: 320, right: 380 });
    const mgr = makeManager();

    mgr.openContainer('form');

    expect(container.style.width).toBe('365px');      // rect.right (380) - 15
    expect(container.style.maxWidth).toBe('365px');
    expect(container.style.height).toBe('calc(100vh - 100px)');
  });
});

describe('form injection / restore', () => {
  it('showImportForm injects #cite-form; restoreOriginalContent reverts to the two buttons', () => {
    vi.useFakeTimers();
    setViewport(1200);
    const meta = document.createElement('meta');
    meta.name = 'csrf-token';
    meta.content = 'test-token';
    document.head.appendChild(meta);
    const { button, container } = buildDom();
    stubRect(button, { left: 1100, right: 1150 });
    const mgr = makeManager();
    // importBookHandler captures originalContent before showing the form — mimic that.
    mgr.originalContent = container.innerHTML;

    mgr.showImportForm();
    vi.runOnlyPendingTimers();                         // url-field + loadFormData timeouts
    expect(container.querySelector('#cite-form')).toBeTruthy();
    expect(container.querySelector('#importBook')).toBeNull();

    mgr.restoreOriginalContent();
    expect(container.querySelector('#cite-form')).toBeNull();
    expect(container.querySelector('#importBook')).toBeTruthy();
    expect(container.querySelector('#createNewBook')).toBeTruthy();
  });
});
