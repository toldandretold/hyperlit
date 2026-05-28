/**
 * Helpers for driving the AI Brain query UI inside #hyperlit-container.
 */

import { selectTextInElement, waitForHyperlightButtons } from './pageHelpers.js';

/**
 * Find a CSS selector for the first paragraph in .main-content whose text
 * is at least minLen characters long. Used to find a usable selection target.
 */
export async function findSelectableParagraph(page, minLen = 80) {
  return page.evaluate((minLen) => {
    const blocks = document.querySelectorAll('.main-content p, .main-content li, .main-content blockquote');
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
 * Select a chunk of text and click #brain-hyperlight to open the brain query UI.
 * Returns true if the brain-query-section appears.
 */
export async function openBrainQueryFromSelection(page, selector, length = 60) {
  await selectTextInElement(page, selector, 0, length);
  await waitForHyperlightButtons(page);

  const hasBrainBtn = await page.locator('#brain-hyperlight').count();
  if (hasBrainBtn === 0) {
    throw new Error('#brain-hyperlight button not found in #hyperlight-buttons');
  }

  // The button uses addTouchAndClickListener which binds mousedown/touchstart,
  // NOT click. We dispatch mousedown explicitly.
  await page.evaluate(() => {
    const btn = document.getElementById('brain-hyperlight');
    if (!btn) return;
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  });

  await page.waitForSelector('#hyperlit-container.open .brain-query-section', { timeout: 20_000 });
  return true;
}

/**
 * Set the mode toggle ('quick' or 'archivist'). No-op if buttons aren't present
 * (the page may pre-date the toggle — the diagnostic test must still work).
 */
export async function setBrainMode(page, mode) {
  const present = await page.locator(`.brain-mode-btn[data-mode="${mode}"]`).count();
  if (!present) return false;
  await page.click(`.brain-mode-btn[data-mode="${mode}"]`);
  return true;
}

/**
 * Set the scope ('public' | 'mine' | 'all' | 'this' | 'shelf').
 */
export async function setBrainScope(page, scope) {
  const present = await page.locator(`.brain-scope-btn[data-scope="${scope}"]`).count();
  if (!present) return false;
  await page.click(`.brain-scope-btn[data-scope="${scope}"]`);
  return true;
}

/**
 * Pick a shelf from the .brain-shelf-select dropdown by index (default 0 = first).
 * Returns the option value picked, or null if no options.
 */
export async function pickShelf(page, index = 0) {
  await page.waitForFunction((idx) => {
    const sel = document.querySelector('.brain-shelf-select');
    return sel && sel.options.length > idx && sel.options[idx].value;
  }, index, { timeout: 5000 });
  return page.evaluate((idx) => {
    const sel = document.querySelector('.brain-shelf-select');
    if (!sel || !sel.options[idx]) return null;
    sel.selectedIndex = idx;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.options[idx].value;
  }, index);
}

/**
 * Fill the contenteditable question field and click Ask.
 */
export async function submitQuestion(page, question) {
  await page.evaluate((q) => {
    const el = document.querySelector('.brain-query-annotation');
    if (!el) throw new Error('.brain-query-annotation not found');
    el.textContent = q;
    el.classList.remove('empty');
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, question);
  await page.click('.brain-submit-btn');
}

/**
 * Wait for either:
 *   - a sub-book to render (success)
 *   - the .brain-status to show an error message
 *   - or the timeout fires
 * Returns { outcome: 'success'|'error'|'timeout', status?: string }.
 */
export async function waitForBrainResult(page, { timeout = 120_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = await page.evaluate(() => {
      const scroller = document.querySelector('#hyperlit-container .scroller');
      const subBook = scroller?.querySelector('[data-book-id^="book_"]')
        || scroller?.querySelector('.sub-book-content')
        || scroller?.querySelector('.highlight-annotation [data-node-id]');
      const statusEl = scroller?.querySelector('.brain-status');
      return {
        hasSubBook: !!subBook,
        status: statusEl && statusEl.style.display !== 'none' ? (statusEl.textContent || '').trim() : null,
        sectionStillPresent: !!scroller?.querySelector('.brain-query-section'),
      };
    });

    if (state.hasSubBook && !state.sectionStillPresent) {
      return { outcome: 'success' };
    }
    if (state.status && /error|failed|expired|not found|insufficient|no relevant|no matches|too long|unavailable/i.test(state.status)) {
      return { outcome: 'error', status: state.status };
    }
    await page.waitForTimeout(500);
  }
  const finalStatus = await page.evaluate(() => {
    const s = document.querySelector('#hyperlit-container .brain-status');
    return s ? (s.textContent || '').trim() : null;
  });
  return { outcome: 'timeout', status: finalStatus };
}
