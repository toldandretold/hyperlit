/**
 * Helpers for driving the citation modal (#citation-mode-container).
 *
 * Pattern mirrors helpers/brainQuery.js — needs a selection range first to
 * activate the edit toolbar, then clicks the citation button to enter
 * citation mode.
 */

import { selectTextInElement } from './pageHelpers.js';

/**
 * Find a CSS selector for the first paragraph in .main-content whose text is
 * at least minLen characters long.
 */
export async function findCitableParagraph(page, minLen = 60) {
  return page.evaluate((minLen) => {
    const blocks = document.querySelectorAll('.main-content p, .main-content li');
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const text = (el.textContent || '').trim();
      if (text.length >= minLen) {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const idx = Array.from(el.parentElement.children).indexOf(el);
        const tag = el.tagName.toLowerCase();
        return `.main-content ${tag}:nth-child(${idx + 1})`;
      }
    }
    return null;
  }, minLen);
}

/**
 * Make a small selection and open the citation modal by clicking #citationButton.
 * Returns true when the citation container becomes visible.
 */
export async function openCitationModal(page, selector, length = 20) {
  // Citation UI lives inside #edit-toolbar, which is `visibility: hidden` until
  // edit mode adds the `.visible` class (setEditMode(true) → show()). The
  // search input therefore can't be filled unless we're in edit mode — match
  // the real app flow by entering edit mode first.
  const editing = await page.evaluate(() => window.isEditing === true);
  if (!editing) {
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === true, null, { timeout: 10_000 });
    await page.waitForSelector('#edit-toolbar.visible', { state: 'visible', timeout: 5000 });
  }

  // Place a COLLAPSED cursor (not a text selection). The citation button is
  // disabled whenever text is selected — `buttonStateManager` sets
  // `shouldDisable = !isRangeValid || isTextSelected` — because a citation is
  // inserted at a cursor position, not over a range. A collapsed range at
  // `length` still registers as `lastValidRange` (so isRangeValid is true) while
  // keeping isTextSelected false, which is exactly the state that enables the
  // button. `length` is treated as the cursor offset within the block.
  await selectTextInElement(page, selector, length, length);

  // Wait for edit-toolbar to be visible (edit mode + selection triggers it).
  await page.waitForSelector('#edit-toolbar.visible, #edit-toolbar', { timeout: 5000 }).catch(() => {});

  // Click citationButton. Use evaluate to bypass any synthetic-click weirdness.
  await page.evaluate(() => {
    const btn = document.getElementById('citationButton');
    if (!btn) throw new Error('#citationButton not found');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    btn.click();
  });

  await page.waitForFunction(
    () => !document.getElementById('citation-mode-container')?.classList.contains('hidden'),
    null,
    { timeout: 5000 }
  );
  return true;
}

/**
 * Click one of the three scope chips. Returns true if the chip exists.
 */
export async function setCitationScope(page, scope) {
  const sel = `.citation-scope-btn[data-scope="${scope}"]`;
  const present = await page.locator(sel).count();
  if (!present) return false;
  await page.click(sel);
  return true;
}

/**
 * Type a query into #citation-search-input. Caller should waitForResults next.
 */
export async function typeCitationQuery(page, query) {
  await page.fill('#citation-search-input', query);
}

/**
 * Wait for at least one .citation-result-item to appear (or empty/error state).
 */
export async function waitForCitationResults(page, timeout = 10_000) {
  await page.waitForFunction(
    () => {
      const results = document.getElementById('citation-toolbar-results');
      if (!results) return false;
      const state = results.dataset.state;
      return state === 'results' || state === 'empty';
    },
    null,
    { timeout }
  );
  return page.evaluate(() => document.getElementById('citation-toolbar-results').dataset.state);
}

/**
 * Dump the most recently inserted bibliography record from IDB.
 * Returns { book, referenceId, source_id, canonical_source_id, content } or null.
 */
export async function lastBibliographyRecord(page, bookId) {
  return page.evaluate((bookId) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('MarkdownDB');
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('bibliography', 'readonly');
        const store = tx.objectStore('bibliography');
        const out = [];
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (evt) => {
          const cursor = evt.target.result;
          if (cursor) {
            if (cursor.value.book === bookId) out.push(cursor.value);
            cursor.continue();
          } else {
            // Pick newest by updated_at, then by referenceId
            out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
            resolve(out[0] || null);
          }
        };
        cursorReq.onerror = () => reject(new Error('cursor failed'));
      };
      req.onerror = () => reject(new Error('open MarkdownDB failed'));
    });
  }, bookId);
}
