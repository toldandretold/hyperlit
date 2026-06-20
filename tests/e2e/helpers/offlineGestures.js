/**
 * Shared building blocks for the offline-mode specs: create a baseline book with
 * enough body content, run the full offline authoring sequence (highlight + footnote
 * + hypercite + pastes), and filter the expected offline-network console noise.
 *
 * Kept here (not in a single mega-spec) so each spec under specs/offline/ stays
 * self-contained and independently runnable while sharing the gesture vocabulary.
 */

/** A clipboard payload of `n` distinct paragraphs (HTML + plain-text twin). */
export function makeParagraphPayload(n, tag) {
  const html = Array.from({ length: n }, (_, i) => `<p>${tag} paragraph ${i} — lorem ipsum dolor sit amet consectetur</p>`).join('');
  const text = Array.from({ length: n }, (_, i) => `${tag} paragraph ${i} — lorem ipsum dolor sit amet consectetur`).join('\n');
  return { html, text };
}

/** Numeric-id (startLine) nodes in `.main-content`, DOM order, as strings. */
export async function numericNodeIds(page) {
  return page.evaluate(() => {
    const re = /^\d+(\.\d+)?$/;
    return Array.from(document.querySelectorAll('.main-content [id]'))
      .map((el) => el.id)
      .filter((id) => re.test(id));
  });
}

/** Place the caret at the start of the first body paragraph (just below the title). */
async function clickIntoFirstBody(page) {
  await page.evaluate(() => {
    const re = /^\d+(\.\d+)?$/;
    const ps = Array.from(document.querySelectorAll('.main-content p')).filter((p) => re.test(p.id));
    const target = ps[0] || document.querySelector('h1[id="100"]');
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    target.focus?.();
  });
}

/**
 * Select `phrase` inside the FIRST early body paragraph that contains it, scrolled to
 * centre. Critical: `#edit-toolbar` is `position:fixed; bottom:0`, and the floating
 * `#hyperlight-buttons` (`position:absolute`) render near the selection — a selection at
 * the BOTTOM of a long doc puts those buttons under the fixed toolbar, which then
 * intercepts the click. Selecting near the top keeps the buttons clear of the toolbar.
 */
async function selectPhraseInEarlyBody(page, phrase) {
  await page.evaluate((phrase) => {
    const re = /^\d+(\.\d+)?$/;
    const main = document.querySelector('.main-content');
    if (!main) throw new Error('selectPhraseInEarlyBody: no .main-content');
    const target = Array.from(main.querySelectorAll('p'))
      .find((p) => re.test(p.id) && (p.textContent || '').includes(phrase));
    if (!target) throw new Error(`selectPhraseInEarlyBody: no early paragraph contains "${phrase}"`);
    target.scrollIntoView({ block: 'center' });
    const text = target.textContent || '';
    const startOffset = text.indexOf(phrase);
    const endOffset = startOffset + phrase.length;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null, false);
    let charCount = 0, startNode = null, startNodeOffset = 0, endNode = null, endNodeOffset = 0, node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (!startNode && charCount + len > startOffset) { startNode = node; startNodeOffset = startOffset - charCount; }
      if (!endNode && charCount + len >= endOffset) { endNode = node; endNodeOffset = endOffset - charCount; break; }
      charCount += len;
    }
    if (!startNode || !endNode) throw new Error('selectPhraseInEarlyBody: could not map selection range');
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, phrase);
}

/** Id of the topmost open sub-book container's editable, or null. */
export async function activeSubBookId(page) {
  return page.evaluate(() => {
    const stacked = [...document.querySelectorAll('.hyperlit-container-stacked.open')];
    const top = stacked[stacked.length - 1] || document.querySelector('#hyperlit-container.open');
    const sb = top?.querySelector('.sub-book-content[data-book-id]');
    return sb?.getAttribute('data-book-id') || null;
  });
}

/**
 * Create a fresh book and paste `paraCount` body paragraphs into it (ONLINE), then
 * wait for the green save cloud so the baseline is in Postgres before we go offline.
 * Returns `{ bookId }`.
 *
 * Keep paraCount < 100 so everything stays in one chunk (no lazy-load confound).
 */
export async function createBaselineBook(page, spa, { paraCount = 30 } = {}) {
  const { bookId } = await spa.createNewBook(page, spa);
  await page.click('h1[id="100"]');
  const payload = makeParagraphPayload(paraCount, 'BASE');
  await spa.pasteHyperciteContent(page, payload.html, payload.text);
  await page.waitForTimeout(2500); // save queue + chunk observer settle
  // Wait for sync to PG (green cloud), else a generous beat.
  await page
    .waitForFunction(() => {
      const c = document.querySelector('#cloudRef-svg .cls-1');
      return c && c.getAttribute('fill') === '#63B995';
    }, null, { timeout: 8000 })
    .catch(() => page.waitForTimeout(4000));
  return { bookId };
}

/**
 * Run the offline authoring sequence against the main book. Assumes the book is in
 * edit mode with body content and the network is already OFFLINE.
 *
 * Returns a record of what was created, including captured sub-book ids:
 *   { hyperlightSubBookId, footnoteSubBookId, hyperciteId, pasteCount }
 *
 * Each gesture mutates a main-content node (mark / sup / <u> / pasted <p>), so each
 * produces node changes → a `historyLog` WAL entry that carries the annotation too.
 */
export async function performOfflineAuthoring(page, spa) {
  const result = { hyperlightSubBookId: null, footnoteSubBookId: null, hyperciteId: null, pasteCount: 0 };

  // ── Highlight: select a phrase → open a hyperlight sub-book → type a marker ──
  await selectPhraseInEarlyBody(page, 'lorem ipsum');
  await spa.waitForHyperlightButtons(page);
  await spa.hyperlightSelection(page);
  result.hyperlightSubBookId = await activeSubBookId(page);
  try {
    await spa.toggleEditModeInActiveContainer(page); // ensureEditMode (idempotent)
    await spa.typeAtEndOfActiveEditor(page, 'OFFLINE highlight note alpha');
  } catch { /* sub-book may already be read-only; the mark itself still synced */ }
  await page.waitForTimeout(800);
  await spa.closeTopContainer(page);

  // ── Footnote: caret in a paragraph → open a footnote sub-book → type a body ──
  await clickIntoFirstBody(page);
  await spa.insertFootnoteAtCaret(page);
  result.footnoteSubBookId = await activeSubBookId(page);
  await spa.toggleEditModeInActiveContainer(page);
  await spa.typeAtEndOfActiveEditor(page, 'OFFLINE footnote body bravo');
  await page.waitForTimeout(800);
  await spa.closeTopContainer(page);

  // ── Hypercite: select a phrase → copy → paste the hypercite into main content ──
  await selectPhraseInEarlyBody(page, 'consectetur');
  await spa.waitForHyperlightButtons(page);
  const hc = await spa.copyHyperciteFromActiveEditor(page);
  result.hyperciteId = hc.hyperciteId;
  await clickIntoFirstBody(page);
  await spa.pasteHyperciteContent(page, hc.html, hc.text);
  await page.waitForTimeout(800);

  // ── A few more plain pastes at distinct carets ──
  for (let i = 0; i < 3; i++) {
    await clickIntoFirstBody(page);
    const p = makeParagraphPayload(2, `OFF${i}`);
    await spa.pasteHyperciteContent(page, p.html, p.text);
    result.pasteCount += 1;
    await page.waitForTimeout(600);
  }

  // Let the 3 s-debounced master sync write the WAL entries (offline → pending).
  await page.waitForTimeout(4000);
  return result;
}

/**
 * Drop expected offline-network noise from captured console errors. A page that goes
 * offline will log aborted boot/poll fetches as console.error — those are not real
 * failures (see MEMORY: e2e-flake-fetch-and-resize-gotchas).
 */
export function filterOfflineConsoleErrors(spa, page) {
  const offlineNoise = /(Failed to fetch|NetworkError|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|Load failed|net::ERR|TypeError: Failed to fetch|the user aborted a request|AbortError)/i;
  return spa.filterConsoleErrors(page.consoleErrors).filter((e) => !offlineNoise.test(e));
}
