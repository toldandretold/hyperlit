import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * File-import drag-and-drop workflow.
 *
 * Exercises:
 *   - Page-level drop overlay registration via buttonRegistry
 *   - Synthetic file drop via DataTransfer (the same path an OS drag triggers)
 *   - Auto-open of the import form with the dropped file pre-attached
 *   - Inline dropzone "File ready" green state
 *   - Form submission → SPA transition to the imported book's reader page
 *   - Post-import editing (matches the patterns used by authoring-workflow.spec.js)
 *   - SPA navigation back to home → drop target re-initializes cleanly
 *   - Suppression of the page-level overlay while the form is already open
 *   - Reader pages do not register the drop target (registry filtering works)
 */

/**
 * Dispatch a synthetic file drop on the window. Mirrors what an OS file drag
 * triggers — the same dataTransfer.types/files surface that our window listeners
 * read in homepageDropTarget.js.
 */
async function dropFileOnWindow(page, { name, type, content }) {
  await page.evaluate(({ name, type, content }) => {
    const dt = new DataTransfer();
    const file = new File([content], name, { type });
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('dragover',  { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop',      { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { name, type, content });
}

const SAMPLE_MD = `# Drag Drop Test Book

This paragraph was created via the e2e drag-and-drop import test.

A second paragraph for content.
`;

test.describe('File import via drag-and-drop (SPA flow)', () => {
  test('drop .md on home → import → edit → home → drop target re-inits', async ({ page, spa }) => {
    test.setTimeout(180_000);

    // ──────────────────────────────────────────────────────────
    // Phase 1: Home loads, drop target is registered
    // ──────────────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    let registry = await spa.getRegistryStatus(page);
    expect(registry?.activeComponents).toContain('homepageDropTarget');

    // Overlay element exists but is hidden by default
    const overlayInitiallyHidden = await page.evaluate(() => {
      const el = document.getElementById('page-drop-overlay');
      return el && window.getComputedStyle(el).display === 'none';
    });
    expect(overlayInitiallyHidden).toBe(true);

    // ──────────────────────────────────────────────────────────
    // Phase 2: Drop a .md file via synthetic DataTransfer
    // ──────────────────────────────────────────────────────────
    await dropFileOnWindow(page, {
      name: 'drag-drop-test.md',
      type: 'text/markdown',
      content: SAMPLE_MD,
    });

    // Form opens (the click on #importBook is fired internally by handleAcceptedDrop)
    await page.waitForSelector('#cite-form', { timeout: 10000 });

    // File landed in the input
    const attachedName = await page.evaluate(() => {
      const input = document.getElementById('markdown_file');
      return input && input.files && input.files[0] ? input.files[0].name : null;
    });
    expect(attachedName).toBe('drag-drop-test.md');

    // Inline dropzone reflects the file-ready state
    await page.waitForFunction(() => {
      const text = document.getElementById('markdown-file-dropzone')?.textContent || '';
      return text.includes('File ready') && text.includes('drag-drop-test.md');
    }, null, { timeout: 5000 });

    // Page-level overlay is hidden (we're past the drag, in the form now)
    const overlayHiddenPostDrop = await page.evaluate(() => {
      const el = document.getElementById('page-drop-overlay');
      return !el || window.getComputedStyle(el).display === 'none';
    });
    expect(overlayHiddenPostDrop).toBe(true);

    // ──────────────────────────────────────────────────────────
    // Phase 3: Submit the import form → SPA transition to reader
    // ──────────────────────────────────────────────────────────
    await page.click('#createButton');

    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');

    const importedBookId = await spa.getCurrentBookId(page);
    expect(importedBookId).toBeTruthy();
    expect(page.url()).toContain(`/${importedBookId}`);

    // Imported content rendered
    await page.waitForSelector('.main-content', { timeout: 10000 });
    const renderedText = await page.locator('.main-content').textContent();
    expect(renderedText).toContain('drag-and-drop import test');

    // ──────────────────────────────────────────────────────────
    // Phase 4: Post-import edit — same shape as authoring-workflow does
    // after creating a new book (proves both pathways converge cleanly)
    // ──────────────────────────────────────────────────────────
    // Enter edit mode (imports don't auto-enter; click the edit button)
    const inEditMode = await page.evaluate(() => !!window.isEditing);
    if (!inEditMode) {
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === true, null, { timeout: 5000 });
    }

    // Move cursor to end of the document and type a new paragraph
    await page.evaluate(() => {
      const blocks = document.querySelectorAll('.main-content p, .main-content h1, .main-content h2, .main-content h3, .main-content h4, .main-content h5, .main-content h6, .main-content li, .main-content blockquote');
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
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Added by the drag-drop e2e test');
    await page.waitForTimeout(500);

    // Wait for the cloud-sync indicator to go green (best effort — fall back
    // to a generous timeout if the icon class isn't immediately readable).
    try {
      await page.waitForFunction(() => {
        const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
        return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
      }, null, { timeout: 8000 });
    } catch {
      await page.waitForTimeout(3000);
    }

    // Exit edit mode — this is the path that fires the integrity verifier on save
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // ──────────────────────────────────────────────────────────
    // Phase 5: Navigate home → drop target re-initialises
    // ──────────────────────────────────────────────────────────
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('home');

    registry = await spa.getRegistryStatus(page);
    expect(registry?.activeComponents).toContain('homepageDropTarget');

    // Overlay element is fresh (not the leftover from before navigation) and hidden
    const freshOverlayHidden = await page.evaluate(() => {
      const el = document.getElementById('page-drop-overlay');
      return el && window.getComputedStyle(el).display === 'none';
    });
    expect(freshOverlayHidden).toBe(true);

    // ──────────────────────────────────────────────────────────
    // Phase 6: SPA + console health on final state
    // ──────────────────────────────────────────────────────────
    spa.assertHealthy(await spa.healthCheck(page));
    await spa.assertRegistryHealthy(page, 'home');
    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('drop while import form already open → page-level overlay stays hidden', async ({ page, spa }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    // Open the import form via the button (NOT via drop). The perimeter button
    // can be off-viewport on the home page, so click it programmatically — same
    // path our drop handler uses internally.
    await page.evaluate(() => document.getElementById('importBook')?.click());
    await page.waitForSelector('#cite-form', { timeout: 5000 });

    // Drop a file on window — overlay should NOT appear because the form is open;
    // the file should still attach to the form's existing input as a convenience.
    await dropFileOnWindow(page, {
      name: 'while-form-open.md',
      type: 'text/markdown',
      content: '# Test\n\nForm-open drop.',
    });

    // Overlay never flips to display: flex
    const overlayHidden = await page.evaluate(() => {
      const el = document.getElementById('page-drop-overlay');
      return !el || window.getComputedStyle(el).display === 'none';
    });
    expect(overlayHidden).toBe(true);

    // File auto-attached to existing input
    await page.waitForFunction(() => {
      const input = document.getElementById('markdown_file');
      return input && input.files && input.files[0] && input.files[0].name === 'while-form-open.md';
    }, null, { timeout: 3000 });

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('reader page does not register drop target', async ({ page, spa }) => {
    const bookSlug = process.env.E2E_READER_BOOK;
    test.skip(!bookSlug, 'E2E_READER_BOOK not set in .env.e2e');
    test.setTimeout(60_000);

    await page.goto(`/${bookSlug}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    // Registry filter prevents homepageDropTarget from being active
    const registry = await spa.getRegistryStatus(page);
    expect(registry?.activeComponents || []).not.toContain('homepageDropTarget');

    // No overlay element exists in the DOM
    const overlayPresent = await page.evaluate(() => !!document.getElementById('page-drop-overlay'));
    expect(overlayPresent).toBe(false);

    // A drop on window does nothing visible — no overlay flashes into existence
    await dropFileOnWindow(page, {
      name: 'reader-drop.md',
      type: 'text/markdown',
      content: '# Should be ignored',
    });

    const overlayStillAbsent = await page.evaluate(() => !!document.getElementById('page-drop-overlay'));
    expect(overlayStillAbsent).toBe(false);

    // Form must NOT have opened either
    const formExists = await page.evaluate(() => !!document.getElementById('cite-form'));
    expect(formExists).toBe(false);

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});
