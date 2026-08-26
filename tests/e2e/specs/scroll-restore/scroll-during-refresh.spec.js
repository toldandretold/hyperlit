import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  setupImageBookScenario,
  waitForOverlayHidden,
  waitForNode,
  nodeTop,
  readerScrollTop,
  topVisibleProbe,
  SCROLLER,
} from './scenario.js';
import {
  snapshotForensics,
  attachForensicsOnFailure,
} from '../../helpers/scrollForensics.js';

/**
 * USER SCROLLS DURING THE RESTORE/REFRESH WINDOW — the "if I scroll while JS
 * is figuring out whether to reload, the whole page is fucked" report.
 *
 * The other specs in this folder watch a PASSIVE reader: they return to the
 * book and wait. This one drives real wheel gestures WHILE the two app-owned
 * windows are live:
 *
 *  (A) the timestamp-check refresh window — checkAndUpdateIfNeeded decides the
 *      server is newer and lazyLoader.refresh() tears down every chunk. The
 *      library response is HELD by the route until the gestures are provably
 *      in flight, so the destructive refresh deterministically lands
 *      mid-gesture (no racing the un-awaited boot check).
 *  (B) the image-settle landing window — content visible, images still
 *      pending, scrollHelpers' correction belt armed (isNavigating, up to 8s
 *      of per-image corrections). The reader scrolls away from the restore
 *      anchor, THEN the images decode.
 *
 * Contract for both: the gesture wins. Concretely, the tracked marker never
 * visibly teleports (per-rAF viewport-top delta stays under a perceptibility
 * threshold — legitimate chunk-trim compensation moves scrollTop but NOT the
 * marker's viewport position, so this metric doesn't false-positive on it),
 * and the reader ends AT OR BELOW where their gesture put them — never yanked
 * back up to the stale anchor or the top of the book.
 */

const VISUAL_JUMP_PX = 600; // per-rAF tracked-marker viewport delta = a teleport the eye sees

test.use({ serviceWorkers: 'block' });

const LIBRARY_RE = /\/api\/database-to-indexeddb\/books\/[^/?#]+\/library(\?|#|$)/;

/** Wheel the reader down in small real-gesture steps. */
async function wheelDown(page, { steps, deltaPerStep = 150, intervalMs = 120 }) {
  const box = await page.locator(SCROLLER).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, deltaPerStep);
    await page.waitForTimeout(intervalMs);
  }
  return steps * deltaPerStep;
}

/** Largest PERSISTENT per-sample viewport jump of the tracked marker after t0.
 *  Pairs are consecutive track samples; gaps (marker briefly out of the DOM
 *  during a rebuild) are still compared across — a correct re-land puts the
 *  marker back where it visually was. A jump that REVERTS by the very next
 *  sample is excluded: the sampler and the compensation belt are both rAF
 *  callbacks, so the sampler can observe a decode-grown layout in the same
 *  frame the belt corrects it — before anything paints. Only displacement
 *  that survives into the following sample is something the eye could see. */
function maxTrackJumpAfter(snap, t0) {
  const track = (snap.track || []).filter((s) => s.t >= t0);
  let worst = 0;
  for (let i = 1; i < track.length; i++) {
    const jump = Math.abs(track[i].top - track[i - 1].top);
    if (jump === 0) continue;
    const next = track[i + 1];
    const reverted = next !== undefined && Math.abs(next.top - track[i - 1].top) < jump * 0.2;
    if (!reverted) worst = Math.max(worst, jump);
  }
  return { worst, samples: track.length };
}

test.describe('scroll-restore: real gestures during the restore/refresh windows', () => {
  test.setTimeout(360_000);
  test.afterEach(attachForensicsOnFailure);

  test('(A) gesture during the timestamp-refresh window wins — no teleport, no yank back', async ({ page, spa }) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');

    const { bookId, markerId, throttle } = await setupImageBookScenario(page, spa, {});

    await page.goto(`/${bookId}`, { waitUntil: 'domcontentloaded' });
    await waitForNode(page, markerId);
    await page.waitForTimeout(1200);

    // Hold the library response hostage: fetch + bump the timestamp, but only
    // fulfill once the test releases the gate — pinning the refresh decision
    // INSIDE the gesture burst.
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
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
        await gate;
        return route.fulfill({ response, json }).catch(() => {});
      }
      return route.fulfill({ response }).catch(() => {});
    });

    let gestureStartT;
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForNode(page, markerId);
      await waitForOverlayHidden(page);
      await page.waitForTimeout(800);

      const startTop = await readerScrollTop(page);
      gestureStartT = await page.evaluate(() => performance.now());

      // 3 wheels to provably be mid-gesture, open the gate (the bumped library
      // lands, the refresh cycle starts), keep wheeling through it.
      await wheelDown(page, { steps: 3 });
      releaseGate();
      const gesturePx = 3 * 150 + (await wheelDown(page, { steps: 9 }));

      // Let whatever the refresh does play out fully (including a correctly
      // deferred refresh waiting for scroll-idle).
      await page.waitForTimeout(6000);

      const snap = await snapshotForensics(page);
      const endTop = await readerScrollTop(page);
      const markerTopNow = await nodeTop(page, markerId);
      const { worst, samples } = maxTrackJumpAfter(snap, gestureStartT);

      expect(bumped, 'the armed refresh actually fired').toBeGreaterThan(0);
      expect(markerTopNow, 'marker still in DOM after the mid-gesture refresh').not.toBeNull();
      expect(samples, 'forensics tracked the marker through the storm').toBeGreaterThan(10);
      expect(
        worst,
        `marker visibly teleported ${Math.round(worst)}px in one frame during/after the mid-gesture refresh`
      ).toBeLessThan(VISUAL_JUMP_PX);
      expect(
        endTop,
        `reader yanked back above their gesture (start=${startTop}, wheeled +${gesturePx}, ended=${endTop})`
      ).toBeGreaterThan(startTop + 400);
    } finally {
      releaseGate();
      await throttle.unroute();
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    }
  });

  test('(B) gesture during the image-settle landing window wins — belt/corrections never drag the reader back', async ({ page, spa }) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');

    const { bookId, markerId, throttle } = await setupImageBookScenario(page, spa, {});

    try {
      // Return with every image held: the reader sees content, the correction
      // belt is armed on the pending images.
      await throttle.setMode('hold');
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);
      await page.goto(`/${bookId}`, { waitUntil: 'domcontentloaded' });
      await waitForNode(page, markerId, 60_000);
      await waitForOverlayHidden(page);
      await page.waitForTimeout(500);

      const gestureStartT = await page.evaluate(() => performance.now());

      // Scroll away from the restore anchor by a real gesture...
      const gesturePx = await wheelDown(page, { steps: 6 });
      const topAfterGesture = await readerScrollTop(page);
      // The reading line the gesture established — THIS is what must hold
      // through the decode storm. (Not the tracked marker: after wheeling
      // past it, the marker sits below the fold, and images decoding between
      // the fold and the marker legitimately push it down while the fold
      // stays put — asserting on the marker fails correct behavior.)
      const foldBefore = await topVisibleProbe(page);

      // ...then let every held image decode at once while the landing windows
      // are still open.
      await throttle.release();
      await page.waitForTimeout(3000);

      const endTop = await readerScrollTop(page);
      const markerTopNow = await nodeTop(page, markerId);
      const foldAfter = await topVisibleProbe(page);

      expect(markerTopNow, 'marker still in DOM after the decode storm').not.toBeNull();
      expect(gesturePx, 'gesture actually moved the reader').toBeGreaterThan(0);
      expect(foldBefore, 'fold probe before release').not.toBeNull();
      expect(foldAfter, 'fold probe after release').not.toBeNull();
      // The reading line holds through the storm: same node at the fold,
      // within a visually-quiet offset of where the gesture left it.
      expect(
        foldAfter.id,
        `reading line changed while images settled mid-gesture: ` +
        `"${foldBefore?.id}"@${foldBefore?.topOffset} → "${foldAfter?.id}"@${foldAfter?.topOffset} ` +
        `(scrollTop ${Math.round(topAfterGesture ?? -1)} → ${Math.round(endTop ?? -1)})`
      ).toBe(foldBefore.id);
      expect(
        Math.abs(foldAfter.topOffset - foldBefore.topOffset),
        `reading line slid ${Math.abs(foldAfter.topOffset - foldBefore.topOffset)}px while images settled mid-gesture`
      ).toBeLessThan(200);
      // The corrections may nudge, but must never crawl the reader back toward
      // the stale anchor: they stay at or below where the gesture left them.
      expect(
        endTop,
        `reader dragged back toward the stale anchor (afterGesture=${topAfterGesture}, ended=${endTop})`
      ).toBeGreaterThan(topAfterGesture - 250);
      void gestureStartT;
    } finally {
      await throttle.unroute();
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    }
  });
});
