import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Hash-survives-scroll-away regression (the "can't go forwards" bug).
 *
 * Root cause: after deep-linking to a target (#hypercite_/#HL_/#<node>), scrolling away used to
 * STRIP the hash from the URL via history.replaceState — which mutates the history ENTRY, so
 * back/forward to it lost the target and landed at the top of the page.
 *
 * Fix: scrolling away no longer touches the URL. Resume-vs-jump is decided by the durable causal
 * rule (scrolling/restore.ts + navStamp): we JUMP to a hash target unless we navigated there and
 * then read PAST it (`savedAt > navigatedAt`), in which case we RESUME. The hash stays in the URL
 * → back/forward still navigate to it.
 *
 * This guard asserts BOTH halves on a single book (fast, no EPUB):
 *   1. the hash SURVIVES a scroll-away (so forward/back keep working) — the regression;
 *   2. a refresh after scroll-away RESUMES the scroll position instead of re-jumping to the hash
 *      (the original goal is still met).
 */

const READER_SCROLLER = '.reader-content-wrapper, .main-content, main';

async function readerScrollTop(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel.split(',')[0].trim())
      || document.querySelector('.main-content') || document.querySelector('main');
    return el ? el.scrollTop : null;
  }, READER_SCROLLER);
}

test.describe('hash survives scroll-away', () => {
  test('scrolling away keeps the deep-link hash in the URL (back/forward still target it)', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 600, height: 500 });

    // ── Author a book with a target node well below the fold ──
    await spa.createNewBook(page, spa);
    const bookId = await spa.getCurrentBookId(page);

    await page.click('h1[id="100"]');
    await page.keyboard.type('Hash Survival');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    for (let i = 0; i < 18; i++) {
      await page.keyboard.type(`Filler paragraph number ${i} — padding the document so the deep-link target lives well below the fold.`);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type('DEEP TARGET PARAGRAPH');
    await page.waitForTimeout(300);

    // Leave edit mode → read mode.
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);

    // Pick the id of a paragraph near the END of the document (a numeric node id = an internal-nav
    // target that the scroll-away logic acts on, exactly like a #hypercite_/#HL_).
    const targetId = await page.evaluate(() => {
      const ps = [...document.querySelectorAll('.main-content p[id]')];
      const deep = ps[ps.length - 1];
      return deep ? deep.id : null;
    });
    test.skip(!targetId, 'setup could not produce a deep paragraph with an id');

    // ── Deep-link to it (fresh load via the URL hash) ──
    await page.goto(`/${bookId}#${targetId}`);
    await page.waitForLoadState('networkidle');
    // Wait until the reader has scrolled down to the target.
    await page.waitForFunction(() => {
      const el = document.querySelector('.reader-content-wrapper') || document.querySelector('.main-content');
      return el && el.scrollTop > 50;
    }, null, { timeout: 15000 }).catch(() => {});
    const scrolledTo = await readerScrollTop(page);
    expect(scrolledTo, 'deep-link should scroll the reader down to the target').toBeGreaterThan(50);
    expect(await page.evaluate(() => location.hash)).toBe(`#${targetId}`);

    // ── Scroll AWAY (triggers the throttled scroll-save → the mark/strip path) ──
    await page.evaluate(() => {
      const el = document.querySelector('.reader-content-wrapper') || document.querySelector('.main-content');
      if (el) el.scrollTop = Math.max(0, el.scrollTop - 250);
    });
    await page.waitForTimeout(600); // > the 250ms scroll-save throttle

    // (1) THE REGRESSION GUARD: the hash must STILL be in the URL (NOT stripped) so back/forward
    // to this entry still navigate to the target.
    const hashAfter = await page.evaluate(() => location.hash);
    expect(hashAfter, 'scroll-away must NOT strip the hash from the URL (would break back/forward)').toBe(`#${targetId}`);

    // Resume-vs-jump is now decided by the durable causal rule (savedAt > navigatedAt), not the old
    // sessionStorage scrolled-away marker — so we assert the OBSERVED behaviour below (refresh
    // resumes), not the retired mechanism.
    const positionBeforeReload = await readerScrollTop(page);

    // (2) ORIGINAL GOAL: a REFRESH resumes the scroll position, NOT a re-jump to the hash target.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    const afterReload = await readerScrollTop(page);
    expect(
      Math.abs(afterReload - positionBeforeReload),
      `refresh should resume the scroll position (was ${positionBeforeReload}, now ${afterReload}), not re-jump to the hash`
    ).toBeLessThan(120);
  });
});
