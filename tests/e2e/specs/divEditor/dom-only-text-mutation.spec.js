/**
 * Regression test for the 2026-08-25 Safari autocorrect MISMATCH/self-heal
 * (book_1787617675521, node 407, "origianl"→"original").
 *
 * A text mutation that fires NO `input` event (Safari autocorrect, spelling
 * panel, or this test's direct textNode.data assignment) used to bypass the
 * debounced input pipeline entirely: the DOM diverged from IndexedDB and only
 * the periodic integrity scanner noticed, 30s later. The fix pairs characterData
 * back into the MutationObserver (deduped per batch) plus a `textInput` listener.
 *
 * This spec mutates a node's text WITHOUT dispatching input, then asserts the
 * change was saved to the database — i.e., it reaches the save queue on its own,
 * without the integrity self-heal's help.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('divEditor — DOM-only text mutation (autocorrect channel)', () => {
  test('a textNode mutation with no input event is saved to IndexedDB/server on its own', async ({ page, spa }) => {
    test.setTimeout(90_000);

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
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });

    // Create a paragraph the normal way so it has a real node record.
    await page.click('h1[id="100"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('origianl paragraph');
    // Long enough for the typed edit to be persisted before we mutate.
    await page.waitForTimeout(2500);

    const nodeId = await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('.main-content p'))
        .find(el => el.textContent.includes('origianl'));
      return p ? p.id : null;
    });
    expect(nodeId).not.toBeNull();

    // Simulate the autocorrect seam: mutate the text node DIRECTLY and do NOT
    // dispatch an input event. This is exactly what Safari's spelling panel does.
    await page.evaluate((id) => {
      const p = document.getElementById(id);
      const tn = Array.from(p.childNodes).find(n =>
        n.nodeType === Node.TEXT_NODE && n.textContent.includes('origianl'));
      if (!tn) throw new Error('text node not found');
      tn.data = tn.data.replace('origianl', 'original');
    }, nodeId);

    // The save pipeline is debounced (~1.5s+). Wait long enough for the
    // characterData catch-all to queue the edit and flush it to IndexedDB,
    // but NOT long enough for the 30s periodic full-book scan to self-heal —
    // the point is that the change got in through the front door.
    await page.waitForTimeout(2500);

    // Browser navigation flushes pending saves at the boundary, then the reload
    // renders from the persisted source of truth (server first, IDB fallback).
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {}); // reload may land directly in reader

    const persistedText = await page.evaluate((id) => {
      const el = document.getElementById(id);
      return el ? el.textContent : null;
    }, nodeId);

    expect(persistedText).not.toBeNull();
    expect(persistedText).toContain('original paragraph');
    expect(persistedText).not.toContain('origianl paragraph');
  });
});
