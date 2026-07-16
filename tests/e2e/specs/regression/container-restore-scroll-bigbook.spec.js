import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Container RESTORE-scroll in a BIG (multi-chunk) book — the user's "back/forward opens the
 * container but the page is stuck at the top" bug.
 *
 * container-restore-scroll.spec.js passes because its book is a single chunk: the anchor element
 * is ALWAYS already in the DOM, so navigateToInternalId finds it instantly. The real failure is a
 * multi-chunk book where the anchored hyperlight/hypercite lives in a chunk that is NOT loaded
 * after a back/forward restore — navigateToInternalId can't find it and the reader is left at the
 * top with the container hovering over unrelated content.
 *
 * Journey (same book, container stays OPEN — distinct from the cross-book "see in source" path):
 *   import a ~200-node book → TOC to a deep chapter → hyperlight a deep phrase → read mode →
 *   click the deep mark (container opens over main, main scrolled to the mark) →
 *   goBack (close) → goForward (restore).
 * ASSERTION: after goForward the container is open AND the deep mark is in the viewport, NOT top.
 */

const NAV_LINE = /\[NAV\]|Resolver result|resolved=|CONTAINER CLEAR|Navigation target ready|Failed to wait|target not|No block found|Resolved chunk .* not found|restoreContainerStack|Fast-path|Initiating navigation to internal ID|scrolling main to anchor/;

async function readerScrollTop(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.reader-content-wrapper') || document.querySelector('.main-content') || document.querySelector('main');
    return el ? el.scrollTop : null;
  });
}
function visibleStack(page) {
  return page.evaluate(() =>
    (document.querySelector('#hyperlit-container.open') ? 1 : 0)
    + document.querySelectorAll('.hyperlit-container-stacked.open').length);
}

test.describe('container restore scroll — big book, deep anchor', () => {
  test('back/forward restoring an open container scrolls a big book back to its DEEP anchor', async ({ page, spa }) => {
    // scrollTop-based preconditions + assertions — the wrapper never
    // scrolls in paginated mode.
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    test.setTimeout(300_000);
    await page.addInitScript(() => { try { localStorage.setItem('hyperlit_verbose_logs', 'true'); } catch (e) {} });
    const navLog = [];
    page.on('console', (m) => { const t = m.text(); if (NAV_LINE.test(t)) navLog.push(t); });
    const dumpNav = (label) => console.log(`\n──── NAV (${label}) ────\n${navLog.slice(-35).join('\n')}\n────\n`);

    await page.setViewportSize({ width: 700, height: 600 });

    // ── Big book (~200 nodes → multiple chunks) ──
    const markdown = spa.generateLongMarkdown({ title: 'Big Restore Book', chapters: 18, paragraphsPerChapter: 10, wordsPerParagraph: 45 });
    const { bookId } = await spa.importMarkdownBook(page, spa, { name: 'big-restore.md', content: markdown });
    expect(bookId).toMatch(/^book_\d+/);

    // ── Edit mode → TOC to a deep chapter → hyperlight a deep phrase ──
    if (!(await page.evaluate(() => !!window.isEditing))) { await page.click('#editButton'); await spa.waitForEditMode(page); }
    await spa.openToc(page);
    const toc = await spa.getTocEntries(page);
    expect(toc.length).toBeGreaterThan(4);
    const deep = toc[Math.floor(toc.length * 0.8)];
    await spa.clickTocEntry(page, deep.index);
    await page.waitForTimeout(600);

    const paraSel = await page.evaluate((hash) => {
      const id = (hash || '').replace(/^#/, '');
      const h = document.querySelector(`[id="${id}"]`);
      let p = h?.nextElementSibling;
      while (p && (p.tagName !== 'P' || (p.textContent || '').trim().length < 40)) p = p.nextElementSibling;
      return p && p.id ? `.main-content p[id="${p.id}"]` : null;
    }, deep.href);
    expect(paraSel, 'found a deep paragraph to hyperlight').not.toBeNull();
    const deepText = (await page.locator(paraSel).textContent()).trim();
    await spa.selectTextInElement(page, paraSel, 0, Math.min(28, deepText.length));
    await spa.hyperlightSelection(page);
    expect(await spa.getStackDepth(page)).toBeGreaterThan(0);

    // Close authoring container(s) + leave edit mode → read mode.
    let safety = 6;
    while ((await spa.getStackDepth(page)) > 0 && safety-- > 0) {
      await page.evaluate(() => {
        const top = [...document.querySelectorAll('.hyperlit-container-stacked.open')].pop();
        const ov = top?.querySelector('.container-overlay') || document.querySelector('#hyperlit-container.open .container-overlay') || document.getElementById('ref-overlay');
        ov?.click();
      });
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => document.getElementById('editButton')?.click());
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    expect(await visibleStack(page)).toBe(0);

    // Confirm the mark is DEEP (not in chunk 0).
    const markSel = 'mark.user-highlight, mark.highlight, mark[data-highlight-count]';
    const haveMark = await page.waitForSelector(`.main-content ${markSel}`, { timeout: 8000 }).then(() => true).catch(() => false);
    test.skip(!haveMark, 'setup could not produce a clickable hyperlight mark');
    const markChunk = await page.evaluate((sel) => {
      const m = document.querySelector(`.main-content ${sel}`);
      return m?.closest('[data-chunk-id]')?.getAttribute('data-chunk-id') ?? null;
    }, markSel);
    console.log(`hyperlight mark is in chunk ${markChunk}`);

    // ── Position so the mark is on-screen with scroll room above, then OPEN the container ──
    await page.evaluate((sel) => document.querySelector(`.main-content ${sel}`)?.scrollIntoView({ block: 'center' }), markSel);
    await page.waitForTimeout(300);
    const scrollBeforeOpen = await readerScrollTop(page);
    expect(scrollBeforeOpen, 'precondition: reader scrolled down to the deep mark').toBeGreaterThan(50);

    navLog.length = 0;
    await page.evaluate((sel) => document.querySelector(`.main-content ${sel}`)?.click(), markSel);
    await page.waitForFunction(() => document.getElementById('hyperlit-container')?.classList.contains('open'), null, { timeout: 8000 });
    await page.waitForTimeout(400);
    expect(await visibleStack(page), 'container open after clicking the deep mark').toBeGreaterThanOrEqual(1);

    const markInView = () => page.evaluate((sel) => {
      const m = document.querySelector(`.main-content ${sel}`);
      const r = m?.getBoundingClientRect();
      return { found: !!m, top: r?.top, inViewport: !!r && r.top >= -50 && r.top < window.innerHeight - 50 };
    }, markSel);

    // ── same-book FORWARD restore: goBack (close) → goForward (restore) ──
    navLog.length = 0;
    await page.goBack();
    await page.waitForFunction(() => !document.getElementById('hyperlit-container')?.classList.contains('open'), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.goForward();
    await page.waitForFunction(() => document.getElementById('hyperlit-container')?.classList.contains('open'), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);

    const stack = await visibleStack(page);
    const view = await markInView();
    const top = await readerScrollTop(page);
    dumpNav('after goForward restore (big book)');
    console.log('RESTORE probe:', JSON.stringify(view), 'scrollTop=', top, 'scrollBeforeOpen=', scrollBeforeOpen, 'stack=', stack);

    expect(stack, 'container should be open after forward restore').toBeGreaterThanOrEqual(1);
    expect(view.found, 'the deep mark should be present (its chunk loaded) after restore').toBe(true);
    expect(view.inViewport, `forward restore landed at the TOP, not the deep anchor (markTop=${view.top}, scrollTop=${top})`).toBe(true);

    // ── FULL restore from a FRESH LOAD (the real failure surface) ──
    // A reload rebuilds the container from history.state.containerStack AND re-renders the reader
    // from scratch — so the deep anchor's chunk is NOT in the DOM. restoreContainerStack must
    // resolve+load that chunk before scrolling. This is where a big book lands at the top.
    navLog.length = 0;
    await page.reload();
    await page.waitForFunction(() => document.getElementById('hyperlit-container')?.classList.contains('open'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000); // let chunk resolve/load + reposition settle

    const stack2 = await visibleStack(page);
    const view2 = await markInView();
    const top2 = await readerScrollTop(page);
    dumpNav('after FRESH-LOAD restore (big book, deep anchor not preloaded)');
    console.log('RELOAD probe:', JSON.stringify(view2), 'scrollTop=', top2, 'stack=', stack2);

    expect(stack2, 'container should be open after fresh-load restore').toBeGreaterThanOrEqual(1);
    expect(view2.found, 'the deep mark should be present (its chunk loaded) after fresh-load restore').toBe(true);
    expect(view2.inViewport, `fresh-load restore landed at the TOP, not the deep anchor (markTop=${view2.top}, scrollTop=${top2})`).toBe(true);
  });
});
