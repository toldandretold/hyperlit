import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Highlight nav (prev/next arrows) inside the hyperlit container.
 *
 * Creates a book with two highlighted paragraphs through real gestures, then:
 *  - clicking a mark shows .hyperlit-nav-arrows (own highlight, base layer)
 *  - ↓ swaps the container to the next highlight IN PLACE (no close/reopen,
 *    exactly one container in the DOM, URL hash tracks)
 *  - ↑ swaps back to the first highlight
 */
test.describe('Highlight nav arrows', () => {
  test('arrows render and navigate highlights in place', async ({ page, spa }) => {
    test.setTimeout(120_000);

    const consoleLog = [];
    page.on('console', (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`));

    // ── Create a book ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.click('#newBookButton');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');
    await spa.waitForTransition(page);
    await spa.waitForEditMode(page);

    // Verbose logging so highlightNav guard exits are visible in the console capture
    await page.evaluate(() => { try { window.logger?.enableVerbose?.(); } catch {} });

    // ── Type two paragraphs ──
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Nav Arrows Test');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.type('First paragraph with alpha target text inside it');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('Second paragraph with beta target text inside it');
    await page.waitForTimeout(600);

    const findParagraphByText = async (needle) => page.evaluate((t) => {
      const blocks = document.querySelectorAll('.main-content p');
      for (const b of blocks) {
        if (b.textContent.includes(t) && b.id) return `[id="${b.id}"]`;
      }
      return null;
    }, needle);

    // ── Highlight both phrases ──
    const makeHighlight = async (needle) => {
      const sel = await findParagraphByText(needle);
      expect(sel).not.toBeNull();
      const text = await page.locator(sel).textContent();
      const start = text.indexOf(needle);
      await spa.selectTextInElement(page, sel, start, start + needle.length);
      await spa.waitForHyperlightButtons(page);
      await page.click('#copy-hyperlight');
      await page.waitForFunction(() => {
        const c = document.getElementById('hyperlit-container');
        return c && c.classList.contains('open');
      }, null, { timeout: 10000 });
      await page.waitForTimeout(800); // postOpen deferred work
      await spa.closeHyperlitContainer(page);
      await page.waitForTimeout(500);
    };
    await makeHighlight('alpha target');
    await makeHighlight('beta target');

    // Wait for saves to settle
    await page.waitForTimeout(1500);

    // ── Click the FIRST mark (normal open path) ──
    await page.locator('.main-content mark').first().click();
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });
    await page.waitForTimeout(1200); // postOpen setTimeout(100) + dynamic import + IDB reads

    // Diagnostic dump regardless of outcome — reads every guard input directly
    const diag = await page.evaluate(async () => {
      const container = document.getElementById('hyperlit-container');
      const markCls = document.querySelector('.main-content mark')?.className || '';
      const hlId = markCls.split(' ').find((c) => c.startsWith('HL_')) || null;
      let record = null;
      if (hlId) {
        record = await new Promise((res) => {
          const req = indexedDB.open('MarkdownDB');
          req.onsuccess = () => {
            const db = req.result;
            const r = db.transaction('hyperlights').objectStore('hyperlights').index('hyperlight_id').get(hlId);
            r.onsuccess = () => res(r.result ? {
              book: r.result.book, creator: r.result.creator,
              creator_token: r.result.creator_token, is_user_highlight: r.result.is_user_highlight,
              startLine: r.result.startLine,
            } : null);
            r.onerror = () => res('ERR');
          };
          req.onerror = () => res('OPEN_ERR');
        });
      }
      return {
        arrows: !!container?.querySelector('.hyperlit-nav-arrows'),
        editBtn: !!container?.querySelector('.hyperlit-edit-btn'),
        mainId: document.querySelector('.main-content')?.id || null,
        markClasses: markCls,
        stackDepth: (history.state?.containerStack || []).length,
        stackTopTypes: (history.state?.containerStack || []).slice(-1)[0]?.contentMetadata?.contentTypes?.map((c) => c.type) || null,
        record,
        navDiag: window.__hlNavDiag || null,
      };
    });
    console.log('DIAG:', JSON.stringify(diag));
    console.log('RELEVANT CONSOLE:', consoleLog.filter((l) =>
      l.includes('highlightNav') || l.includes('[ERROR]') || l.includes('error')).slice(-25).join('\n'));

    expect(diag.arrows, `arrows missing; diag=${JSON.stringify(diag)}`).toBe(true);

    // ── ↓ arrow: swap in place ──
    await page.click('.hyperlit-nav-next');
    await page.waitForTimeout(1500);
    const afterNext = await page.evaluate(() => ({
      containers: document.querySelectorAll('#hyperlit-container, .hyperlit-container-stacked').length,
      open: document.getElementById('hyperlit-container')?.classList.contains('open'),
      hash: window.location.hash,
      quote: document.querySelector('#hyperlit-container .highlight-text, #hyperlit-container blockquote')?.textContent?.trim() || '',
    }));
    console.log('AFTER NEXT:', JSON.stringify(afterNext));
    expect(afterNext.open).toBe(true);
    expect(afterNext.containers).toBe(1);
    expect(afterNext.quote).toContain('beta target');

    // ── ↑ arrow: swap back to the first highlight ──
    await page.click('.hyperlit-nav-prev');
    await page.waitForTimeout(1500);
    const afterPrev = await page.evaluate(() => ({
      containers: document.querySelectorAll('#hyperlit-container, .hyperlit-container-stacked').length,
      open: document.getElementById('hyperlit-container')?.classList.contains('open'),
      quote: document.querySelector('#hyperlit-container .highlight-text, #hyperlit-container blockquote')?.textContent?.trim() || '',
    }));
    console.log('AFTER PREV:', JSON.stringify(afterPrev));
    expect(afterPrev.open).toBe(true);
    expect(afterPrev.containers).toBe(1);
    expect(afterPrev.quote).toContain('alpha target');
  });
});
