/**
 * Per-highlight visibility pill in a STACKED layer (highlight-in-a-highlight).
 *
 * Regression this pins: the pill's CSS was scoped to #hyperlit-container only,
 * so inside .hyperlit-container-stacked the dropdown rendered as an unstyled
 * inline row of always-checked buttons, and the click-catcher overlay was
 * appended to the BASE container underneath the layer being viewed. The flip's
 * data ops must also work at depth — the nested sub-book id takes the level-2
 * shape foundation/2/HL_parent/HL_child.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('nested highlight visibility', () => {
  test('the pill works inside a stacked layer (styled panel, layer-scoped overlay, real flip)', async ({ page, spa }) => {
    test.setTimeout(120_000);

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // ── Build the nest: book → highlight (L1) → highlight on its annotation (L2) ──
    await spa.createNewBook(page, spa);
    await page.click('h1[id="100"]');
    await page.keyboard.type('Nested Visibility Test');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.type('Base sentence to highlight for level one.');
    await page.waitForTimeout(400);

    await spa.selectInActiveEditor(page, 'highlight for');
    await spa.hyperlightSelection(page);           // L1 container opens, sub-book editable

    await spa.typeAtEndOfActiveEditor(page, 'Annotation body that will itself be highlighted.');
    await page.waitForTimeout(400);
    await spa.selectInActiveEditor(page, 'itself be');
    await spa.hyperlightSelection(page);           // L2 STACKED layer opens

    expect(await spa.getStackDepth(page)).toBeGreaterThanOrEqual(2);

    // ── The pill exists in the TOP stacked layer, born public ──
    const topLayer = page.locator('.hyperlit-container-stacked.open').last();
    const control = topLayer.locator('.hl-visibility-control');
    await expect(control).toHaveAttribute('data-state', 'public');

    // The nested highlight's data-book is the L1 sub-book id (contains a slash).
    const nested = await control.evaluate((el) => ({
      book: el.dataset.book, highlightId: el.dataset.highlightId,
    }));
    expect(nested.book).toContain('/');

    // ── Open the panel: styled dropdown + overlay scoped to THIS layer ──
    await control.locator('.visibility-trigger').click();
    await expect(control).toHaveClass(/vis-open/);
    const panelStyle = await control.locator('.visibility-panel').evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return { position: cs.position, display: cs.display };
    });
    // position:absolute proves the stacked-scope CSS applied (unstyled it was static/inline).
    expect(panelStyle.position).toBe('absolute');
    expect(panelStyle.display).toBe('block');
    // Only the ACTIVE option shows its checkmark (the "double ✓" regression).
    const checkOpacities = await control.locator('.visibility-option-check').evaluateAll(
      (els) => els.map((el) => window.getComputedStyle(el).opacity));
    expect(checkOpacities.filter((o) => o !== '0')).toHaveLength(1);
    // The click-catcher covers the stacked layer, not the base container beneath it.
    expect(await topLayer.locator(':scope > .visibility-overlay').count()).toBe(1);
    expect(await page.locator('#hyperlit-container > .visibility-overlay').count()).toBe(0);

    // ── Real flip to private (grace path covers a not-yet-synced row) ──
    await control.locator('.visibility-option[data-target="private"]').click();
    await expect(control).toHaveAttribute('data-state', 'private', { timeout: 10000 });
    await expect(control).not.toHaveClass(/vis-open/);

    // IDB mirror: the nested record carries sub_book_visibility=private.
    const idbVis = await page.evaluate(({ book, highlightId }) => new Promise((resolve) => {
      const req = indexedDB.open('MarkdownDB');
      req.onsuccess = () => {
        const db = req.result;
        const getReq = db.transaction('hyperlights', 'readonly')
          .objectStore('hyperlights').get([book, highlightId]);
        getReq.onsuccess = () => { db.close(); resolve(getReq.result?.sub_book_visibility ?? null); };
        getReq.onerror = () => { db.close(); resolve('idb-error'); };
      };
      req.onerror = () => resolve('idb-open-error');
    }), nested);
    expect(idbVis).toBe('private');

    // ── Flip back (both directions + resets the sticky default for later specs) ──
    await control.locator('.visibility-trigger').click();
    await expect(control).toHaveClass(/vis-open/);
    await control.locator('.visibility-option[data-target="public"]').click();
    await expect(control).toHaveAttribute('data-state', 'public', { timeout: 10000 });
    expect(await page.evaluate(() => localStorage.getItem('hyperlit_default_hl_visibility'))).toBe('public');

    // Unwind the nest cleanly.
    await spa.closeTopContainer(page);
    await spa.closeTopContainer(page);

    const visibilityErrors = consoleErrors.filter((e) =>
      e.includes('Highlight visibility change failed') || e.includes('Error in highlight post-actions'));
    expect(visibilityErrors, `errors: ${visibilityErrors.join(' | ')}`).toHaveLength(0);
  });
});
