import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Cut → re-paste of hypercite elements must never strand a dead relation.
 *
 * The bug this locks out: cutting a citation anchor (the 'quote'↗ in the
 * citing book) and pasting it back minted a NEW hypercite id and APPENDED to
 * the source's citedIN, while the cut's delink was lost (no cut listener +
 * droppable mutation batch) — the source <u> then showed TWO citations, one
 * dead (red in the health check). Defense layers under test, end to end:
 * divEditor/cutHandler.ts (gesture-time snapshot), hypercites/reconciliation.ts
 * (paste-side citedIN prune), indexedDB/nodes/absenceReconciler.ts (save-time
 * self-heal), and the tombstone-gated restoration path for a cut source <u>.
 */

const cutKey = process.platform === 'darwin' ? 'Meta+x' : 'Control+x';

async function readHyperciteRecord(page, book, hyperciteId) {
  return page.evaluate(async ({ book, hyperciteId }) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('MarkdownDB');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction('hypercites').objectStore('hypercites').get([book, hyperciteId]);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, { book, hyperciteId });
}

/** Select an element (plus optional leading text) with a real DOM range. */
async function selectElementRange(page, selector, { includePreviousText = false } = {}) {
  await page.evaluate(({ selector, includePreviousText }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`selectElementRange: ${selector} not found`);
    const range = document.createRange();
    if (includePreviousText && el.previousSibling) {
      range.setStartBefore(el.previousSibling);
    } else {
      range.setStartBefore(el);
    }
    range.setEndAfter(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, { selector, includePreviousText });
}

test.describe('Hypercite cut → re-paste integrity', () => {
  test('cut citation anchor + re-paste leaves exactly ONE citedIN entry', async ({ page, spa }) => {
    test.setTimeout(180_000);

    // ── Book A: create + hypercite some text ──
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
    const book1Id = await spa.getCurrentBookId(page);

    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Cut Repaste Source');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.type('This is the quoted source text for the cut repaste test');
    await page.waitForTimeout(800);

    // Select the source sentence and mint the hypercite
    await page.evaluate(() => {
      const paragraphs = document.querySelectorAll('.main-content p');
      const p = Array.from(paragraphs).find((el) => el.textContent.includes('quoted source text'));
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.click('#copy-hypercite');
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 5000 });

    const hcData = await page.evaluate(() => {
      const uEl = document.querySelector('u[id^="hypercite_"].single');
      const bookId = document.querySelector('.main-content')?.id;
      return {
        hyperciteId: uEl.id,
        html: `'${uEl.textContent}'⁠<a href="/${bookId}#${uEl.id}" class="open-icon">↗</a>`,
        text: `'${uEl.textContent}'↗`,
      };
    });
    const hyperciteId = hcData.hyperciteId;
    await page.waitForTimeout(2000); // let the new record sync settle

    // ── Book B: create + paste the citation ──
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
    const book2Id = await spa.getCurrentBookId(page);
    expect(book2Id).not.toBe(book1Id);

    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Cut Repaste Citer');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.type('Prefix text before the citation. ');
    await page.waitForTimeout(500);

    await spa.pasteHyperciteContent(page, hcData.html, hcData.text);
    await page.waitForSelector('a.open-icon[id^="hypercite_"]', { timeout: 10_000 });
    await page.waitForTimeout(2500);

    const firstAnchorId = await page.evaluate(() => document.querySelector('a.open-icon[id^="hypercite_"]').id);
    let record = await readHyperciteRecord(page, book1Id, hyperciteId);
    expect(record.citedIN).toEqual([`/${book2Id}#${firstAnchorId}`]);
    expect(record.relationshipStatus).toBe('couple');

    // ── THE CUT: select 'quote'↗ and cut it with the real keyboard gesture ──
    await selectElementRange(page, `a.open-icon[id="${firstAnchorId}"]`, { includePreviousText: true });
    await page.keyboard.press(cutKey);
    await page.waitForTimeout(1500); // cutHandler finalize (60ms) + delink + save settle

    // The anchor is gone and the dead entry has been delinked
    expect(await page.locator(`a[id="${firstAnchorId}"]`).count()).toBe(0);
    await expect
      .poll(async () => (await readHyperciteRecord(page, book1Id, hyperciteId)).citedIN.length, { timeout: 10_000 })
      .toBe(0);

    // ── RE-PASTE elsewhere in the same node ──
    await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('.main-content p'))
        .find((el) => el.textContent.includes('Prefix text'));
      const range = document.createRange();
      range.selectNodeContents(p);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await spa.pasteHyperciteContent(page, hcData.html, hcData.text);
    await page.waitForSelector('a.open-icon[id^="hypercite_"]', { timeout: 10_000 });
    await page.waitForTimeout(2500);

    const secondAnchorId = await page.evaluate(() => document.querySelector('a.open-icon[id^="hypercite_"]').id);
    expect(secondAnchorId).not.toBe(firstAnchorId); // paste mints a fresh id

    // THE regression assertion: exactly ONE citedIN entry, pointing at the new anchor.
    record = await readHyperciteRecord(page, book1Id, hyperciteId);
    expect(record.citedIN).toEqual([`/${book2Id}#${secondAnchorId}`]);
    expect(record.relationshipStatus).toBe('couple');

    // And the source <u> in book A reflects 'couple', not poly/dead
    await page.goto(`/${book1Id}`);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector(`u[id="${hyperciteId}"]`, { timeout: 10_000 });
    const sourceClass = await page.evaluate((id) => document.getElementById(id)?.className, hyperciteId);
    expect(sourceClass).toContain('couple');
  });

  test('cut a CITED source <u> then paste it back — tombstone bridges the gap and the relation survives', async ({ page, spa }) => {
    test.setTimeout(180_000);

    // ── Book A with a hypercite cited by book B (compressed setup) ──
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
    const book1Id = await spa.getCurrentBookId(page);

    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Tombstone Source');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.type('Source sentence that will be cut and restored');
    await page.waitForTimeout(800);

    await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('.main-content p'))
        .find((el) => el.textContent.includes('cut and restored'));
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.click('#copy-hypercite');
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 5000 });
    const hyperciteId = await page.evaluate(() => document.querySelector('u[id^="hypercite_"].single').id);

    // Give it a citation directly in IDB + record shape via the real paste in book B
    const hcPayload = await page.evaluate((id) => {
      const uEl = document.getElementById(id);
      const bookId = document.querySelector('.main-content')?.id;
      return {
        html: `'${uEl.textContent}'⁠<a href="/${bookId}#${id}" class="open-icon">↗</a>`,
        text: `'${uEl.textContent}'↗`,
        uOuterHtml: uEl.outerHTML,
      };
    }, hyperciteId);
    await page.waitForTimeout(2000);

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
    await page.click('h1[id="100"]');
    await page.keyboard.type('Tombstone Citer');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await spa.pasteHyperciteContent(page, hcPayload.html, hcPayload.text);
    await page.waitForSelector('a.open-icon[id^="hypercite_"]', { timeout: 10_000 });
    await page.waitForTimeout(2500);

    // ── Back in book A: cut the CITED source <u> ──
    await page.goto(`/${book1Id}`);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector(`u[id="${hyperciteId}"]`, { timeout: 10_000 });
    await page.click('#editButton');
    await spa.waitForEditMode(page);

    // Capture the live <u> markup (now class="couple") for the paste-back
    const uOuterHtml = await page.evaluate((id) => document.getElementById(id).outerHTML, hyperciteId);

    await selectElementRange(page, `u[id="${hyperciteId}"]`);
    await page.keyboard.press(cutKey);
    await page.waitForTimeout(1500);

    // The cut handler (or observer) must leave a tombstone + ghost the record
    await expect
      .poll(async () => page.evaluate((id) => {
        const el = document.getElementById(id);
        return el ? el.className : 'GONE';
      }, hyperciteId), { timeout: 10_000 })
      .toContain('hypercite-tombstone');
    await expect
      .poll(async () => (await readHyperciteRecord(page, book1Id, hyperciteId))?.relationshipStatus, { timeout: 10_000 })
      .toBe('ghost');

    // ── Paste the <u> back → restoration consumes the tombstone ──
    await page.evaluate(() => {
      const p = document.querySelector('.main-content p[id], .main-content h1[id]');
      const range = document.createRange();
      range.selectNodeContents(p);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await spa.pasteHyperciteContent(page, uOuterHtml, 'Source sentence that will be cut and restored');
    await page.waitForTimeout(2500);

    // Exactly one element with the id remains, it is a REAL <u> again (not a tombstone),
    // and the record's status is restored from citedIN.
    const domState = await page.evaluate((id) => {
      const els = document.querySelectorAll(`[id="${id}"]`);
      return { count: els.length, className: els[0]?.className || null };
    }, hyperciteId);
    expect(domState.count).toBe(1);
    expect(domState.className).not.toContain('hypercite-tombstone');
    expect(domState.className).toContain('couple');

    await expect
      .poll(async () => (await readHyperciteRecord(page, book1Id, hyperciteId))?.relationshipStatus, { timeout: 10_000 })
      .toBe('couple');
  });
});
