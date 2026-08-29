import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  setupImageBookScenario,
  coldLoadBook,
  waitForOverlayHidden,
  waitForNode,
  readerScrollTop,
  topVisibleProbe,
} from './scenario.js';
import { attachForensicsOnFailure } from '../../helpers/scrollForensics.js';

/**
 * RESUME CURTAIN — the "Finding your previous position…" hold (RevealGate +
 * ProgressOverlayEnactor curtain mode) over a fresh-load resume with UNSIZED
 * images (remote refs, no width/height — the belt-only worst case).
 *
 * Contract:
 *   1. While the restore is still settling (images held), the boot overlay is
 *      escalated to the curtain: data-hl-hold set, curtain text, a focusable
 *      "Go to top of book instead" button.
 *   2. After the curtain reveals, the reading line DOES NOT MOVE: a 3s poll
 *      of the top-visible probe offset + scrollTop stays within a few px —
 *      the continuous no-jitter assertion the rest of the suite lacked.
 *   3. The go-to-top escape lands at 0, reveals, and a reload resumes at the
 *      top (the abandoned deep anchor is not re-asserted).
 *   4. A real wheel gesture during the hold reveals immediately (the curtain
 *      never fights the reader).
 *
 * The root fix (imageDims/book_images) is locked by the 'media' arm: imgs
 * served from /<book>/media/ must carry width/height attrs at render, which
 * also stands the compensation belt down for them.
 */

const CURTAIN = '#initial-navigation-overlay[data-hl-hold]';
const JITTER_TOLERANCE_PX = 6;

test.use({ serviceWorkers: 'block' });

test.describe('scroll-restore: resume curtain', () => {
  test.setTimeout(300_000);
  test.afterEach(attachForensicsOnFailure);

  test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');

  async function coldLoadIntoCurtain(page, spa) {
    const scenario = await setupImageBookScenario(page, spa, { imageMode: 'remote' });
    scenario.throttle.setMode('hold');
    await coldLoadBook(page, scenario.bookId);
    // With every above-anchor image held, the belt cannot go quiet, so the
    // curtain must be up until we release (or its 4s cap fires — the selector
    // races well ahead of that on a local run).
    await page.waitForSelector(CURTAIN, { state: 'attached', timeout: 20_000 });
    // The blade escalates the curtain at FIRST PAINT, before RevealGate arms —
    // the go-to-top button appearing is the "JS is armed" signal. Interacting
    // earlier would hit a curtain with no gesture listeners yet.
    await page.waitForSelector('#resume-curtain-top-btn', { state: 'visible', timeout: 10_000 });
    return scenario;
  }

  test('holds an opaque curtain while images settle, then reveals with a still reading line', async ({ page, spa }) => {
    const { markerId, throttle } = await coldLoadIntoCurtain(page, spa);

    const text = await page.textContent('#page-load-progress-text');
    expect(text).toContain('Restoring your reading position');
    await expect(page.locator('#resume-curtain-top-btn')).toBeVisible();
    await expect(page.locator('#resume-curtain-spinner')).toBeVisible();

    // Deliver the images; the correction belt does its work BEHIND the curtain.
    throttle.release();
    throttle.setMode('delay', { delayMs: 40 });
    await waitForOverlayHidden(page);
    await waitForNode(page, markerId);

    // The whole point: after reveal the viewport does not move again.
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const probe = await topVisibleProbe(page);
      const scrollTop = await readerScrollTop(page);
      samples.push({ probeTop: probe?.topOffset ?? null, scrollTop });
      await page.waitForTimeout(100);
    }
    await throttle.unroute();

    const probeTops = samples.map((s) => s.probeTop).filter((v) => v !== null);
    const spread = Math.max(...probeTops) - Math.min(...probeTops);
    expect(
      spread,
      `reading line moved ${spread}px across the 3s post-reveal window: ${JSON.stringify(samples)}`
    ).toBeLessThanOrEqual(JITTER_TOLERANCE_PX);
  });

  test('"Go to top of book instead" cancels the restore, lands at 0, and stays there on reload', async ({ page, spa }) => {
    const { bookId, throttle } = await coldLoadIntoCurtain(page, spa);

    await page.click('#resume-curtain-top-btn');
    await waitForOverlayHidden(page);
    // goToTop is a real navigation (chunk 0 must load with its images held) —
    // give the landing a moment, then assert it landed and STAYED near 0.
    await page.waitForTimeout(1500);

    const top = await readerScrollTop(page);
    expect(top, 'go-to-top must land AND STAY at the top').toBeLessThanOrEqual(50);

    // The escape saved "top" as the new position — a reload must not re-assert
    // the abandoned deep anchor.
    throttle.release();
    throttle.setMode('instant');
    await coldLoadBook(page, bookId);
    await waitForOverlayHidden(page);
    await page.waitForTimeout(1500);
    const topAfterReload = await readerScrollTop(page);
    await throttle.unroute();
    expect(topAfterReload, 'reload after go-to-top resumes at the top').toBeLessThanOrEqual(250);
  });

  test('a wheel gesture during the hold reveals immediately', async ({ page, spa }) => {
    const { throttle } = await coldLoadIntoCurtain(page, spa);

    // Viewport-relative coordinates: the scroll-restore-mobile project runs at
    // 390×844, where a hardcoded (400,400) is OUTSIDE the page — the wheel
    // event then never reaches the document and the gate (correctly) holds.
    const vp = page.viewportSize();
    await page.mouse.move(Math.floor(vp.width / 2), Math.floor(vp.height / 2));
    await page.mouse.wheel(0, 250);
    await waitForOverlayHidden(page, 3_000); // gesture reveal, not the 4s cap
    throttle.release();
    // Let the released responses finish before unroute — unrouting while a
    // held fulfill is in flight throws "Route is already handled".
    await page.waitForTimeout(600);
    await throttle.unroute();
  });

  test('media-served images carry width/height at render (imageDims root fix)', async ({ page, spa }) => {
    const { bookId, markerId, throttle } = await setupImageBookScenario(page, spa, { imageMode: 'media' });
    throttle.setMode('instant');
    await coldLoadBook(page, bookId);
    await waitForNode(page, markerId);
    await waitForOverlayHidden(page);
    // Late (deferred) application settles within a beat of first render.
    await page.waitForTimeout(1000);

    // Only rendered chunks hold imgs and media-mode images are sparse — walk
    // the wrapper until at least one media img is in the windowed DOM.
    const audit = await (async () => {
      for (let i = 0; i < 25; i++) {
        const result = await page.evaluate(() => {
          const imgs = [...document.querySelectorAll('.main-content img')]
            .filter((img) => (img.getAttribute('src') || '').includes('/media/'));
          return {
            total: imgs.length,
            unsized: imgs
              .filter((img) => !img.getAttribute('width') || !img.getAttribute('height'))
              .map((img) => img.getAttribute('src')),
          };
        });
        if (result.total > 0) return result;
        await page.evaluate(() => {
          const el = document.querySelector('.reader-content-wrapper');
          if (el) el.scrollTop += el.clientHeight * 3;
        });
        await page.waitForTimeout(600);
      }
      return { total: 0, unsized: [] };
    })();
    await throttle.unroute();

    expect(audit.total, 'media arm must actually render media imgs').toBeGreaterThan(0);
    expect(audit.unsized, 'every rendered media img carries width/height').toEqual([]);
  });
});
