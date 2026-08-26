import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  setupImageBookScenario,
  waitForOverlayHidden,
  waitForNode,
  nodeTop,
} from './scenario.js';
import {
  snapshotForensics,
  analyzeSettle,
  attachForensicsOnFailure,
} from '../../helpers/scrollForensics.js';

/**
 * REFRESH STORM — audit hypothesis: the phone that "looks fine, then shakes".
 *
 * loadHyperText calls checkAndUpdateIfNeeded UN-AWAITED; when the server's
 * library timestamp is newer than IndexedDB's, lazyLoader.refresh() runs
 * SECONDS after the restore settled: it wipes every rendered chunk, rebuilds,
 * scrolls again, focuses the target and places a caret. To a reader that's a
 * page that was fine and then jumps.
 *
 * This spec makes the "server is newer" condition DETERMINISTIC: it routes
 * /api/database-to-indexeddb/books/{id}/library and bumps `timestamp` on the
 * real response, so every reload triggers the refresh path. Contract: at most
 * ONE positioning episode after the overlay hides — i.e. either the refresh
 * results are folded into the pre-hide restore, or the deferred refresh does
 * not visibly re-scroll at all.
 *
 * If this fails today, it is the reproduction for the un-awaited refresh()
 * hypothesis; the fix is to gate refresh behind "user hasn't seen content
 * yet" or make it non-destructive around a settled position.
 */

const TOP_TOLERANCE_PX = 170;

test.use({ serviceWorkers: 'block' });

const LIBRARY_RE = /\/api\/database-to-indexeddb\/books\/[^/?#]+\/library(\?|#|$)/;

test.describe('scroll-restore: refresh storm (server newer than IndexedDB)', () => {
  test.setTimeout(360_000);
  test.afterEach(attachForensicsOnFailure);

  test('reload that triggers lazyLoader.refresh() must not visibly re-scroll after settling', async ({ page, spa }) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');

    const { bookId, markerId, throttle } = await setupImageBookScenario(page, spa, {});
    const setupMarkerTop = await nodeTop(page, markerId);

    // Normalize onto the plain reader URL first (imports can land on /edit):
    // the refresh lifecycle under test is the reader's.
    await page.goto(`/${bookId}`, { waitUntil: 'domcontentloaded' });
    await waitForNode(page, markerId);
    await page.waitForTimeout(1200);

    let bumped = 0;
    await page.route(LIBRARY_RE, async (route) => {
      let response;
      try {
        response = await route.fetch();
      } catch {
        return route.abort().catch(() => {});
      }
      let json = null;
      try { json = await response.json(); } catch { /* not json */ }
      if (json?.library) {
        json.library.timestamp = (Number(json.library.timestamp) || 0) + 1_000_000_000_000;
        bumped++;
        return route.fulfill({ response, json }).catch(() => {});
      }
      return route.fulfill({ response }).catch(() => {});
    });

    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForNode(page, markerId);
      await waitForOverlayHidden(page);

      // checkAndUpdateIfNeeded fires some time into the boot (it is
      // un-awaited); wait for the armed endpoint to actually be hit, then let
      // the refresh lifecycle play out before judging the aftermath.
      await expect
        .poll(() => bumped, { timeout: 20_000 })
        .toBeGreaterThan(0);
      await page.waitForTimeout(3500);
    } finally {
      await throttle.unroute();
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    }

    const snap = await snapshotForensics(page);
    const analysis = analyzeSettle(snap);
    const markerTopNow = await nodeTop(page, markerId);

    expect(markerTopNow, 'marker still in DOM after any refresh').not.toBeNull();
    expect(
      Math.abs(markerTopNow - setupMarkerTop),
      `marker near setup position after refresh cycle (setup=${setupMarkerTop}, now=${markerTopNow})`
    ).toBeLessThan(TOP_TOLERANCE_PX);

    // The refresh's own latency is fine (timestamp polling is slow); what must
    // not happen is content MOVING after refresh's landing: count sample
    // changes within 1.5s of the LAST post-hide write as "converged", anything
    // later is storm residue.
    const writes = (snap.trace || []).filter((e) => e.kind === 'scroll-write' && e.t >= (analysis.overlayHiddenAt ?? 0));
    const lastWriteT = writes.length ? writes[writes.length - 1].t : null;
    const lateMoves = lastWriteT == null
      ? []
      : (snap.samples || []).filter((s, i, arr) => i > 0 && s.t > lastWriteT + 250 && s.top !== arr[i - 1].top);
    expect(
      analysis.reversals,
      `post-overlay reversals=${analysis.reversals} (writes=${analysis.writesPostHide}, reasons=${analysis.writeReasonsPostHide.join(',')})`
    ).toBeLessThanOrEqual(1);
    expect(
      lateMoves.length,
      `position moved ${lateMoves.length}× AFTER the refresh's landing write at ${lastWriteT && Math.round(lastWriteT)}ms (storm residue)`
    ).toBe(0);
  });
});
