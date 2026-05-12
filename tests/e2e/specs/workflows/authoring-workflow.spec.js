import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('Full authoring workflow', () => {
  test('create → edit → annotate → link → navigate → back/forward', async ({ page, spa }) => {
    test.setTimeout(120_000);

    // Shared state across phases
    let book1Id;
    let book2Id;
    let clipboardHtml;
    let clipboardText;
    let hyperciteId;

    // ──────────────────────────────────────────────────────────
    // Phase 1: Create Book 1 from Homepage
    // ──────────────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    // Open new-book container and create
    await page.click('#newBook');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');

    // Wait for SPA transition to the new book
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');

    // Book creation enters edit mode automatically
    await spa.waitForEditMode(page);

    // Capture book 1 ID
    book1Id = await spa.getCurrentBookId(page);
    expect(book1Id).toMatch(/^book_\d+$/);
    expect(page.url()).toContain(`/${book1Id}`);

    // Verify initial heading exists (numeric IDs need attribute selector)
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });

    // ──────────────────────────────────────────────────────────
    // Phase 2: Type Text
    // ──────────────────────────────────────────────────────────
    await page.click('h1[id="100"]');
    await page.keyboard.type('My Test Book');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.type('This is bold text and italic text and normal');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('Text for highlighting and hyperciting later');
    await page.waitForTimeout(500);

    // Assert title and paragraph content
    const h1Text = await page.locator('h1[id="100"]').textContent();
    expect(h1Text.trim()).toBe('My Test Book');

    const paragraphs = await page.locator('.main-content p').count();
    expect(paragraphs).toBeGreaterThanOrEqual(2);

    // ──────────────────────────────────────────────────────────
    // Phase 3: Edit Toolbar Formatting
    // ──────────────────────────────────────────────────────────

    // Helper: move cursor to end of the very last block element in document order
    const moveCursorToEnd = async () => {
      await page.evaluate(() => {
        const blocks = document.querySelectorAll('.main-content p, .main-content h1, .main-content h2, .main-content h3, .main-content h4, .main-content h5, .main-content h6, .main-content li, .main-content blockquote, .main-content pre');
        const lastBlock = blocks[blocks.length - 1];
        if (!lastBlock) return;
        const range = document.createRange();
        range.selectNodeContents(lastBlock);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        lastBlock.focus();
      });
    };

    // Helper: find a paragraph by its text content and return a selector
    const findParagraphByText = async (searchText) => {
      return page.evaluate((text) => {
        const blocks = document.querySelectorAll('.main-content p, .main-content h1, .main-content h2, .main-content h3, .main-content h4, .main-content h5, .main-content h6, .main-content li, .main-content blockquote');
        for (const el of blocks) {
          if (el.textContent.includes(text)) {
            if (el.id) return `${el.tagName.toLowerCase()}[id="${el.id}"]`;
            const tag = el.tagName.toLowerCase();
            const parent = el.parentElement;
            const siblings = parent.querySelectorAll(`:scope > ${tag}`);
            const idx = Array.from(siblings).indexOf(el);
            return `.main-content ${tag}:nth-of-type(${idx + 1})`;
          }
        }
        return null;
      }, searchText);
    };

    // Bold: select "bold text" in first <p>
    const firstP = '.main-content p:first-of-type';
    const firstPText = await page.locator(firstP).textContent();
    const boldStart = firstPText.indexOf('bold text');
    expect(boldStart).toBeGreaterThanOrEqual(0);
    await spa.selectTextInElement(page, firstP, boldStart, boldStart + 'bold text'.length);
    await page.click('#boldButton');
    await page.waitForTimeout(300);
    const hasBold = await page.locator(`${firstP} strong, ${firstP} b`).count();
    expect(hasBold).toBeGreaterThanOrEqual(1);

    // Italic: select "italic text" in first <p>
    const firstPText2 = await page.locator(firstP).textContent();
    const italicStart = firstPText2.indexOf('italic text');
    expect(italicStart).toBeGreaterThanOrEqual(0);
    await spa.selectTextInElement(page, firstP, italicStart, italicStart + 'italic text'.length);
    await page.click('#italicButton');
    await page.waitForTimeout(300);
    const hasItalic = await page.locator(`${firstP} em, ${firstP} i`).count();
    expect(hasItalic).toBeGreaterThanOrEqual(1);

    // Move cursor to end before typing new blocks
    await moveCursorToEnd();
    await page.waitForTimeout(200);

    // Heading: type text on new line, then convert to h2
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type('Heading text');
    await page.waitForTimeout(200);
    await page.click('#headingButton');
    await page.waitForSelector('#heading-submenu:not(.hidden)', { timeout: 3000 });
    await page.click('[data-heading="h2"]');
    await page.waitForTimeout(300);
    const hasH2 = await page.locator('.main-content h2').count();
    expect(hasH2).toBeGreaterThanOrEqual(1);

    // Blockquote: type text on new line, then convert to blockquote
    await moveCursorToEnd();
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type('Quote text');
    await page.waitForTimeout(200);
    await page.click('#blockquoteButton');
    await page.waitForSelector('#blockquote-submenu:not(.hidden)', { timeout: 3000 });
    await page.click('[data-block-type="blockquote"]');
    await page.waitForTimeout(300);
    const hasBlockquote = await page.locator('.main-content blockquote').count();
    expect(hasBlockquote).toBeGreaterThanOrEqual(1);

    // List: type text on new line, then convert to ul
    await moveCursorToEnd();
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type('List item');
    await page.waitForTimeout(200);
    await page.click('#blockquoteButton');
    await page.waitForSelector('#blockquote-submenu:not(.hidden)', { timeout: 3000 });
    await page.click('[data-block-type="ul"]');
    await page.waitForTimeout(300);
    const hasUl = await page.locator('.main-content ul').count();
    expect(hasUl).toBeGreaterThanOrEqual(1);

    // ──────────────────────────────────────────────────────────
    // Phase 4: Create Highlight
    // ──────────────────────────────────────────────────────────

    // Exit list context and position at the very end
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await moveCursorToEnd();
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    await page.keyboard.type('This paragraph will be highlighted for annotation');
    await page.waitForTimeout(500);

    // Find the element containing highlight text by searching all blocks
    const hlSelector = await findParagraphByText('highlighted for annotation');
    expect(hlSelector).not.toBeNull();
    const hlText = await page.locator(hlSelector).textContent();
    const hlStart = hlText.indexOf('highlighted for annotation');
    expect(hlStart).toBeGreaterThanOrEqual(0);
    await spa.selectTextInElement(page, hlSelector, hlStart, hlStart + 'highlighted for annotation'.length);

    // Wait for hyperlight buttons to appear
    await spa.waitForHyperlightButtons(page);

    // Click highlight button
    await page.click('#copy-hyperlight');

    // Wait for hyperlit container to open
    await page.waitForFunction(() => {
      const container = document.getElementById('hyperlit-container');
      return container && container.classList.contains('open');
    }, null, { timeout: 10000 });

    // Assert highlight mark exists
    const hasHighlightMark = await page.locator('.main-content mark.user-highlight, .main-content mark.highlight').count();
    expect(hasHighlightMark).toBeGreaterThanOrEqual(1);

    // Close the hyperlit container
    await spa.closeHyperlitContainer(page);

    // Verify container is closed
    const containerClosed = await page.evaluate(() => {
      const container = document.getElementById('hyperlit-container');
      return container && !container.classList.contains('open');
    });
    expect(containerClosed).toBe(true);

    // ──────────────────────────────────────────────────────────
    // Phase 5: Create Hypercite (Copy)
    // ──────────────────────────────────────────────────────────

    // Type new paragraph for hypercite source
    await moveCursorToEnd();
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('This is the quoted source text for hypercite');
    await page.waitForTimeout(500);

    // Find the element containing hypercite text
    const hcSelector = await findParagraphByText('quoted source text');
    expect(hcSelector).not.toBeNull();
    const hpText = await page.locator(hcSelector).textContent();
    const hcStart = hpText.indexOf('quoted source text');
    expect(hcStart).toBeGreaterThanOrEqual(0);
    await spa.selectTextInElement(page, hcSelector, hcStart, hcStart + 'quoted source text'.length);

    // Wait for hyperlight buttons
    await spa.waitForHyperlightButtons(page);

    // Click copy-hypercite button
    await page.click('#copy-hypercite');
    await page.waitForTimeout(500);

    // Assert hypercite <u> element exists in DOM
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 5000 });

    // Capture hypercite data from DOM for later paste
    const hyperciteData = await page.evaluate(() => {
      const uEl = document.querySelector('u[id^="hypercite_"].single');
      if (!uEl) return null;
      const hcId = uEl.id;
      const bookId = window.book || document.querySelector('.main-content')?.id;
      const selectedText = uEl.textContent;
      const origin = window.location.origin;
      const href = `${origin}/${bookId}#${hcId}`;
      const html = `'${selectedText}'\u2060<a href="${href}" id="${hcId}" class="open-icon">↗</a>`;
      const text = `'${selectedText}' [↗](${href})`;
      return { hyperciteId: hcId, bookId, clipboardHtml: html, clipboardText: text };
    });

    expect(hyperciteData).not.toBeNull();
    hyperciteId = hyperciteData.hyperciteId;
    clipboardHtml = hyperciteData.clipboardHtml;
    clipboardText = hyperciteData.clipboardText;
    expect(hyperciteId).toMatch(/^hypercite_/);

    // ──────────────────────────────────────────────────────────
    // Phase 6: Navigate to Homepage
    // ──────────────────────────────────────────────────────────

    // Wait for book 1 to sync (green cloud indicator or generous timeout)
    try {
      await page.waitForFunction(() => {
        const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
        return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
      }, null, { timeout: 5000 });
    } catch {
      // Fallback: just wait a generous amount for sync
      await page.waitForTimeout(3000);
    }

    await spa.navigateToHome(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('home');

    // ──────────────────────────────────────────────────────────
    // Phase 7: Create Book 2
    // ──────────────────────────────────────────────────────────
    await page.click('#newBook');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');

    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');
    await spa.waitForEditMode(page);

    book2Id = await spa.getCurrentBookId(page);
    expect(book2Id).toMatch(/^book_\d+$/);
    expect(book2Id).not.toBe(book1Id);

    // Type content in Book 2
    await page.click('h1[id="100"]');
    await page.keyboard.type('Second Book');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('Paste point: ');
    await page.waitForTimeout(500);

    // ──────────────────────────────────────────────────────────
    // Phase 8: Paste Hypercite
    // ──────────────────────────────────────────────────────────

    // Dispatch synthetic paste event
    await spa.pasteHyperciteContent(page, clipboardHtml, clipboardText);

    // Wait for paste handler to process
    await page.waitForTimeout(2000);

    // Assert hypercite link exists in book 2
    await page.waitForSelector('a.open-icon[id^="hypercite_"]', { timeout: 10000 });

    const pastedLink = await page.evaluate(() => {
      const link = document.querySelector('a.open-icon[id^="hypercite_"]');
      if (!link) return null;
      return {
        text: link.textContent.trim(),
        href: link.getAttribute('href'),
        id: link.id,
      };
    });

    expect(pastedLink).not.toBeNull();
    expect(pastedLink.text).toBe('↗');
    expect(pastedLink.href).toContain(book1Id);
    expect(pastedLink.href).toContain(hyperciteId);

    // Verify quoted text appears in the paragraph
    const pastedParagraphText = await page.locator('.main-content p:last-of-type').textContent();
    expect(pastedParagraphText).toContain('quoted source text');

    // ──────────────────────────────────────────────────────────
    // Phase 9: Click Hypercite → Navigate to Book 1
    // ──────────────────────────────────────────────────────────

    // Exit edit mode — clicking <a> in contenteditable may just place cursor
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // Wait for book 2 sync before leaving
    try {
      await page.waitForFunction(() => {
        const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
        return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
      }, null, { timeout: 5000 });
    } catch {
      await page.waitForTimeout(3000);
    }

    // Click the hypercite ↗ link — this opens the reference panel
    await page.click('a.open-icon[id^="hypercite_"]');

    // Wait for the hyperlit container to open with the reference
    await page.waitForFunction(() => {
      const container = document.getElementById('hyperlit-container');
      return container && container.classList.contains('open');
    }, null, { timeout: 10000 });

    // Click "See in source text" to navigate to book 1
    await page.getByText('See in source text').click();

    // Wait for SPA transition to book 1
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('reader');
    const currentBookAfterNav = await spa.getCurrentBookId(page);
    expect(currentBookAfterNav).toBe(book1Id);
    expect(page.url()).toContain(book1Id);

    // ──────────────────────────────────────────────────────────
    // Phase 10: Back/Forward Navigation
    // ──────────────────────────────────────────────────────────

    // Go back to book 2
    await page.goBack();
    await spa.waitForTransition(page);
    const bookAfterBack = await spa.getCurrentBookId(page);
    expect(bookAfterBack).toBe(book2Id);
    expect(page.url()).toContain(book2Id);

    // Go forward to book 1
    await page.goForward();
    await spa.waitForTransition(page);
    const bookAfterForward = await spa.getCurrentBookId(page);
    expect(bookAfterForward).toBe(book1Id);
    expect(page.url()).toContain(book1Id);

    // Health check and registry check on final reader page
    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);
    await spa.assertRegistryHealthy(page, 'reader');

    // Assert no unfiltered console errors
    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});
