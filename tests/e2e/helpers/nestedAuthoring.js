/**
 * Nested-authoring primitives.
 *
 * The author flow can recursively nest:
 *   main book → footnote → hyperlight on footnote text → footnote inside
 *   that hyperlight → ...  Each new level opens a fresh stacked
 *   hyperlit-container with its own `.sub-book-content[contenteditable]`.
 *
 * These helpers always operate on the **topmost open editable surface** —
 * the deepest stacked container if any are open, else `.main-content`.
 */

/**
 * Create a new book from the homepage. Lands in the reader in edit mode.
 * Returns { bookId }.
 */
export async function createNewBook(page, spa) {
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
  const bookId = await spa.getCurrentBookId(page);
  if (!/^book_\d+/.test(String(bookId))) {
    throw new Error(`createNewBook: expected book_<digits>, got "${bookId}"`);
  }
  // Wait for the initial h1 to be present
  await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
  return { bookId };
}

/**
 * Return the topmost editable element on the page — used as the "active
 * edit context" for type / select / footnote / hyperlight operations.
 *
 * Resolves to (in priority order):
 *   - The deepest open `.hyperlit-container-stacked.open .sub-book-content[contenteditable="true"]`
 *   - The base `#hyperlit-container.open .sub-book-content[contenteditable="true"]`
 *   - `.main-content` (edit mode)
 */
async function resolveActiveEditTargetHandle(page) {
  return page.evaluateHandle(() => {
    // Deepest stacked first
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const topStacked = stacked[stacked.length - 1];
    if (topStacked) {
      const editable = topStacked.querySelector('.sub-book-content[contenteditable="true"]');
      if (editable) return editable;
    }
    // Then base hyperlit-container
    const base = document.querySelector('#hyperlit-container.open');
    if (base) {
      const editable = base.querySelector('.sub-book-content[contenteditable="true"]');
      if (editable) return editable;
    }
    // Fallback to main content (only valid when edit mode is on)
    return document.querySelector('.main-content');
  });
}

/**
 * Get the current stack depth (0 = main content only, 1 = main + base container, etc.)
 */
export async function getStackDepth(page) {
  return page.evaluate(() => {
    return (document.querySelector('#hyperlit-container.open') ? 1 : 0)
      + document.querySelectorAll('.hyperlit-container-stacked.open').length;
  });
}

/**
 * Place caret at end of the active editor and type `text`.
 */
export async function typeAtEndOfActiveEditor(page, text) {
  const handle = await resolveActiveEditTargetHandle(page);
  await page.evaluate((el) => {
    if (!el) throw new Error('No active editor');
    // For nested .sub-book-content, find last block descendant
    const blocks = el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
    const target = blocks.length ? blocks[blocks.length - 1] : el;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    (target.focus ? target : el).focus();
  }, handle);
  await handle.dispose();
  await page.keyboard.type(text);
}

/**
 * Select the entire content (or a phrase) inside the active editor.
 * If `phrase` is null, selects all text inside the topmost block.
 */
export async function selectInActiveEditor(page, phrase) {
  const handle = await resolveActiveEditTargetHandle(page);
  await page.evaluate(({ el, phrase }) => {
    if (!el) throw new Error('No active editor');
    const blocks = el.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
    const target = blocks.length ? blocks[blocks.length - 1] : el;
    const text = target.textContent || '';
    if (!text) throw new Error('Active editor is empty — cannot select');
    let startOffset = 0;
    let endOffset = text.length;
    if (phrase) {
      const idx = text.indexOf(phrase);
      if (idx >= 0) { startOffset = idx; endOffset = idx + phrase.length; }
    }
    // Walk text nodes to find positions
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null, false);
    let charCount = 0;
    let startNode = null, startNodeOffset = 0;
    let endNode = null, endNodeOffset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (!startNode && charCount + len > startOffset) {
        startNode = node; startNodeOffset = startOffset - charCount;
      }
      if (!endNode && charCount + len >= endOffset) {
        endNode = node; endNodeOffset = endOffset - charCount;
        break;
      }
      charCount += len;
    }
    if (!startNode || !endNode) throw new Error(`Could not resolve selection range in active editor`);
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, { el: handle, phrase: phrase || null });
  await handle.dispose();
}

/**
 * Insert a footnote at the current caret. Opens a new stacked sub-book.
 * Waits for the stack depth to grow by 1.
 */
export async function insertFootnoteAtCaret(page) {
  const before = await getStackDepth(page);
  await page.click('#footnoteButton');
  await page.waitForFunction((b) => {
    const d = (document.querySelector('#hyperlit-container.open') ? 1 : 0)
      + document.querySelectorAll('.hyperlit-container-stacked.open').length;
    return d > b;
  }, before, { timeout: 10000 });
  // Wait briefly for the new editable to mount
  await page.waitForFunction(() => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
    return !!top?.querySelector('.sub-book-content[contenteditable="true"]');
  }, null, { timeout: 5000 });
}

/**
 * Create a hyperlight on the current selection. Opens a new stacked sub-book.
 * Waits for stack depth to grow by 1.
 */
export async function hyperlightSelection(page) {
  const before = await getStackDepth(page);
  // Wait for hyperlight buttons to be visible (selection must be set)
  await page.waitForFunction(() => {
    const buttons = document.getElementById('hyperlight-buttons');
    return buttons && window.getComputedStyle(buttons).display === 'flex';
  }, null, { timeout: 5000 });
  await page.click('#copy-hyperlight');
  await page.waitForFunction((b) => {
    const d = (document.querySelector('#hyperlit-container.open') ? 1 : 0)
      + document.querySelectorAll('.hyperlit-container-stacked.open').length;
    return d > b;
  }, before, { timeout: 10000 });
  await page.waitForFunction(() => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
    return !!top?.querySelector('.sub-book-content[contenteditable="true"]');
  }, null, { timeout: 5000 });
}

/**
 * Close the topmost open container (click its overlay, fall back to Escape).
 * Waits for stack depth to drop by 1.
 */
export async function closeTopContainer(page) {
  const before = await getStackDepth(page);
  if (before === 0) return;
  await page.evaluate(() => {
    const stackedOverlay = [...document.querySelectorAll('.ref-overlay-stacked')].pop();
    const overlay = stackedOverlay || document.getElementById('ref-overlay');
    if (overlay) overlay.click();
  });
  await page.waitForFunction((b) => {
    const d = (document.querySelector('#hyperlit-container.open') ? 1 : 0)
      + document.querySelectorAll('.hyperlit-container-stacked.open').length;
    return d < b;
  }, before, { timeout: 5000 }).catch(async () => {
    // Fallback: Escape
    await page.keyboard.press('Escape');
  });
}

/**
 * Click `#copy-hypercite` (assumes the active editor has a valid selection
 * AND `#hyperlight-buttons` is visible). After the new `<u id="hypercite_*">`
 * lands in the active editor, capture the clipboard payload (HTML + plain).
 *
 * Returns { hyperciteId, sourceBookId, html, text } — pass straight to
 * `spa.pasteHyperciteContent(page, html, text)` at the destination level.
 */
export async function copyHyperciteFromActiveEditor(page) {
  // Track the active editor's identity so we can disambiguate after copy.
  const beforeUs = await page.evaluate(() => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1]
      || document.querySelector('#hyperlit-container.open')
      || document.querySelector('.main-content');
    if (!top) return { count: 0, bookId: null };
    return {
      count: top.querySelectorAll('u[id^="hypercite_"]').length,
      bookId: top.getAttribute?.('data-book-id')
        || top.id
        || null,
    };
  });

  await page.waitForFunction(() => {
    const buttons = document.getElementById('hyperlight-buttons');
    return buttons && window.getComputedStyle(buttons).display === 'flex';
  }, null, { timeout: 5000 });
  await page.click('#copy-hypercite');

  // Wait for a new <u> to appear inside the active editor
  await page.waitForFunction((prev) => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1]
      || document.querySelector('#hyperlit-container.open')
      || document.querySelector('.main-content');
    if (!top) return false;
    return top.querySelectorAll('u[id^="hypercite_"]').length > prev;
  }, beforeUs.count, { timeout: 5000 });

  return page.evaluate(() => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1]
      || document.querySelector('#hyperlit-container.open')
      || document.querySelector('.main-content');
    const us = [...top.querySelectorAll('u[id^="hypercite_"]')];
    const uEl = us[us.length - 1];
    if (!uEl) throw new Error('copyHyperciteFromActiveEditor: no <u> found after copy-hypercite');

    const hcId = uEl.id;
    // For sub-books, the bookId is the data-book-id of the .sub-book-content;
    // for main-content, use its element id.
    let sourceBookId;
    const subBookEl = top.closest?.('[data-book-id]') || (top.classList?.contains('sub-book-content') ? top : null);
    if (subBookEl) {
      sourceBookId = subBookEl.getAttribute('data-book-id');
    } else if (top.classList?.contains('main-content')) {
      sourceBookId = top.id;
    } else {
      // Fallback: try descendant .sub-book-content
      const inner = top.querySelector?.('[data-book-id]');
      sourceBookId = inner?.getAttribute('data-book-id') || window.book || null;
    }

    const selectedText = uEl.textContent;
    const origin = window.location.origin;
    const href = `${origin}/${sourceBookId}#${hcId}`;
    const html = `'${selectedText}'⁠<a href="${href}" id="${hcId}" class="open-icon">↗</a>`;
    const text = `'${selectedText}' [↗](${href})`;

    // Collapse the selection so subsequent #footnoteButton / #copy-hyperlight
    // operations aren't blocked (those buttons get `disabled` when a text
    // range is active — see editToolbar/buttonStateManager.js).
    try {
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      // Hide the hyperlight floating button row, which sticks around until
      // the next selectionchange.
      const buttons = document.getElementById('hyperlight-buttons');
      if (buttons) buttons.style.display = 'none';
    } catch { /* swallow */ }

    return { hyperciteId: hcId, sourceBookId, html, text };
  });
}

/**
 * Force the topmost open container into edit mode (idempotent).
 *
 * The `.hyperlit-edit-btn` click handler is a *toggle* — if
 * `hyperlitEditMode` is already true (it can persist from a previous
 * insertion in the same session), a blind click flips it off and the
 * sub-book becomes read-only. So we check the current contenteditable
 * state of `.sub-book-content` first and only click if we need to.
 */
export async function ensureEditModeInActiveContainer(page) {
  const ok = await page.evaluate(() => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
    if (!top) return { ok: false, reason: 'no open container' };
    const editable = top.querySelector('.sub-book-content');
    if (!editable) return { ok: false, reason: 'no sub-book content in container' };
    if (editable.getAttribute('contenteditable') === 'true') {
      return { ok: true, alreadyEditing: true };
    }
    const btn = top.querySelector('.hyperlit-edit-btn');
    if (!btn) return { ok: false, reason: 'no edit button in container' };
    btn.click();
    return { ok: true, alreadyEditing: false };
  });
  if (!ok.ok) throw new Error(`ensureEditModeInActiveContainer: ${ok.reason}`);
  if (!ok.alreadyEditing) {
    // Wait for the sub-book to actually become contenteditable AND for the
    // paste listener to attach. handleEditButtonClick attaches the paste
    // listener via dynamic import inside an async function and marks the
    // sub-book with data-paste-attached when done — wait for that.
    await page.waitForFunction(() => {
      const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
      const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
      const editable = top?.querySelector('.sub-book-content');
      if (!editable) return false;
      if (editable.getAttribute('contenteditable') !== 'true') return false;
      // The hyperlitContainer/index.js handler sets dataset.pasteAttached = 'true'
      // once addPasteListener has run — gates synchronous paste dispatch.
      return editable.dataset?.pasteAttached === 'true';
    }, null, { timeout: 8000 });
  }
}

/**
 * Diagnostic — capture the current paste-relevant state. Useful when a
 * synthetic paste isn't landing.
 */
export async function pasteEnvProbe(page) {
  return page.evaluate(() => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
    const subBook = top?.querySelector('.sub-book-content');
    const active = document.activeElement;
    const sel = window.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    return {
      topContainerOpen: !!top,
      topContainerClass: top?.className || null,
      subBookFound: !!subBook,
      subBookContenteditable: subBook?.getAttribute('contenteditable') || null,
      subBookDataBookId: subBook?.getAttribute('data-book-id') || null,
      subBookPasteAttached: subBook?.dataset?.pasteAttached || null,
      activeElementTag: active?.tagName || null,
      activeElementId: active?.id || null,
      activeElementClasses: typeof active?.className === 'string' ? active.className : null,
      activeIsInsideSubBook: subBook ? !!(active && subBook.contains(active)) : false,
      hasSelection: !!range,
      rangeCollapsed: range?.collapsed ?? null,
      rangeStartInSubBook: range && subBook ? subBook.contains(range.startContainer) : null,
      windowIsEditing: !!window.isEditing,
    };
  });
}

// Back-compat alias for the older name used in the fixture.
export const toggleEditModeInActiveContainer = ensureEditModeInActiveContainer;

/**
 * From the currently-rendered page, click a footnote ref or hyperlight
 * mark inside the **topmost surface** to open one level deeper.
 *
 *   - 'footnote': clicks the first `sup[fn-count-id]` / `a.footnote-ref` in the topmost editor
 *   - 'hyperlight': clicks the first `mark` (hyperlight) in the topmost editor
 *
 * Waits for stack depth to grow by 1.
 */
export async function clickIntoDeeperLevel(page, kind = 'footnote') {
  const before = await getStackDepth(page);
  const selector = kind === 'hyperlight'
    ? 'mark.user-highlight, mark.highlight, mark[data-highlight-count]'
    : 'sup[fn-count-id], sup.footnote-ref, a.footnote-ref';
  const ok = await page.evaluate(({ selector }) => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1]
      || document.querySelector('#hyperlit-container.open')
      || document.querySelector('.main-content');
    if (!top) return false;
    const target = top.querySelector(selector);
    if (!target) return false;
    target.click();
    return true;
  }, { selector });
  if (!ok) throw new Error(`clickIntoDeeperLevel: no ${kind} found in top surface`);
  await page.waitForFunction((b) => {
    const d = (document.querySelector('#hyperlit-container.open') ? 1 : 0)
      + document.querySelectorAll('.hyperlit-container-stacked.open').length;
    return d > b;
  }, before, { timeout: 10000 });
  await page.waitForFunction(() => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
    return !!top?.querySelector('.sub-book-content');
  }, null, { timeout: 5000 });
}

/**
 * Read integrity events captured by integrityCapture.js, then optionally reset.
 */
export async function snapshotIntegrity(page, { reset = false } = {}) {
  return page.evaluate((reset) => {
    const events = Array.isArray(window.__integrityEvents)
      ? window.__integrityEvents.slice()
      : [];
    if (reset && window.__resetIntegrityEvents) window.__resetIntegrityEvents();
    return events;
  }, reset);
}

/**
 * Walk down current container stack and collect a snapshot of each level's
 * visible text content (trimmed). Useful for after-close verification.
 */
export async function readNestText(page) {
  return page.evaluate(() => {
    const out = [];
    const main = document.querySelector('.main-content');
    if (main) out.push({ level: 0, text: (main.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 400) });
    const subs = document.querySelectorAll('[data-book-id^="book_"], .sub-book-content');
    let lvl = 1;
    for (const el of subs) {
      out.push({
        level: lvl++,
        bookId: el.getAttribute('data-book-id') || null,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 400),
      });
    }
    return out;
  });
}
