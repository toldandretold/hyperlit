/**
 * Regression: destroySourceButtonListener MUST clear #source-overlay.active on teardown.
 *
 * #source-overlay is a full-viewport position:fixed, pointer-events:auto layer in the persistent
 * reader shell. If it keeps `.active` after the source container is torn down, it silently eats
 * every scroll gesture and the page appears frozen. This bit on browser BACK after navigating away
 * via the in-container "See Review" link (window.location.href → full load → bfcache restore →
 * pageshow/persisted → buttonRegistry.reinitializeAll → destroyAll → destroySourceButtonListener).
 * The old teardown hand-toggled container classes but never touched the overlay; the fix routes it
 * through the shared updateState() which clears the overlay + unfreezes.
 *
 * sourceManager is mocked with a faithful updateState() mirroring ContainerManager.updateState()
 * (containerManager.ts:283-293) so this asserts cloudRefButton actually invokes the clearing path,
 * without dragging in the manager's heavy dependency graph.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { init: vi.fn() },
}));

vi.mock('../../../resources/js/components/sourceContainer/index', () => {
  const mgr = {
    isOpen: false,
    isInEditMode: false,
    isAnimating: false,
    frozenElements: [],
    stopAiReviewPolling: vi.fn(),
    rebindElements: vi.fn(),
    get container() { return document.getElementById('source-container'); },
    get overlay() { return document.getElementById('source-overlay'); },
    get button() { return document.getElementById('cloudRef'); },
    // Faithful mirror of ContainerManager.updateState() (isOpen=false branch).
    updateState() {
      const c = this.container;
      const o = this.overlay;
      if (this.isOpen) {
        c?.classList.add('open');
        o?.classList.add('active');
      } else {
        c?.classList.remove('open');
        o?.classList.remove('active');
      }
    },
  };
  return { default: mgr };
});

import sourceManager from '../../../resources/js/components/sourceContainer/index';
import { destroySourceButtonListener } from '../../../resources/js/components/cloudRef/cloudRefButton';

beforeEach(() => {
  document.body.innerHTML = `
    <div id="source-container" class="open"></div>
    <div id="source-overlay" class="active"></div>
    <button id="cloudRef"></button>`;
  sourceManager.isOpen = true;
  sourceManager.isInEditMode = true;
  sourceManager.isAnimating = true;
  window.activeContainer = 'source-container';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('destroySourceButtonListener', () => {
  it('clears #source-overlay.active (the scroll-blocking layer) on teardown', () => {
    expect(document.getElementById('source-overlay').classList.contains('active')).toBe(true);

    destroySourceButtonListener();

    const overlay = document.getElementById('source-overlay');
    const container = document.getElementById('source-container');
    expect(overlay.classList.contains('active')).toBe(false); // the load-bearing assertion
    expect(container.classList.contains('open')).toBe(false);
    expect(container.classList.contains('hidden')).toBe(true);
    expect(sourceManager.isOpen).toBe(false);
    expect(sourceManager.isInEditMode).toBe(false);
    expect(window.activeContainer).toBe('main-content');
  });

  it('is a no-op on the overlay when the container was already closed', () => {
    // Normal browsing: the container is dismissed (isOpen=false) before nav, so there is
    // nothing to clear. A clean overlay must stay clean.
    sourceManager.isOpen = false;
    document.getElementById('source-container').classList.remove('open');
    document.getElementById('source-overlay').classList.remove('active');

    destroySourceButtonListener();

    expect(document.getElementById('source-overlay').classList.contains('active')).toBe(false);
  });
});
