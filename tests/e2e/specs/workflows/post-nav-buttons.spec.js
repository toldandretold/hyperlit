/**
 * Post-SPA-nav button health — focused repro for the three elements that
 * intermittently stop working after navigation:
 *
 *   1. Preview / .book-actions floating menu (home & user pages).
 *   2. The hyperlit-container resize edge (reader).
 *   3. The window drag-and-drop file overlay (home & user).
 *
 * This is the fast, targeted companion to the full SPA grand tour: each test
 * drives the relevant probe directly across a small, deliberately-chosen
 * sequence of SPA transitions (forward nav, round trips, bfcache back) so a
 * failure pins the cause quickly. The probes themselves throw with diagnostic
 * snapshots — see helpers/elementProbes.js.
 *
 * Run:
 *   E2E_SLOWMO=600 npm run test:e2e:headed -- tests/e2e/specs/workflows/post-nav-buttons.spec.js
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  probeBookActionsMenu,
  probeResizeHandle,
  probeDropListenerBalance,
} from '../../helpers/elementProbes.js';

const READER_BOOK = process.env.E2E_READER_BOOK;

test.describe.serial('Post-SPA-nav button health', () => {
  /* ── 1. Preview menu across user ↔ home round trips ─────────────────────── */
  test('preview menu survives user ↔ home nav (stale isUserPage repro)', async ({ page, spa }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    // Baseline: full preview flow on a fresh home load.
    await probeBookActionsMenu(page, spa, { expectPage: 'home', clickPreview: true });

    // Two round trips — the stale-flag leak tends to surface after the first
    // user→home, but we loop to be sure it's not order-dependent.
    for (let i = 0; i < 2; i++) {
      await spa.navigateToUserPage(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('user');
      await probeBookActionsMenu(page, spa, { expectPage: 'user', clickPreview: true });

      await spa.navigateToHome(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('home');
      // The money shot: if window.isUserPage leaked from the user page, this
      // throws "window.isUserPage is TRUE on a home page".
      await probeBookActionsMenu(page, spa, { expectPage: 'home', clickPreview: true });
    }

    // bfcache back-button — the pathway most likely to skip initializeToStructure
    // and therefore the flag reset.
    await page.goBack();
    await spa.waitForTransition(page);
    const backStructure = await spa.getStructure(page);
    await probeBookActionsMenu(page, spa, { expectPage: backStructure, clickPreview: false });
  });

  /* ── 2. Resize edge across reader re-entry ──────────────────────────────── */
  test('resize edge survives reader → away → reader nav', async ({ page, spa }) => {
    test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in .env.e2e');

    // Full load of a content-rich book — baseline resize must work.
    await page.goto(`/${READER_BOOK}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');
    const baseline = await probeResizeHandle(page, spa, { require: true });
    expect(baseline.skipped).toBeFalsy();

    // SPA away to home, then SPA back to the SAME book via its library card —
    // this keeps the persistent containerDragger singleton alive across the
    // round trip (a full reload would recreate it and mask the bug). We drive
    // the home nav with a JS click: after opening/closing a container the logo
    // nav button can fail Playwright's strict pointer-interception check, and
    // the app itself navigates this way (see setupTourAnchor).
    await page.evaluate(() => document.getElementById('homeButtonNav')?.click());
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('home');

    const card = page.locator(`.libraryCard a[href$="${READER_BOOK}"]`).first();
    if (!(await card.count())) {
      test.info().annotations.push({
        type: 'note',
        description: `No library card linking to ${READER_BOOK} on the home page — cannot SPA back to it; skipping the round-trip resize check.`,
      });
      return;
    }
    await card.click();
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');

    // Post-SPA-nav: resize must still engage and leave no stuck `.resizing`.
    const afterNav = await probeResizeHandle(page, spa, { require: true });
    expect(afterNav.skipped).toBeFalsy();
  });

  /* ── 3. Drop listeners don't leak across navs ───────────────────────────── */
  test('drag-drop listeners stay balanced across home ↔ user navs', async ({ page, spa }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    const readDrop = async () => {
      const snap = await spa.getListenerSnapshot(page);
      const overlayCount = await page.evaluate(
        () => document.querySelectorAll('#page-drop-overlay').length
      );
      return { drop: snap['window::drop'] || 0, overlayCount };
    };

    await probeDropListenerBalance(page);
    const baseline = await readDrop();

    // Three round trips; the double-bind leak shows up as a slowly-growing
    // window::drop count and/or extra #page-drop-overlay elements.
    for (let i = 0; i < 3; i++) {
      await spa.navigateToUserPage(page);
      await spa.waitForTransition(page);
      await probeDropListenerBalance(page);

      await spa.navigateToHome(page);
      await spa.waitForTransition(page);
      await probeDropListenerBalance(page);
    }

    const after = await readDrop();
    expect(after.overlayCount, 'page-drop-overlay leaked across navs').toBe(1);
    // Allow no growth in the net window::drop listener count. If destroy/init
    // are balanced this is stable; growth means listeners are accumulating.
    expect(
      after.drop,
      `window::drop listeners grew from ${baseline.drop} to ${after.drop} across 3 round trips (leak)`
    ).toBeLessThanOrEqual(baseline.drop);
  });
});
