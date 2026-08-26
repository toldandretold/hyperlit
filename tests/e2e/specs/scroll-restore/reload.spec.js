import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  setupImageBookScenario,
  waitForOverlayHidden,
  waitForNode,
  readerScrollTop,
  nodeTop,
} from './scenario.js';
import {
  snapshotForensics,
  analyzeSettle,
  attachForensicsOnFailure,
} from '../../helpers/scrollForensics.js';
import { emulateSlowNetwork } from '../../helpers/mediaThrottle.js';

/**
 * RELOAD resume — same contract as fresh-resume, but through page.reload():
 *   - images instant (control),
 *   - images held until after the overlay hides (cold-cache phone),
 *   - Slow 3G network emulation + 700ms media delay (first-visit-on-4G case).
 *
 * Browser-native scroll restore cannot help here (html/body never scroll —
 * only .reader-content-wrapper does), so EVERY pixel of the resume travels
 * through the app's restore machinery.
 */

const TOP_TOLERANCE_PX = 170;
const MAX_REVERSALS = 1;
const MAX_SETTLE_MS = 9000;

test.use({ serviceWorkers: 'block' });

test.describe('scroll-restore: reload resume', () => {
  test.setTimeout(300_000);
  test.afterEach(attachForensicsOnFailure);

  async function assertCleanResume(page, { markerId, setupMarkerTop, label }) {
    await waitForNode(page, markerId);
    await waitForOverlayHidden(page);
    return async () => {
      const snapshot = await snapshotForensics(page);
      const analysis = analyzeSettle(snapshot);
      const markerTopNow = await nodeTop(page, markerId);
      const restoredScroll = await readerScrollTop(page);

      expect(markerTopNow, `${label}: marker should exist after reload`).not.toBeNull();
      expect(
        Math.abs(markerTopNow - setupMarkerTop),
        `${label}: marker near setup position (setup=${setupMarkerTop}, now=${markerTopNow}, scrollTop=${restoredScroll})`
      ).toBeLessThan(TOP_TOLERANCE_PX);
      expect(
        analysis.reversals,
        `${label}: post-overlay reversals=${analysis.reversals} (writes=${analysis.writesPostHide}, reasons=${analysis.writeReasonsPostHide.join(',')})`
      ).toBeLessThanOrEqual(MAX_REVERSALS);
      expect(
        analysis.settleMs,
        `${label}: kept moving ${analysis.settleMs}ms after overlay hidden (events: ${analysis.events.join(' ')})`
      ).toBeLessThan(MAX_SETTLE_MS);
    };
  }

  test('reload with instant media resumes without shaking', async ({ page, spa }) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    const { markerId, throttle } = await setupImageBookScenario(page, spa, {});
    const setupMarkerTop = await nodeTop(page, markerId);
    throttle.setMode('instant');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const finish = await assertCleanResume(page, { markerId, setupMarkerTop, label: 'reload-instant' });
    await page.waitForTimeout(2500);
    await finish();
    await throttle.unroute();
  });

  test('reload with media held past the overlay converges on the marker', async ({ page, spa }) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    const { markerId, throttle } = await setupImageBookScenario(page, spa, {});
    const setupMarkerTop = await nodeTop(page, markerId);
    throttle.setMode('hold');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const finish = await assertCleanResume(page, { markerId, setupMarkerTop, label: 'reload-held' });
    await page.waitForTimeout(900);
    throttle.release();
    throttle.setMode('delay', { delayMs: 60 });
    await page.waitForTimeout(2500);
    await finish();
    await throttle.unroute();
  });

  test('reload under Slow 3G emulation converges on the marker', async ({ page, spa, browserName }, testInfo) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    test.skip(browserName !== 'chromium', 'CDP network emulation is Chromium-only');
    test.setTimeout(360_000);

    const { markerId, throttle } = await setupImageBookScenario(page, spa, {});
    const setupMarkerTop = await nodeTop(page, markerId);
    throttle.setMode('delay', { delayMs: 700 });
    await emulateSlowNetwork(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForNode(page, markerId, 120_000);
    await waitForOverlayHidden(page, 120_000);

    // Under global Slow-3G, the DEV harness inflates boot arbitrarily: the
    // marker is visible immediately (server-prerendered resume chunk) but the
    // unbundled vite module graph revalidates over 400kbps, so the app JS —
    // and with it the restore — can run tens of seconds after the overlay
    // hid. That gap is dev-server transfer time, not app behavior (prod
    // bundles collapse it), so this arm asserts the part that IS app
    // behavior: the restore eventually LANDS on the marker and nothing
    // storms after the landing. The landing latency is attached for eyes.
    let landedAt = null;
    const bootT0 = Date.now();
    for (let i = 0; i < 300 && landedAt == null; i++) {
      const top = await readerScrollTop(page);
      if (top != null && top >= 1000) landedAt = Date.now() - bootT0;
      else await page.waitForTimeout(500);
    }
    testInfo.annotations.push({ type: 'slow3g-landing-ms', description: String(landedAt) });
    expect(landedAt, 'restore landed the reader deep in the book (within 150s)').not.toBeNull();

    // Post-landing stillness window: any storm shows up here.
    await page.waitForTimeout(4000);

    const snapshot = await snapshotForensics(page);
    const analysis = analyzeSettle(snapshot);
    const markerTopNow = await nodeTop(page, markerId);
    const restoredScroll = await readerScrollTop(page);

    expect(markerTopNow, 'reload-slow3g: marker should exist after reload').not.toBeNull();
    expect(
      Math.abs(markerTopNow - setupMarkerTop),
      `reload-slow3g: marker near setup position (setup=${setupMarkerTop}, now=${markerTopNow}, scrollTop=${restoredScroll}, landedAt=${landedAt}ms)`
    ).toBeLessThan(TOP_TOLERANCE_PX);
    expect(
      analysis.reversals,
      `reload-slow3g: post-overlay reversals=${analysis.reversals} (writes=${analysis.writesPostHide}, reasons=${analysis.writeReasonsPostHide.join(',')})`
    ).toBeLessThanOrEqual(MAX_REVERSALS);

    await throttle.unroute();
  });
});
