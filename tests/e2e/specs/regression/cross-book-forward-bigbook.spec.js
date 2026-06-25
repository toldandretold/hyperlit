import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Cross-book FORWARD into a BIG source book where the hypercite is DEEP (not in chunk 0).
 *
 * The fast (tiny-book) repro passes because the hypercite is always in the initial chunk.
 * The real-world failure is a large book where the target lives in a later chunk — the nav
 * may fail to resolve it in the initial fetch and strip the hash, or resume at a stale saved
 * position. This test replicates that: a big generated source book (no EPUB → no 404 noise),
 * hypercite deep in it, cited from a second book, then back/forward — asserting forward lands
 * on the deep hypercite (hash present, <u> in viewport), not the top.
 *
 * Verbose nav logs + every back/forward step are printed so a failure shows exactly where it breaks.
 */

const NAV_LINE = /\[NAV\]|Already at|No hash navigation|hasHashNavigation|Initiating navigation|restoreContainerStack|Fast-path|Resolver result|resolved=|Navigation target ready|Failed to wait|target not|Cleaning the stale|targetResolved|client-only/;

test.describe('cross-book forward — big book, deep hypercite', () => {
  test('forward into a big source book lands on the deep hypercite (not the top)', async ({ page, spa }) => {
    test.setTimeout(300_000);
    await page.addInitScript(() => { try { localStorage.setItem('hyperlit_verbose_logs', 'true'); } catch (e) {} });
    const navLog = [];
    page.on('console', (m) => { const t = m.text(); if (NAV_LINE.test(t)) navLog.push(t); });
    const dumpNav = (label) => console.log(`\n──── NAV (${label}) ────\n${navLog.slice(-30).join('\n')}\n────\n`);

    await page.setViewportSize({ width: 700, height: 600 });

    // ── Big source book A (≈200 nodes → multiple chunks) ──
    const markdown = spa.generateLongMarkdown({
      title: 'Big Source Book',
      chapters: 18,
      paragraphsPerChapter: 10,
      wordsPerParagraph: 45,
    });
    const { bookId: bookAId } = await spa.importMarkdownBook(page, spa, { name: 'big-source.md', content: markdown });
    expect(bookAId).toMatch(/^book_\d+/);
    const chunkCount = await page.evaluate(() => (window.nodes ? window.nodes.length : null));
    console.log(`book A chunk count: ${chunkCount}`);

    // Enter edit mode, navigate DEEP via TOC, make a hypercite on a deep paragraph.
    if (!(await page.evaluate(() => !!window.isEditing))) {
      await page.click('#editButton');
      await spa.waitForEditMode(page);
    }
    await spa.openToc(page);
    const toc = await spa.getTocEntries(page);
    expect(toc.length).toBeGreaterThan(4);
    const deep = toc[Math.floor(toc.length * 0.8)]; // a chapter ~80% down
    await spa.clickTocEntry(page, deep.index);
    await page.waitForTimeout(600);

    // Select a stable substring of the first sizable paragraph after the deep heading.
    const paraSel = await page.evaluate((hash) => {
      const id = (hash || '').replace(/^#/, '');
      const h = document.querySelector(`[id="${id}"]`);
      let p = h?.nextElementSibling;
      while (p && (p.tagName !== 'P' || (p.textContent || '').trim().length < 40)) p = p.nextElementSibling;
      if (!p) return null;
      return p.id ? `.main-content p[id="${p.id}"]` : null;
    }, deep.href);
    expect(paraSel, 'found a deep paragraph to hypercite').not.toBeNull();
    const deepText = (await page.locator(paraSel).textContent()).trim();
    const phrase = deepText.slice(0, 28);
    await spa.selectTextInElement(page, paraSel, 0, phrase.length);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hypercite');
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 8000 });

    const clip = await page.evaluate(() => {
      const u = document.querySelector('u[id^="hypercite_"].single');
      const bookId = document.querySelector('.main-content')?.id;
      const href = `${window.location.origin}/${bookId}#${u.id}`;
      return { hyperciteId: u.id, html: `'${u.textContent}'⁠<a href="${href}" id="${u.id}" class="open-icon">↗</a>`, text: `'${u.textContent}' [↗](${href})` };
    });
    expect(clip.hyperciteId).toMatch(/^hypercite_/);

    // Confirm the hypercite really is DEEP (its chunk is not chunk 0).
    const hcChunk = await page.evaluate((hcId) => {
      const u = document.getElementById(hcId);
      const chunk = u?.closest('[data-chunk-id]');
      return chunk ? chunk.getAttribute('data-chunk-id') : null;
    }, clip.hyperciteId);
    console.log(`hypercite ${clip.hyperciteId} is in chunk ${hcChunk}`);

    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});

    // ── Citing book B (small) — paste the link ──
    const { bookId: bookBId } = await spa.createNewBook(page, spa);
    await page.click('h1[id="100"]');
    await page.keyboard.type('Citing Book');
    await page.keyboard.press('Enter');
    await page.keyboard.type('We cite the big source here: ');
    await page.waitForTimeout(300);
    await spa.pasteHyperciteContent(page, clip.html, clip.text);
    await page.waitForSelector('.main-content a.open-icon[id^="hypercite_"]', { timeout: 10000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});

    // ── Click pasted hypercite → container → See in source → big book A (deep) ──
    navLog.length = 0;
    await page.locator('.main-content a.open-icon[id^="hypercite_"]').first().click();
    await page.waitForFunction(() => document.querySelector('#hyperlit-container.open'), null, { timeout: 10000 });
    await page.locator('#hyperlit-container a.see-in-source-btn').first().click();
    await spa.waitForTransition(page).catch(() => {});
    await page.waitForTimeout(1500);

    const probe = () => page.evaluate((hcId) => {
      const u = document.querySelector(`u[id="${hcId}"]`);
      const rect = u ? u.getBoundingClientRect() : null;
      return {
        bookId: document.querySelector('.main-content')?.id || null,
        hash: location.hash, url: location.href,
        found: !!u, top: rect?.top,
        inViewport: !!rect && rect.top >= -50 && rect.top < window.innerHeight - 50,
      };
    }, clip.hyperciteId);

    const landed = await probe();
    dumpNav('first landing on big book A');
    console.log('FIRST landing:', JSON.stringify(landed));
    expect(landed.bookId, 'see-in-source should land on book A').toBe(bookAId);
    // Document whether the very first landing already loses the hash (the suspected real bug):
    expect(landed.hash, `first landing already lost the hash (url=${landed.url})`).toBe(`#${clip.hyperciteId}`);

    // ── back×3, forward×3 ──
    const stepState = () => page.evaluate(() => ({ id: document.querySelector('.main-content')?.id || null, url: location.href, open: !!document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open') }));
    navLog.length = 0;
    for (let i = 0; i < 3; i++) { await page.goBack(); await spa.waitForTransition(page).catch(() => {}); await page.waitForTimeout(800); console.log(`BACK ${i + 1}:`, JSON.stringify(await stepState())); }
    for (let i = 0; i < 3; i++) { await page.goForward(); await spa.waitForTransition(page).catch(() => {}); await page.waitForTimeout(1000); console.log(`FORWARD ${i + 1}:`, JSON.stringify(await stepState())); }

    const fwd = await probe();
    dumpNav('after full back/forward replay');
    console.log('FINAL:', JSON.stringify(fwd));
    expect(fwd.bookId, 'final forward should land on book A').toBe(bookAId);
    expect(fwd.hash, `final forward LOST the #hypercite hash (url=${fwd.url})`).toBe(`#${clip.hyperciteId}`);
    expect(fwd.inViewport, `final forward landed at the TOP, not the deep hypercite (top=${fwd.top})`).toBe(true);
  });
});
