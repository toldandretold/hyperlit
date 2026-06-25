import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Cross-book FORWARD must land on the hypercite (the "can't go forwards" bug) — FAST repro.
 *
 * Journey (no EPUB — two createNewBook books, runs in ~1-2 min):
 *   Book A: author a source passage well below the fold, make a hypercite, copy its link.
 *   Book B: paste the hypercite link.
 *   Click the pasted link → ref container → "See in source text" → navigate to Book A
 *     (BookToBookTransition, the cross-book path) → lands ON the <u> with #hypercite in the URL.
 *   goBack → Book B. goForward → Book A.
 *
 * THE ASSERTION: after goForward, we're on Book A, the URL STILL carries #hypercite_… and the
 * <u> is in the viewport — NOT the top of the page. This is the exact user-reported failure.
 *
 * Verbose nav logs are captured so a failure pinpoints whether the hash is missing on the
 * forward entry (strip/never-set) vs present-but-ignored.
 */

const NAV_LINE = /\[NAV\]|Already at|No hash navigation|hasHashNavigation|Initiating navigation to internal ID|restoreContainerStack|Fast-path|Resolver result|Navigation target ready|Failed to wait/;

async function readerScrollTop(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.reader-content-wrapper') || document.querySelector('.main-content');
    return el ? el.scrollTop : null;
  });
}

test.describe('cross-book forward anchor', () => {
  test('forward into the source book lands on the hypercite (not the top)', async ({ page, spa }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => { try { localStorage.setItem('hyperlit_verbose_logs', 'true'); } catch (e) {} });
    const navLog = [];
    page.on('console', (m) => { const t = m.text(); if (NAV_LINE.test(t)) navLog.push(t); });
    const dumpNav = (label) => console.log(`\n──── NAV (${label}) ────\n${navLog.slice(-25).join('\n')}\n────\n`);

    await page.setViewportSize({ width: 600, height: 500 });

    // ── Book A: source passage below the fold + a hypercite on it ──
    const { bookId: bookAId } = await spa.createNewBook(page, spa);
    await page.click('h1[id="100"]');
    await page.keyboard.type('Source Book A');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 14; i++) {
      await page.keyboard.type(`Filler ${i} — padding so the cited passage lives well below the fold of book A.`);
      await page.keyboard.press('Enter');
    }
    const SRC = 'THE CITED SOURCE PASSAGE';
    await page.keyboard.type(SRC);
    await page.waitForTimeout(400);

    await spa.selectInActiveEditor(page, SRC);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hypercite');
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 8000 });

    const clip = await page.evaluate(() => {
      const u = document.querySelector('u[id^="hypercite_"].single');
      const hcId = u.id;
      const bookId = document.querySelector('.main-content')?.id;
      const origin = window.location.origin;
      const href = `${origin}/${bookId}#${hcId}`;
      const txt = u.textContent;
      return {
        hyperciteId: hcId,
        html: `'${txt}'⁠<a href="${href}" id="${hcId}" class="open-icon">↗</a>`,
        text: `'${txt}' [↗](${href})`,
      };
    });
    expect(clip.hyperciteId).toMatch(/^hypercite_/);

    // Let the cloud sync settle so book A's IndexedDB write is durable, then exit edit.
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});

    // ── Book B: paste the hypercite link ──
    const { bookId: bookBId } = await spa.createNewBook(page, spa);
    expect(bookBId).not.toBe(bookAId);
    await page.click('h1[id="100"]');
    await page.keyboard.type('Citing Book B');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Here we cite the source: ');
    await page.waitForTimeout(300);

    await spa.pasteHyperciteContent(page, clip.html, clip.text);
    await page.waitForSelector('.main-content a.open-icon[id^="hypercite_"]', { timeout: 10000 });
    await page.waitForTimeout(1200); // let it persist
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});

    // ── Click the pasted hypercite → ref container → "See in source text" → Book A ──
    navLog.length = 0;
    await page.locator('.main-content a.open-icon[id^="hypercite_"]').first().click();
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });

    const seeBtn = page.locator('#hyperlit-container a.see-in-source-btn').first();
    await seeBtn.click();
    await spa.waitForTransition(page).catch(() => {});
    await page.waitForTimeout(1000);

    // Helper: where are we + is the <u> visible?
    const probe = () => page.evaluate((hcId) => {
      const u = document.querySelector(`u[id="${hcId}"]`);
      const rect = u ? u.getBoundingClientRect() : null;
      return {
        bookId: document.querySelector('.main-content')?.id || null,
        hash: location.hash,
        url: location.href,
        found: !!u,
        top: rect?.top,
        inViewport: !!rect && rect.top >= -50 && rect.top < window.innerHeight - 50,
      };
    }, clip.hyperciteId);

    // FIRST landing (this already worked before — sanity).
    const landed = await probe();
    dumpNav('first landing on book A');
    expect(landed.bookId, 'see-in-source should land on book A').toBe(bookAId);
    expect(landed.hash, `first landing lost the hash (url=${landed.url})`).toBe(`#${clip.hyperciteId}`);

    // ── The user's exact repro: go ALL the way back, then ALL the way forward ──
    // Log the id/url/container at every step so a failure shows WHERE the journey breaks.
    const STEPS = 3;
    navLog.length = 0;
    const stepState = () => page.evaluate(() => ({
      id: document.querySelector('.main-content')?.id || null,
      url: location.href,
      hash: location.hash,
      open: !!document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open'),
    }));

    for (let i = 0; i < STEPS; i++) {
      await page.goBack();
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(700);
      console.log(`BACK ${i + 1}:`, JSON.stringify(await stepState()));
    }
    for (let i = 0; i < STEPS; i++) {
      await page.goForward();
      await spa.waitForTransition(page).catch(() => {});
      await page.waitForTimeout(900);
      console.log(`FORWARD ${i + 1}:`, JSON.stringify(await stepState()));
    }

    // ★ THE BUG ASSERTION: after replaying forward, we must be back on book A, AT the hypercite
    // (hash present + <u> in viewport) — not the top.
    const fwd = await probe();
    const top = await readerScrollTop(page);
    dumpNav('after full back/forward replay');
    console.log('FINAL probe:', JSON.stringify(fwd), 'scrollTop=', top);
    expect(fwd.bookId, 'final forward should land on book A').toBe(bookAId);
    expect(fwd.hash, `final forward LOST the #hypercite hash (url=${fwd.url}) — this is the bug`).toBe(`#${clip.hyperciteId}`);
    expect(fwd.found, 'the <u> should be present on book A after forward').toBe(true);
    expect(fwd.inViewport, `final forward landed at the TOP, not the hypercite (top=${fwd.top})`).toBe(true);
  });
});
