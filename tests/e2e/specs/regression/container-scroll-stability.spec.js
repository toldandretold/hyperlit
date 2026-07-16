import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Container scroll-stability regression.
 *
 * Guards the fix for the user-reported bug: navigating to a fragment
 * (#hypercite_X / #HL_X), opening a hyperlit container, then closing it
 * (overlay tap → history.back()) made the reader JUMP — the browser's
 * scroll restoration on the close-back snapped the page to the URL fragment
 * (or a stale captured pixel), away from where the reader was.
 *
 * Fix = scoped manual scroll restoration: `history.scrollRestoration` is set
 * to 'manual' while a container is open and reset to 'auto' once it fully
 * closes (resources/js/hyperlitContainer/core).
 *
 * This test asserts BOTH:
 *   1. MECHANISM (deterministic, browser-agnostic): scrollRestoration flips
 *      'manual' on open and back to 'auto' after close. This is the real
 *      guard — it holds even in Chromium where the native jump may not
 *      reproduce the way it does in Safari.
 *   2. BEHAVIOUR: the reader's scrollTop is unchanged across open→close
 *      (±a few px). A gross regression that moves the reader on close fails
 *      here regardless of mechanism.
 *
 * Scroll is measured on .reader-content-wrapper (the real inner scroller) —
 * window.scrollY is ~always 0 in this app.
 */

const READER_SCROLLER =
  '.reader-content-wrapper, .main-content, main';

// Read scrollTop of the actual reader scroller from the page.
async function readerScrollTop(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel.split(',')[0].trim())
      || document.querySelector('.main-content')
      || document.querySelector('main');
    return el ? el.scrollTop : null;
  }, READER_SCROLLER);
}

async function scrollRestoration(page) {
  return page.evaluate(() =>
    ('scrollRestoration' in history) ? history.scrollRestoration : null);
}

function visibleStack(page) {
  return page.evaluate(() =>
    (document.querySelector('#hyperlit-container.open') ? 1 : 0)
    + document.querySelectorAll('.hyperlit-container-stacked.open').length);
}

test.describe('container scroll stability', () => {
  test('opening + closing a hyperlit container does not move the reader scroll', async ({ page, spa }) => {
    // Asserts scroll-mode MECHANICS (scrollTop preconditions + stability). In
    // paginated mode the wrapper never scrolls (scrollTop pinned ~0), so the
    // precondition can't be met; the pages-mode equivalent (page index stable
    // across container open/close) is covered by paginated-reading smoke.
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    test.setTimeout(90_000);

    // Small viewport so modest content overflows → real scroll room, and the
    // hyperlight target sits below the fold (mirrors the reported mobile-ish case).
    await page.setViewportSize({ width: 600, height: 500 });

    // ── Setup: author a book with a hyperlight on a phrase below the fold ──
    const { bookId } = await spa.createNewBook(page, spa);

    await page.click('h1[id="100"]');
    await page.keyboard.type('Scroll Stability');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);

    // Filler lines so the target is well below the fold.
    for (let i = 0; i < 14; i++) {
      await page.keyboard.type(`Filler paragraph number ${i} — padding the document so the hyperlight target lives below the fold.`);
      await page.keyboard.press('Enter');
    }
    const TARGET = 'HYPERLIGHT TARGET PHRASE';
    await page.keyboard.type(TARGET);
    await page.waitForTimeout(300);

    // Create the hyperlight on the target phrase (opens a stacked sub-book).
    await spa.selectInActiveEditor(page, TARGET);
    await spa.hyperlightSelection(page);
    expect(await spa.getStackDepth(page)).toBeGreaterThan(0);

    // Close the authoring container and leave edit mode → read mode.
    let safety = 6;
    while ((await spa.getStackDepth(page)) > 0 && safety-- > 0) {
      await page.evaluate(() => {
        const top = [...document.querySelectorAll('.hyperlit-container-stacked.open')].pop();
        const ov = top?.querySelector('.container-overlay')
          || document.querySelector('#hyperlit-container.open .container-overlay')
          || document.getElementById('ref-overlay');
        ov?.click();
      });
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);

    // Sanity: a clickable hyperlight mark exists in the main text, container closed.
    const markSel = 'mark.user-highlight, mark.highlight, mark[data-highlight-count]';
    await page.waitForSelector(`.main-content ${markSel}`, { timeout: 8000 });
    expect(await visibleStack(page)).toBe(0);
    expect(await scrollRestoration(page)).toBe('auto'); // baseline: browser default

    // ── Position the reader so the mark is on-screen with scroll room above ──
    await page.evaluate((sel) => {
      const mark = document.querySelector(`.main-content ${sel}`);
      mark?.scrollIntoView({ block: 'center' });
    }, markSel);
    await page.waitForTimeout(300);

    const scrollBeforeOpen = await readerScrollTop(page);
    expect(scrollBeforeOpen, 'precondition: reader is scrolled down (room to jump)').toBeGreaterThan(50);

    // ── Open the container by clicking the hyperlight mark (read mode) ──
    await page.evaluate((sel) => {
      document.querySelector(`.main-content ${sel}`)?.click();
    }, markSel);
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 8000 });
    await page.waitForTimeout(400);

    // MECHANISM #1: scrollRestoration is 'manual' while the container is open.
    expect(await scrollRestoration(page), 'scrollRestoration should be manual while container open').toBe('manual');

    // ── Close via overlay tap (the history.back() path the bug rides on) ──
    await page.evaluate(() => {
      const base = document.querySelector('#hyperlit-container.open');
      const ov = base?.querySelector('.container-overlay') || document.getElementById('ref-overlay');
      ov?.click();
    });
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return !c || !c.classList.contains('open');
    }, null, { timeout: 8000 });
    // Allow the close-back popstate + any browser restore to fully settle
    // (longer than the double-rAF auto reset).
    await page.waitForTimeout(800);

    const scrollAfterClose = await readerScrollTop(page);

    // BEHAVIOUR: the reader did not jump.
    expect(
      Math.abs(scrollAfterClose - scrollBeforeOpen),
      `reader jumped on close: ${scrollBeforeOpen} → ${scrollAfterClose}`
    ).toBeLessThanOrEqual(3);

    // MECHANISM #2: scrollRestoration was reset to 'auto' for ordinary nav.
    expect(await scrollRestoration(page), 'scrollRestoration should reset to auto after close').toBe('auto');

    // Container fully gone.
    expect(await visibleStack(page)).toBe(0);
  });
});
