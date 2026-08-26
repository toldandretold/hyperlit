import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  setupImageBookScenario,
  readerScrollTop,
  nodeTop,
} from './scenario.js';
import {
  snapshotForensics,
  analyzeSettle,
  attachForensicsOnFailure,
} from '../../helpers/scrollForensics.js';

/**
 * BFCACHE restore — mobile back/forward when the browser kept the page frozen.
 *
 * Two simulations, because neither alone covers every engine:
 *
 *   A. CDP freeze/thaw (Chromium only): Page.setWebLifecycleState forces the
 *      page through the freeze path (document 'freeze'/'resume' fire). The
 *      contract: the app does NOT re-run any scroll restore on resume — the
 *      browser preserved DOM + wrapper scrollTop verbatim. Zero scroll-writes
 *      after 'resume', marker unmoved.
 *
 *   B. Real traversal: goto('/') then goBack(). If the browser serves the
 *      page from bfcache (pageshow.persisted === true), contract A applies.
 *      If it fell back to a fresh load (persisted false — possible because of
 *      beforeunload/SW/open IDB connections), the fresh-resume contract
 *      applies: marker back within tolerance, bounded shake. Either branch is
 *      a valid outcome; the spec records WHICH ran as a test annotation, so a
 *      suite of "bfcache" greens that never exercised the frozen path is
 *      visible.
 */

const TOP_TOLERANCE_PX = 170;
const BF_EXACT_TOLERANCE_PX = 30; // frozen pages must not move at all

test.use({ serviceWorkers: 'block' });

test.describe('scroll-restore: bfcache', () => {
  test.setTimeout(300_000);
  test.afterEach(attachForensicsOnFailure);

  test('CDP freeze/thaw does not re-run scroll restore', async ({ page, spa, browserName }, testInfo) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    test.skip(browserName !== 'chromium', 'Page.setWebLifecycleState is Chromium-only');

    const { markerId, throttle } = await setupImageBookScenario(page, spa, {});
    const beforeTop = await nodeTop(page, markerId);
    const beforeScroll = await readerScrollTop(page);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    // Probe for a REAL freeze: this CDP call is a silent no-op on some
    // headless builds (probed 2026-08-25 on HeadlessChrome 148 — rAF kept
    // ticking, no freeze event). Skip rather than assert on a thaw that
    // never happened.
    let froze = false;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(150).catch(() => {});
      const got = await page.evaluate(() =>
        (window.__scrollForensics?.events ?? []).some((e) => e.type === 'freeze')
      ).catch(() => false);
      if (got) { froze = true; break; }
    }
    if (!froze) {
      testInfo.annotations.push({ type: 'bfcache-branch', description: 'cdp freeze no-op in this build' });
      await throttle.unroute();
      test.skip(true, 'CDP Page.setWebLifecycleState("frozen") is a no-op in this Chromium build — use the real-traversal arm');
      return;
    }
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.waitForTimeout(1200);

    const snap = await snapshotForensics(page);
    const resumeEvent = snap.events.filter((e) => e.type === 'resume').pop();
    expect(resumeEvent, 'the page resumed (document resume event fired)').toBeTruthy();

    const writesAfterResume = snap.trace.filter(
      (e) => e.kind === 'scroll-write' && e.t > resumeEvent.t
    );
    expect(
      writesAfterResume.length,
      `no scroll-writes may follow a bfcache resume (got ${writesAfterResume.length}: ${writesAfterResume.map((w) => w.reason || w.via).join(', ')})`
    ).toBe(0);

    const afterTop = await nodeTop(page, markerId);
    const afterScroll = await readerScrollTop(page);
    expect(afterTop).not.toBeNull();
    expect(
      Math.abs(afterTop - beforeTop),
      `frozen page must come back pixel-exact (marker ${beforeTop} → ${afterTop}, scrollTop ${beforeScroll} → ${afterScroll})`
    ).toBeLessThan(BF_EXACT_TOLERANCE_PX);
    await throttle.unroute();
  });

  test('real traversal back to the book restores position without shaking', async ({ page, spa }, testInfo) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');

    const { markerId, throttle } = await setupImageBookScenario(page, spa, {});
    const setupMarkerTop = await nodeTop(page, markerId);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // bfcache restores fire pageshow, not load — goBack can look like a
    // navigation that "never finishes loading", so swallow its timeout.
    await page.goBack({ timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const snap = await snapshotForensics(page);
    const analysis = analyzeSettle(snap);
    // The last pageshow with persisted=true marks a genuine bfcache hit.
    const pageShows = snap.events.filter((e) => e.type === 'pageshow');
    const persistedHit = pageShows.some((e) => e.persisted);
    testInfo.annotations.push({ type: 'bfcache-branch', description: persistedHit ? 'frozen (persisted)' : 'fresh load' });

    const markerTopNow = await nodeTop(page, markerId);
    expect(markerTopNow, 'marker back in the DOM').not.toBeNull();

    if (persistedHit) {
      const lastShow = pageShows.filter((e) => e.persisted).pop();
      const writesAfter = snap.trace.filter((e) => e.kind === 'scroll-write' && e.t > lastShow.t);
      expect(
        writesAfter.length,
        `bfcache hit: no scroll-writes after pageshow (got ${writesAfter.map((w) => w.reason || w.via).join(', ')})`
      ).toBe(0);
      expect(
        Math.abs(markerTopNow - setupMarkerTop),
        `bfcache hit: pixel-exact marker (${setupMarkerTop} → ${markerTopNow})`
      ).toBeLessThan(BF_EXACT_TOLERANCE_PX);
    } else {
      expect(
        Math.abs(markerTopNow - setupMarkerTop),
        `fresh-load fallback: marker near setup position (${setupMarkerTop} → ${markerTopNow})`
      ).toBeLessThan(TOP_TOLERANCE_PX);
      expect(
        analysis.reversals,
        `fresh-load fallback: post-overlay reversals=${analysis.reversals}`
      ).toBeLessThanOrEqual(1);
    }

    await throttle.unroute();
  });
});
