/**
 * The last-node invariant, end to end — the runtime replacement for the
 * retired no-delete-id marker system.
 *
 * The catastrophic case this exists to kill: delete a book's last node and the
 * book becomes UNOPENABLE (createLazyLoader returned null on zero nodes and
 * the whole reader/editor died on the next load). Contract with the guard +
 * backstop + boot rescue in place:
 *  - "delete everything" on the last node CLEARS it but the node survives,
 *  - the editor keeps working immediately (typing lands),
 *  - a reload still opens the book and shows the persisted content,
 *  - normal deletion of non-last nodes is unaffected.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

async function createNewBook(page, spa) {
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
}

const contentNodeCount = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.main-content .chunk [id]')]
    .filter((el) => /^\d+(\.\d+)?$/.test(el.id)).length
);

test.describe('divEditor — last-node guard', () => {
  test('select-all + Backspace on the last node clears it, keeps the editor alive, and survives reload', async ({ page, spa }) => {
    test.setTimeout(120_000);

    await createNewBook(page, spa);
    // A new book is exactly one node (the h1 seed) — the last-node case.
    expect(await contentNodeCount(page)).toBe(1);

    // Give the seed some content, persist it, then try to delete EVERYTHING.
    await page.click('h1[id="100"]');
    await page.keyboard.type('doomed title');
    await page.waitForTimeout(2000);

    await page.click('h1[id="100"]');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);

    // The node survived, emptied.
    expect(await contentNodeCount(page)).toBe(1);
    const emptiedText = await page.evaluate(() => document.querySelector('.main-content .chunk [id]')?.textContent ?? null);
    expect(emptiedText).not.toBeNull();
    expect(emptiedText.trim()).toBe('');

    // Repeated Backspace on the emptied node stays safe.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    expect(await contentNodeCount(page)).toBe(1);

    // The editor is still alive: typing lands in the surviving node.
    await page.keyboard.type('reborn');
    await page.waitForTimeout(2500); // outlast the save debounce

    const livedText = await page.evaluate(() => document.querySelector('.main-content .chunk [id]')?.textContent ?? null);
    expect(livedText).toContain('reborn');

    // The fatal-reload regression: the book must open again and show the
    // persisted state — not a dead loader.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    await page.waitForSelector('.main-content .chunk [id]', { timeout: 15_000 });

    expect(await contentNodeCount(page)).toBeGreaterThanOrEqual(1);
    const persisted = await page.evaluate(() => document.querySelector('.main-content')?.textContent ?? '');
    expect(persisted).toContain('reborn');
    expect(persisted).not.toContain('doomed title');
  });

  test('type-over on the last node replaces content but keeps the node', async ({ page, spa }) => {
    test.setTimeout(90_000);

    await createNewBook(page, spa);
    await page.click('h1[id="100"]');
    await page.keyboard.type('old words');
    await page.waitForTimeout(1500);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
    await page.keyboard.type('X'); // select-all + type = native replace, no keydown guard involved
    await page.waitForTimeout(2500);

    expect(await contentNodeCount(page)).toBe(1);
    const text = await page.evaluate(() => document.querySelector('.main-content .chunk [id]')?.textContent ?? null);
    expect(text).toContain('X');
    expect(text).not.toContain('old words');
  });

  test('normal deletion of a non-last node still works (no overprotection)', async ({ page, spa }) => {
    test.setTimeout(90_000);

    await createNewBook(page, spa);
    await page.click('h1[id="100"]');
    await page.keyboard.type('title stays');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('para to delete');
    await page.waitForTimeout(2500);
    expect(await contentNodeCount(page)).toBe(2);

    // Select the paragraph's full text and delete it, then backspace the empty
    // node away — a normal two-node deletion the guard must NOT block.
    const paraId = await page.evaluate(() => {
      const p = [...document.querySelectorAll('.main-content p')]
        .find((el) => el.textContent.includes('para to delete'));
      return p ? p.id : null;
    });
    expect(paraId).not.toBeNull();
    await page.click(`[id="${paraId}"]`);
    await page.evaluate((id) => {
      const el = document.getElementById(id);
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }, paraId);
    await page.keyboard.press('Backspace'); // clears the text
    await page.waitForTimeout(300);
    await page.keyboard.press('Backspace'); // merges/removes the empty node
    await page.waitForTimeout(2500);

    expect(await contentNodeCount(page)).toBe(1);
    const remaining = await page.evaluate(() => document.querySelector('.main-content')?.textContent ?? '');
    expect(remaining).toContain('title stays');
    expect(remaining).not.toContain('para to delete');
  });
});
