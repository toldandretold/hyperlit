/**
 * Regression tests for the 2026-05-12 integrity-mismatch incident
 * (book_1778018575873, duplicate id 6498.1).
 *
 * Two independent code paths were involved:
 *
 *   Bug A — `generateIdBetween` in utilities/IDfunctions.js had CASE 3/4
 *           branches that returned `${beforeNum}.1` for integer-gap-1
 *           neighbors without checking `isIdInUse`, so a new node could be
 *           minted with an id that already existed in the DOM.
 *
 *   Bug B — A verbatim `<p>` duplicate (same data-node-id, same innerHTML)
 *           appeared adjacent to its original. Self-healing was added to
 *           saveQueue's periodic full-scan via `findVerbatimDuplicates`.
 *
 * These tests drive the editor end-to-end and assert the observable
 * outcomes — no test-only hooks in production code.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('divEditor — id collision handling', () => {
  test('Enter between consecutive integer ids does not mint a duplicate decimal id', async ({ page, spa }) => {
    test.setTimeout(60_000);

    // Create a fresh book — book creation enters edit mode automatically.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    await page.click('#newBook');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');

    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');
    await spa.waitForEditMode(page);
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });

    // Seed the DOM with the exact shape that exposed Bug A:
    //   <p id="6498">…</p><p id="6499">…</p>   ← adjacent integer siblings
    //   <p id="6498.1">collider</p>            ← already-in-use decimal id
    //
    // Bug A: Enter at the end of #6498 would generate id "6498.1" via
    //        generateIdBetween's CASE 3 (gap === 1), colliding with the
    //        already-present `<p id="6498.1">`.
    await page.evaluate(() => {
      const chunk = document.querySelector('.main-content .chunk');
      if (!chunk) throw new Error('No .chunk found in .main-content');
      const mk = (id, text) => {
        const p = document.createElement('p');
        p.id = id;
        p.setAttribute('data-node-id', `test_${id.replace('.', '_')}_${Date.now()}`);
        p.textContent = text;
        return p;
      };
      chunk.appendChild(mk('6498', 'six four nine eight'));
      chunk.appendChild(mk('6499', 'six four nine nine'));
      chunk.appendChild(mk('6498.1', 'collider'));
    });

    // Sanity: exactly one element has id "6498.1" before the Enter.
    expect(await page.locator('[id="6498.1"]').count()).toBe(1);

    // Place the caret at the end of #6498 and press Enter.
    await page.evaluate(() => {
      const target = document.querySelector('[id="6498"]');
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      target.focus();
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    // After the fix, the new paragraph must NOT have id "6498.1" — the
    // collider count stays at 1, and the new paragraph (immediately after
    // #6498) carries a fresh non-colliding id.
    expect(await page.locator('[id="6498.1"]').count()).toBe(1);

    const newNodeId = await page.evaluate(() => {
      const ref = document.querySelector('[id="6498"]');
      return ref?.nextElementSibling?.id || null;
    });
    expect(newNodeId).not.toBeNull();
    expect(newNodeId).not.toBe('6498.1');
    // Sanity: the new id is still in the 6498.x family — generateIdBetween
    // should have produced something like "6498.11" via CASE 1 after the
    // recursive call.
    expect(newNodeId).toMatch(/^6498\.\d+$/);
  });

  test('verbatim DOM duplicate is removed when exiting edit mode', async ({ page, spa }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.click('#newBook');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');

    await spa.waitForTransition(page);
    await spa.waitForEditMode(page);
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });

    // Create a real paragraph the normal way so it owns a real data-node-id.
    await page.click('h1[id="100"]');
    await page.keyboard.type('A test title');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('A paragraph to be cloned');
    await page.waitForTimeout(1500);

    // Snapshot the paragraph's data-node-id.
    const originalNodeId = await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('.main-content p'))
        .find(el => el.textContent.includes('paragraph to be cloned'));
      return p?.getAttribute('data-node-id') || null;
    });
    expect(originalNodeId).not.toBeNull();

    // Inject a verbatim duplicate: same data-node-id, identical innerHTML,
    // identical DOM id. This mirrors the 2026-05-12 incident shape.
    await page.evaluate((dataNodeId) => {
      const original = document.querySelector(`[data-node-id="${dataNodeId}"]`);
      if (!original) throw new Error('original not found');
      const clone = original.cloneNode(true);
      clone.id = original.id;
      original.after(clone);
    }, originalNodeId);

    expect(await page.locator(`[data-node-id="${originalNodeId}"]`).count()).toBe(2);

    // Exit edit mode by clicking #editButton — this runs the integrity
    // verification path which now self-heals verbatim duplicates first.
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 10_000 });

    // Self-heal should have removed the duplicate immediately.
    expect(await page.locator(`[data-node-id="${originalNodeId}"]`).count()).toBe(1);
  });
});
