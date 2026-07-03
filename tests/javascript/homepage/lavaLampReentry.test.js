/**
 * Regression tests for the lava-lamp background's SPA re-entry ("back button")
 * lifecycle. initLavaLampBackground() keeps a MODULE-SCOPED singleton that
 * outlives SPA `document.body.innerHTML` swaps — but the SVG it drew does NOT.
 *
 * The bug this locks in: init used to be `if (instance) return`, a hard no-op.
 * So when a swap wiped #lava-lamp-mount and handed back a fresh empty one, the
 * surviving-but-stale instance blocked re-init and the background rendered as
 * blank HTML ("cooked when returning"). init is now self-healing: a stale
 * instance (root detached from the live mount) is destroyed and rebuilt.
 *
 * Backs the e2e coverage in tests/e2e/helpers/pageVerifiers.js (rAF-alive lava
 * check at every SPA home landing, incl. back/forward replay).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initLavaLampBackground,
  destroyLavaLampBackground,
} from '../../../resources/js/components/homepage/lavaLampBackground';

function addMount() {
  const mount = document.createElement('div');
  mount.id = 'lava-lamp-mount';
  document.body.appendChild(mount);
  return mount;
}

/** The rendered SVG paths inside a mount (the "alive" signal). */
function lavaPaths(mount) {
  return mount.querySelectorAll('.lava-lamp-bg svg path');
}

describe('lava-lamp background — SPA re-entry lifecycle', () => {
  beforeEach(() => {
    // Deterministic: no prefers-reduced-motion, and no live rAF loop — the SVG
    // is drawn synchronously by the constructor's renderFull(), so we don't need
    // frames to fire, and a real loop would just churn in the test runner.
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    // Reset the module singleton so each test starts clean.
    destroyLavaLampBackground();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('no-ops when there is no mount (inert off the homepage)', () => {
    expect(() => initLavaLampBackground()).not.toThrow();
    expect(document.querySelector('.lava-lamp-bg')).toBeNull();
  });

  it('fresh init renders the SVG into the mount', () => {
    const mount = addMount();
    initLavaLampBackground();
    expect(mount.querySelector('.lava-lamp-bg')).not.toBeNull();
    expect(lavaPaths(mount).length).toBeGreaterThan(0);
  });

  it('re-entry after the mount is swapped out self-heals (the regression)', () => {
    const first = addMount();
    initLavaLampBackground();
    expect(lavaPaths(first).length).toBeGreaterThan(0);

    // Simulate an SPA body swap: the old mount (with our SVG) is discarded and a
    // brand-new empty #lava-lamp-mount takes its place — WITHOUT destroy running.
    first.remove();
    const second = addMount();
    expect(lavaPaths(second).length).toBe(0);

    // init must NOT no-op on the stale singleton — it must repopulate the new mount.
    initLavaLampBackground();
    expect(lavaPaths(second).length).toBeGreaterThan(0);
  });

  it('is a genuine no-op while the instance is still attached (no duplicate SVGs)', () => {
    const mount = addMount();
    initLavaLampBackground();
    initLavaLampBackground();
    expect(mount.querySelectorAll('.lava-lamp-bg').length).toBe(1);
  });

  it('destroy removes the SVG, and a subsequent init re-renders it', () => {
    const mount = addMount();
    initLavaLampBackground();
    expect(mount.querySelector('.lava-lamp-bg')).not.toBeNull();

    destroyLavaLampBackground();
    expect(mount.querySelector('.lava-lamp-bg')).toBeNull();

    initLavaLampBackground();
    expect(lavaPaths(mount).length).toBeGreaterThan(0);
  });
});
