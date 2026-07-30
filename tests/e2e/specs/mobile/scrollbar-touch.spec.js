/**
 * Mobile custom-scrollbar touch behaviour.
 * npm run test:e2e -- tests/e2e/specs/mobile/scrollbar-touch.spec.js
 *
 * Runs ONLY under the `mobile-chromium` project (touch + phone viewport). These
 * guard two real-world mobile bugs the desktop specs can't see:
 *   1. Dragging the thumb also scrolled the PAGE (native touch-scroll of the
 *      wrapper leaked through while the pointer drove the thumb).
 *   2. Dragging on iOS started a native "select all" text selection on content.
 *
 * REAL touch input is required: synthetic dispatched TouchEvents do NOT trigger
 * the browser's native scroll/selection, so we drive it through CDP
 * (Input.dispatchTouchEvent) — the same path a finger takes.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';

// Needs a book that OVERFLOWS a phone viewport (else the bar hides by design and
// the test skips). E2E_READER_BOOK is often a short fixture — set
// E2E_SCROLLBAR_BOOK in .env.e2e to a long book (e.g. a full-length import) to
// actually exercise this locally.
const READER_BOOK = process.env.E2E_SCROLLBAR_BOOK || process.env.E2E_READER_BOOK;

test.describe('mobile: custom scrollbar touch', () => {
  test('dragging the thumb scrolls neither the page nor selects text (only on release)', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(!READER_BOOK, 'E2E_SCROLLBAR_BOOK / E2E_READER_BOOK not set in .env.e2e');

    await page.goto(`/${READER_BOOK}`);
    await page.waitForSelector('.chunk[data-chunk-id]', { timeout: 25_000 });
    await page.waitForTimeout(3000);

    // Needs a book whose content overflows the viewport (else the bar hides by
    // design). Skip loudly rather than assert on shared/variable DB content.
    const shown = await page.evaluate(() => {
      const b = document.querySelector('.custom-scrollbar');
      return !!b && !b.hidden;
    });
    test.skip(!shown, `${READER_BOOK} does not overflow a phone viewport — no scrollbar to drive`);

    // Scroll down first so there's headroom to detect an unwanted native scroll.
    await page.evaluate(() => document.querySelector('.reader-content-wrapper').scrollTo(0, 1500));
    await page.waitForTimeout(400);

    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
      });

    const g = await page.evaluate(() => {
      const t = document.querySelector('.custom-scrollbar-thumb').getBoundingClientRect();
      const w = document.querySelector('.reader-content-wrapper');
      return { x: t.x + t.width / 2, y: t.y + t.height / 2, scrollTop: w.scrollTop };
    });

    // Pre-seed a full page selection to prove the drag CLEARS it (the "select all").
    await page.evaluate(() => {
      const el = document.querySelector('.main-content');
      if (!el) return;
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });

    // Real touch drag DOWN on the thumb — measure state DURING the drag (pre-release).
    await touch('touchStart', g.x, g.y);
    await page.waitForTimeout(20);
    for (let k = 1; k <= 10; k++) {
      await touch('touchMove', g.x, g.y + k * 20);
      await page.waitForTimeout(15);
    }
    const during = await page.evaluate(() => ({
      scrollTop: document.querySelector('.reader-content-wrapper').scrollTop,
      sel: getSelection().toString().length,
    }));
    await touch('touchEnd', g.x, g.y + 200);
    await page.waitForTimeout(1500);
    const afterScroll = await page.evaluate(
      () => document.querySelector('.reader-content-wrapper').scrollTop,
    );

    // 1. The page must NOT scroll natively while dragging the thumb (chunk mode
    //    commits on release; a small tolerance for sub-pixel jitter).
    expect(
      Math.abs(during.scrollTop - g.scrollTop),
      `page scrolled while dragging the thumb (before=${g.scrollTop}, during=${during.scrollTop})`,
    ).toBeLessThan(40);

    // 2. No page text-selection formed/survived during the drag.
    expect(during.sel, 'page text got selected while dragging the thumb').toBe(0);

    // 3. Release commits the jump — the drag WAS doing something.
    expect(
      Math.abs(afterScroll - g.scrollTop),
      'release did not commit a scroll jump',
    ).toBeGreaterThan(200);
  });
});
