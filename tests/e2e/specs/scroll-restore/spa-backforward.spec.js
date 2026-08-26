import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  setupImageBookScenario,
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
 * SPA back/forward — in-app navigation home and back, repeatedly.
 *
 * popstate → LinkNavigationHandler → BookToBookTransition → full init path:
 * restore.ts resume, container-stack restore candidates, paginator
 * re-engagement — every scroll-writer except the bfcache paths. Contract on
 * EVERY return landing (including after a rapid back/forward burst):
 *   - marker near its setup position,
 *   - position converges post-overlay without oscillation.
 *
 * Media is held during the return trips: the reader shell is re-rendered from
 * IndexedDB, every <img> re-requests (no-store), and decode lands long after
 * the popstate machinery positions the reader.
 */

const TOP_TOLERANCE_PX = 170;
const MAX_REVERSALS = 1;

test.use({ serviceWorkers: 'block' });

test.describe('scroll-restore: SPA back/forward', () => {
  test.setTimeout(360_000);
  test.afterEach(attachForensicsOnFailure);

  test('home → back → burst of forward/back land on the marker without shaking', async ({ page, spa }) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');

    const { bookId, markerId, throttle } = await setupImageBookScenario(page, spa, {});
    const setupMarkerTop = await nodeTop(page, markerId);

    // Leave via a REAL gesture (logo → home) so history has a genuine entry pair.
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);
    await expect
      .poll(() => spa.getStructure(page), { timeout: 20_000 })
      .toBe('home');

    // Return trips with media held. Three rapid return landings:
    // goBack (reader), goForward (home), goBack (reader) — with minimal gaps,
    // the phone "jab the back button" pattern.
    const checkLanding = async (label) => {
      // Same-document nav: window the analysis to samples AFTER the goBack so
      // the setup's own scroll-through-seek is not counted.
      const preCount = (await snapshotForensics(page)).samples.length;
      await page.goBack({ timeout: 20_000 }).catch(() => {});
      try {
        await waitForNode(page, markerId);
      } catch (err) {
        const dump = await page.evaluate(() => ({
          url: location.pathname + location.search + location.hash,
          page: document.body.getAttribute('data-page'),
          chunks: document.querySelectorAll('.main-content .chunk').length,
          chunkIds: [...document.querySelectorAll('.main-content .chunk')].map((c) => c.getAttribute('data-chunk-id')),
          nodeIdsSample: [...document.querySelectorAll('.main-content .chunk > [id]')].map((n) => n.id).slice(0, 8),
          saved: sessionStorage.getItem(`scrollPosition_${(location.pathname.match(/book_\d+[\w-]*/) || ['?'])[0]}`),
        })).catch((e) => String(e));
        console.log(`[${label}] LANDING DUMP:`, JSON.stringify(dump));
        throw err;
      }
      await page.waitForTimeout(600);

      throttle.release(); // media that this landing requested may now arrive
      await page.waitForTimeout(2200);
      throttle.setMode('hold'); // re-arm for the next landing's fresh <img>s

      const snap = await snapshotForensics(page);
      const analysis = analyzeSettle(snap, { fromIndex: preCount });
      const markerTopNow = await nodeTop(page, markerId);
      const scrollNow = await readerScrollTop(page);

      const urlBook = await page.evaluate(() => location.pathname.match(/\/(book_\d+[\w-]*)/)?.[1] ?? null);
      expect(urlBook, `${label}: should be back on our book`).toBe(bookId);
      expect(markerTopNow, `${label}: marker in DOM`).not.toBeNull();
      expect(
        Math.abs(markerTopNow - setupMarkerTop),
        `${label}: marker near setup position (setup=${setupMarkerTop}, now=${markerTopNow}, scrollTop=${scrollNow})`
      ).toBeLessThan(TOP_TOLERANCE_PX);
      expect(
        analysis.reversals,
        `${label}: reversals=${analysis.reversals} (writes=${analysis.writesPostHide}, reasons=${analysis.writeReasonsPostHide.join(',')})`
      ).toBeLessThanOrEqual(MAX_REVERSALS);
    };

    // NOTE on forensics across SPA transitions: no new document is created,
    // so `pageShows`/overlay sampling only sees the overlay if the pathway
    // re-shows it. The reversal metric works off wrapper samples either way.
    throttle.setMode('hold');

    // Three deterministic return landings, the third with jabbed timing.
    await checkLanding('landing-1 (back)');
    await page.goForward({ timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(400);
    await checkLanding('landing-2 (back)');
    await page.goForward({ timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(200);
    await checkLanding('landing-3 (burst back)');

    await throttle.unroute();
  });
});
