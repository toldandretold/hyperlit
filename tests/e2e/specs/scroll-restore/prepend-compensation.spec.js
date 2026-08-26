import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  setupImageBookScenario,
  waitForNode,
  readerScrollTop,
  chunkCount,
} from './scenario.js';
import { attachForensicsOnFailure } from '../../helpers/scrollForensics.js';

/**
 * PREPEND / ABOVE-VIEWPORT COMPENSATION — the "page slides under my finger"
 * case, end to end:
 *
 *   - scroll up into a chunk whose images are held → the chunk renders with
 *     zero-height images; loadPreviousChunkFixed measures it SYNCHRONOUSLY and
 *     compensates scrollTop by that pre-decode height;
 *   - release the bytes → each image grows the document BELOW our pinned
 *     position by ~280px — above-viewport images;
 *   - the settle compensation belt (imageState.ts) must fire per image, or the
 *     reader's place slides away under them.
 *
 * Choreography notes (why it looks the way it does):
 *   - media runs in delay(350ms) mode through restore, so the restore lands on
 *     its own before we arm anything — restore's own image-correction belt has
 *     its 8s window then stands down;
 *   - we THEN arm 'hold' and scroll UP until the observer prepends a chunk —
 *     its images are now genuinely pending;
 *   - the lazy-loader belt's nav-window skip stands down by then, so the
 *     released images must each produce a scrollTop delta compensation.
 *   - the precondition asserts pending images actually exist before we release
 *     (otherwise we tested nothing — first iteration of this spec failed that
 *     precondition and I've kept the guard as a permanent structural check).
 */

const DRIFT_TOLERANCE_PX = 90;

test.use({ serviceWorkers: 'block' });

/** The first .chunk child whose box straddles the wrapper's top edge. */
function topVisibleProbe(page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector('.reader-content-wrapper');
    if (!wrapper) return null;
    const top = wrapper.getBoundingClientRect().top;
    const nodes = [...wrapper.querySelectorAll('.chunk > [id]')];
    let lastAbove = null;
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 1) {
        return { id: el.id, topOffset: Math.round(r.top - top) };
      }
      lastAbove = el;
    }
    return lastAbove ? { id: lastAbove.id, topOffset: Math.round(lastAbove.getBoundingClientRect().top - top) } : null;
  });
}

test.describe('scroll-restore: prepend compensation vs late images', () => {
  test.setTimeout(360_000);
  test.afterEach(attachForensicsOnFailure);

  test('scrolling up into a chunk whose images load late must not slide the content', async ({ page, spa }) => {
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');

    const { markerId, throttle } = await setupImageBookScenario(page, spa, {});

    // Hold ALL media from the start: restore is element-anchored (scrolls to
    // the saved node id, not to an image-dependent pixel), so it lands without
    // any image bytes. Every image in the book stays at 0-height until we
    // release — the worst-case geometry for prepend compensation.
    throttle.setMode('hold');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForNode(page, markerId);

    // Wait for the restore to land deep and go stationary. With all images
    // held, the scrollHelpers correction belt has nothing to correct (no
    // image loads fire), so the initial element-anchored scroll IS the final
    // position — it just takes a few seconds for the chunk fetch + render.
    let top = await readerScrollTop(page);
    for (let i = 0; i < 40 && (top == null || top < 1000); i++) {
      await page.waitForTimeout(300);
      top = await readerScrollTop(page);
    }
    if (top == null || top < 1000) throw new Error(`restore never landed deep (scrollTop=${top}) — cannot run the prepend arm`);
    for (let stable = 0; stable < 2; ) {
      const a = await readerScrollTop(page);
      await page.waitForTimeout(400);
      const b = await readerScrollTop(page);
      stable = a === b ? stable + 1 : 0;
    }

    // 3: scroll up in viewport steps with REAL wheel gestures — near the top
    // sentinel this forces prepends of chunks whose images are pending (held).
    // Real gestures matter: they advance lastGestureScrollTime, which is what
    // tells any still-armed landing machinery the reader took over (a bare
    // `el.scrollTop -=` evaluate write is invisible to gesture detection, and
    // an earlier version of this spec used exactly that — the late landing
    // correction then legally yanked the reader back to the saved anchor).
    const wrapperBox = await page.locator('.reader-content-wrapper').boundingBox();
    await page.mouse.move(wrapperBox.x + wrapperBox.width / 2, wrapperBox.y + wrapperBox.height / 2);
    const chunksBefore = await chunkCount(page);
    let preppedChunks = chunksBefore;
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(900);
      preppedChunks = await chunkCount(page);
      const atTop = ((await readerScrollTop(page)) ?? 0) <= 0;
      if (preppedChunks > chunksBefore || atTop) break;
    }
    await page.waitForTimeout(2500); // outlast the user-scroll flag AND the 2s isUserCurrentlyScrolling window

    // Precondition: SOMETHING is still waiting on bytes — otherwise the hold
    // never bit and this arm tested nothing.
    const pendingImages = await page.evaluate(() =>
      [...document.querySelectorAll('.main-content img')].filter((i) => !i.complete || i.naturalWidth === 0).length
    );

    const before = await topVisibleProbe(page);
    const scrollBefore = await readerScrollTop(page);

    // 5: the network finally delivers.
    throttle.release();
    throttle.setMode('delay', { delayMs: 60 });
    await page.waitForTimeout(3000);

    const after = await topVisibleProbe(page);
    const scrollAfter = await readerScrollTop(page);
    await throttle.unroute();

    expect(pendingImages, 'precondition: held images were pending in the DOM').toBeGreaterThan(0);
    expect(before, 'top-visible probe before release').not.toBeNull();
    expect(after, 'top-visible probe after release').not.toBeNull();
    expect(
      after.id,
      `the content at the top of the viewport changed when images decoded: ` +
      `"${before?.id}"@${before?.topOffset} → "${after?.id}"@${after?.topOffset} ` +
      `(scrollTop ${Math.round(scrollBefore ?? -1)} → ${Math.round(scrollAfter ?? -1)}, chunks ${chunksBefore}→${preppedChunks})`
    ).toBe(before.id);
    expect(
      Math.abs(after.topOffset - before.topOffset),
      `top node viewport offset moved ${Math.abs(after.topOffset - before.topOffset)}px when images decoded`
    ).toBeLessThan(DRIFT_TOLERANCE_PX);
    void markerId;
  });
});
