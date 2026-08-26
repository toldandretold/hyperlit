import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  setupImageBookScenario,
  coldLoadBook,
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

/**
 * FRESH-LOAD RESUME — the phone-browser "come back to the book later" case.
 *
 * A saved deep position exists (sessionStorage/localStorage, seeded server
 * bookmark); the document loads from scratch. Contract, per arm:
 *   1. the marker paragraph lands where it was when the position was saved
 *      (marker top within tolerance of its setup-time viewport position),
 *   2. the convergence happens with bounded evidence of a fight: after the
 *      boot overlay hides, the wrapper's position may still settle (images
 *      decoding late legitimately correct downward) but must not OSCILLATE
 *      (reversals) and must converge promptly.
 *
 * Arms:
 *   - text-only        control: no images at all.
 *   - images instant   media served immediately (but no-store).
 *   - images held      media hangs until after the overlay hides + 900ms —
 *                      the cold-cache phone case: restore scrolls against a
 *                      zero-height-image layout, then every image above the
 *                      target decodes and the correction belt fires.
 *
 * Forensics artifact on failure: scroll-forensics.json (samples + app trace).
 */

const TOP_TOLERANCE_PX = 170; // header band (192) ± slack
const MAX_REVERSALS = 1;
const MAX_SETTLE_MS = 9000;

test.use({ serviceWorkers: 'block' });

test.describe('scroll-restore: fresh-load resume', () => {
  test.setTimeout(300_000);
  test.afterEach(attachForensicsOnFailure);

  async function runArm(page, spa, { imageMode, holdDuringBoot }) {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');

    const { bookId, markerId, throttle } = await setupImageBookScenario(page, spa, { imageMode });
    const setupMarkerTop = await nodeTop(page, markerId);

    if (holdDuringBoot) throttle.setMode('hold');
    else throttle.setMode('instant');

    await coldLoadBook(page, bookId);
    await waitForNode(page, markerId);
    await waitForOverlayHidden(page);

    if (holdDuringBoot) {
      // Restore has now run against the un-laid-out images. Let the user see
      // that state briefly, then simulate the network finally delivering.
      await page.waitForTimeout(900);
      throttle.release();
      throttle.setMode('delay', { delayMs: 60 });
    }

    await page.waitForTimeout(2500); // allow the correction belt / decode to converge

    const snapshot = await snapshotForensics(page);
    const analysis = analyzeSettle(snapshot);

    const markerTopNow = await nodeTop(page, markerId);
    const restoredScroll = await readerScrollTop(page);
    await throttle.unroute();

    expect(markerTopNow, 'marker node should exist after resume').not.toBeNull();
    expect(
      Math.abs(markerTopNow - setupMarkerTop),
      `marker should land near its setup position (setup=${setupMarkerTop}, now=${markerTopNow}, scrollTop=${restoredScroll})`
    ).toBeLessThan(TOP_TOLERANCE_PX);

    expect(
      analysis.reversals,
      `post-overlay scroll direction reversals=${analysis.reversals} (writes=${analysis.writesPostHide}, reasons=${analysis.writeReasonsPostHide.join(',')})`
    ).toBeLessThanOrEqual(MAX_REVERSALS);
    expect(
      analysis.settleMs,
      `position kept moving ${analysis.settleMs}ms after the overlay hid (events: ${analysis.events.join(' ')})`
    ).toBeLessThan(MAX_SETTLE_MS);
  }

  test('text-only book resumes without shaking', async ({ page, spa }) => {
    await runArm(page, spa, { imageMode: 'none', holdDuringBoot: false });
  });

  test('image book with instant media resumes without shaking', async ({ page, spa }) => {
    await runArm(page, spa, { imageMode: 'remote', holdDuringBoot: false });
  });

  test('image book with media held past first paint converges on the marker', async ({ page, spa }) => {
    await runArm(page, spa, { imageMode: 'remote', holdDuringBoot: true });
  });
});
