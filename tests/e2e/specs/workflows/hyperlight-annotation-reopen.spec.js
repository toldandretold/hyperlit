/**
 * Regression: reopening a highlight whose annotation is EMPTY must still mount
 * the annotation sub-book editor (.sub-book-content) so the container's edit
 * pencil gives the owner something to type into.
 *
 * Manual-QA failure this pins: create a highlight, write nothing, close, reopen
 * the container from the mark an hour later, click the container edit pencil —
 * the .highlight-annotation div was empty (no .sub-book-content mounted), so
 * there was nowhere to write. loadSubBook() is supposed to create the div
 * unconditionally; its absence means the postOpen load path skipped or threw.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { findParagraphByText, waitForCloudGreen } from '../../helpers/pageVerifiers.js';

test.describe('hyperlight annotation reopen', () => {
  test('empty-annotation highlight reopens with a writable annotation editor', async ({ page, spa }) => {
    test.setTimeout(120_000);

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // ── Create a book with content (same real-gesture path as the grand tour) ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.getElementById('newBookButton')?.click());
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('createNewBook')?.click());
    await spa.waitForTransition(page);
    await spa.waitForEditMode(page);

    const bookId = await spa.getCurrentBookId(page);
    expect(bookId).toMatch(/^book_\d+$/);

    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Annotation Reopen Test');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('Some source text we will highlight but not annotate.');
    await page.waitForTimeout(500);

    // ── Highlight with NO annotation ──
    const sel = await findParagraphByText(page, 'source text');
    expect(sel).not.toBeNull();
    const text = await page.locator(sel).textContent();
    const start = text.indexOf('highlight');
    await spa.selectTextInElement(page, sel, start, start + 'highlight'.length);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hyperlight');
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });

    // Creation mounts the sub-book editor (mode 'create'). Type NOTHING in it.
    await page.waitForSelector('#hyperlit-container .highlight-annotation .sub-book-content', { timeout: 8000 });

    await spa.closeHyperlitContainer(page);
    await waitForCloudGreen(page);

    // Exit main edit mode — the reopen below happens in plain read mode.
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // ── Reopen from the mark (the manual-QA path) ──
    await page.click('.main-content mark.user-highlight, .main-content mark.highlight');
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });

    // THE regression assertion: the annotation editor must be mounted even though
    // the annotation is empty — loadSubBook creates .sub-book-content always.
    await page.waitForSelector('#hyperlit-container .highlight-annotation .sub-book-content', { timeout: 8000 });

    // ── Enter container edit mode via the pencil and actually WRITE ──
    await page.click('#hyperlit-container .hyperlit-edit-btn');
    await page.waitForFunction(() => {
      const el = document.querySelector('#hyperlit-container .sub-book-content');
      return el && el.getAttribute('contenteditable') === 'true';
    }, null, { timeout: 5000 });

    // The pencil must be IN SYNC with the flag: on reopen the container is in
    // read mode, so one click ENTERS edit (the leaked-flag bug made it exit).
    await page.waitForFunction(() => {
      const btn = document.querySelector('#hyperlit-container .hyperlit-edit-btn');
      return btn && btn.classList.contains('inverted');
    }, null, { timeout: 5000 });

    await page.click('#hyperlit-container .sub-book-content p');
    await page.keyboard.type('typed after reopen');
    await page.waitForTimeout(300);
    const typed = await page.evaluate(() =>
      document.querySelector('#hyperlit-container .sub-book-content')?.textContent || '');
    expect(typed).toContain('typed after reopen');

    // Exit container edit mode cleanly, then close.
    await page.click('#hyperlit-container .hyperlit-edit-btn');
    await page.waitForFunction(() => {
      const btn = document.querySelector('#hyperlit-container .hyperlit-edit-btn');
      return btn && !btn.classList.contains('inverted');
    }, null, { timeout: 10000 });
    await spa.closeHyperlitContainer(page);
    await waitForCloudGreen(page);

    // ── Variant: FULL RELOAD (the "came back an hour later" state — preview_nodes
    // path, module flags reset), reopen from the mark, pencil, write again. ──
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.click('.main-content mark.user-highlight, .main-content mark.highlight');
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });
    await page.waitForSelector('#hyperlit-container .highlight-annotation .sub-book-content', { timeout: 8000 });

    await page.click('#hyperlit-container .hyperlit-edit-btn');
    await page.waitForFunction(() => {
      const btn = document.querySelector('#hyperlit-container .hyperlit-edit-btn');
      const el = document.querySelector('#hyperlit-container .sub-book-content');
      return btn?.classList.contains('inverted') && el?.getAttribute('contenteditable') === 'true';
    }, null, { timeout: 5000 });
    await page.click('#hyperlit-container .sub-book-content p');
    await page.keyboard.type('and after reload');
    await page.waitForTimeout(300);
    const typedAfterReload = await page.evaluate(() =>
      document.querySelector('#hyperlit-container .sub-book-content')?.textContent || '');
    expect(typedAfterReload).toContain('and after reload');

    // postOpen must not have swallowed an exception on any reopen path.
    const postOpenErrors = consoleErrors.filter((e) => e.includes('Error in highlight post-actions'));
    expect(postOpenErrors, `postOpen threw: ${postOpenErrors.join(' | ')}`).toHaveLength(0);
  });

  test('never-typed highlight survives a fresh-IDB reopen (server-pull state)', async ({ page, spa }) => {
    // The manual-QA state that the first test misses: the annotation was NEVER
    // typed into (sub-book library timestamp stays 0 — no node save ever bumped
    // it), and the user comes back on a fresh device/day: IDB is rebuilt from the
    // server pull (hyperlight record with preview_nodes; NO local sub-book nodes,
    // NO local sub-book library row). Reopen must still mount the annotation
    // editor and let the owner write.
    test.setTimeout(120_000);

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // ── Create book + highlight, type NOTHING anywhere near the annotation ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.getElementById('newBookButton')?.click());
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('createNewBook')?.click());
    await spa.waitForTransition(page);
    await spa.waitForEditMode(page);
    const bookId = await spa.getCurrentBookId(page);

    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Fresh IDB Reopen Test');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('Source text we highlight and never annotate.');
    await page.waitForTimeout(500);

    const sel = await findParagraphByText(page, 'Source text');
    const text = await page.locator(sel).textContent();
    const start = text.indexOf('highlight');
    await spa.selectTextInElement(page, sel, start, start + 'highlight'.length);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hyperlight');
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });
    await page.waitForSelector('#hyperlit-container .highlight-annotation .sub-book-content', { timeout: 8000 });
    await spa.closeHyperlitContainer(page);
    await waitForCloudGreen(page);
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // ── Simulate "fresh device / next day": wipe IDB, full reload → server pull ──
    await page.evaluate(() => new Promise((res) => {
      const req = indexedDB.deleteDatabase('MarkdownDB');
      // onblocked is fine — open connections release on the navigation below and
      // the pending delete then completes before the new page reopens the DB.
      req.onsuccess = req.onerror = req.onblocked = () => res(undefined);
    }));
    await page.goto(`/${bookId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.main-content mark.user-highlight, .main-content mark.highlight', { timeout: 10000 });

    // ── Reopen from the mark: the annotation editor must mount from preview_nodes ──
    await page.click('.main-content mark.user-highlight, .main-content mark.highlight');
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });
    await page.waitForSelector('#hyperlit-container .highlight-annotation .sub-book-content', { timeout: 8000 });

    // ── Pencil → write ──
    await page.click('#hyperlit-container .hyperlit-edit-btn');
    await page.waitForFunction(() => {
      const btn = document.querySelector('#hyperlit-container .hyperlit-edit-btn');
      const el = document.querySelector('#hyperlit-container .sub-book-content');
      return btn?.classList.contains('inverted') && el?.getAttribute('contenteditable') === 'true';
    }, null, { timeout: 5000 });
    await page.click('#hyperlit-container .sub-book-content p');
    await page.keyboard.type('written on a fresh device');
    await page.waitForTimeout(300);
    const typed = await page.evaluate(() =>
      document.querySelector('#hyperlit-container .sub-book-content')?.textContent || '');
    expect(typed).toContain('written on a fresh device');

    const postOpenErrors = consoleErrors.filter((e) => e.includes('Error in highlight post-actions'));
    expect(postOpenErrors, `postOpen threw: ${postOpenErrors.join(' | ')}`).toHaveLength(0);
  });

  test('arrow-nav (containerSwap) to a never-typed highlight mounts its annotation editor', async ({ page, spa }) => {
    // Third reopen path: the container's ↑/↓ arrows swap content IN PLACE via
    // containerSwap (buildUnifiedContent + handlePostOpenActions with
    // isContentSwap) — a different pipeline from a mark click. The manual-QA DOM
    // showed "1 / 3" arrows, so the failing highlight may have been reached this
    // way. Two highlights: open #2 from its mark, arrow back to #1 (never typed
    // into), and the annotation editor must mount and accept writing.
    test.setTimeout(120_000);

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.getElementById('newBookButton')?.click());
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('createNewBook')?.click());
    await spa.waitForTransition(page);
    await spa.waitForEditMode(page);

    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Arrow Nav Test');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('First target word here. Second target word there.');
    await page.waitForTimeout(500);

    const sel = await findParagraphByText(page, 'target word');
    const text = await page.locator(sel).textContent();

    const makeHighlight = async (needle) => {
      const at = text.indexOf(needle);
      expect(at).toBeGreaterThanOrEqual(0);
      await spa.selectTextInElement(page, sel, at, at + needle.length);
      await spa.waitForHyperlightButtons(page);
      await page.click('#copy-hyperlight');
      await page.waitForFunction(() => {
        const c = document.getElementById('hyperlit-container');
        return c && c.classList.contains('open');
      }, null, { timeout: 10000 });
      await page.waitForSelector('#hyperlit-container .highlight-annotation .sub-book-content', { timeout: 8000 });
      await spa.closeHyperlitContainer(page);
    };

    await makeHighlight('First target');
    await makeHighlight('Second target');
    await waitForCloudGreen(page);
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // Open the SECOND highlight from its mark…
    const marks = page.locator('.main-content mark.user-highlight, .main-content mark.highlight');
    await marks.nth(1).click();
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });
    await page.waitForSelector('#hyperlit-container .hyperlit-nav-prev:not([disabled])', { timeout: 8000 });

    // …then ARROW back to the first (containerSwap path).
    const firstHlId = await marks.nth(0).evaluate((el) =>
      [...el.classList].find((c) => c.startsWith('HL_')));
    await page.click('#hyperlit-container .hyperlit-nav-prev');
    await page.waitForFunction((hl) => {
      const section = document.querySelector('#hyperlit-container .highlights-section');
      return section && section.querySelector(`.author[id="author-${hl}"]`);
    }, firstHlId, { timeout: 8000 });

    // The swapped-in highlight must have its annotation editor mounted…
    await page.waitForSelector('#hyperlit-container .highlight-annotation .sub-book-content', { timeout: 8000 });

    // …and be writable via the pencil.
    await page.click('#hyperlit-container .hyperlit-edit-btn');
    await page.waitForFunction(() => {
      const btn = document.querySelector('#hyperlit-container .hyperlit-edit-btn');
      const el = document.querySelector('#hyperlit-container .sub-book-content');
      return btn?.classList.contains('inverted') && el?.getAttribute('contenteditable') === 'true';
    }, null, { timeout: 5000 });
    await page.click('#hyperlit-container .sub-book-content p');
    await page.keyboard.type('written after arrow swap');
    await page.waitForTimeout(300);
    const typed = await page.evaluate(() =>
      document.querySelector('#hyperlit-container .sub-book-content')?.textContent || '');
    expect(typed).toContain('written after arrow swap');

    const postOpenErrors = consoleErrors.filter((e) => e.includes('Error in highlight post-actions'));
    expect(postOpenErrors, `postOpen threw: ${postOpenErrors.join(' | ')}`).toHaveLength(0);
  });
});
