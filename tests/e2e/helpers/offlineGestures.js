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

/**
 * Place the caret in the first body paragraph with a REAL click. This matters: the
 * editToolbar's `getWorkingSelection()` restores from a `lastValidRange` updated by
 * real editor interactions — a programmatic `addRange` leaves a stale range, so a
 * subsequent toolbar action (e.g. #footnoteButton → `insertFootnote`) operates on dead
 * coordinates and silently no-ops. A genuine `page.click` fires selectionchange and
 * refreshes that range, exactly like the working authoring specs (which type/click).
 */
async function clickIntoFirstBody(page) {
  const selector = await page.evaluate(() => {
    const re = /^\d+(\.\d+)?$/;
    const main = document.querySelector('.main-content');
    const p = Array.from(main.querySelectorAll('p')).find((el) => re.test(el.id));
    if (!p) return null;
    p.scrollIntoView({ block: 'center' });
    return `[id="${p.id}"]`;
  });
  if (!selector) throw new Error('clickIntoFirstBody: no body paragraph found');
  await page.click(selector);
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
 * Robustly dismiss a sub-book container/overlay — including the OFFLINE half-open state
 * where opening a sub-book leaves `#ref-overlay.active` intercepting clicks but never
 * sets `.open` on `#hyperlit-container` (so stack-depth-gated closers skip it). We always
 * run the app's force-clearing `closeHyperlitContainer`, sweep any lingering stacked
 * overlays/containers, then WAIT until nothing is intercepting before returning.
 */
async function dismissContainer(page, spa) {
  await spa.closeHyperlitContainer(page); // JS-click + force-clear fallback for #hyperlit-container/#ref-overlay
  await page.evaluate(() => {
    document.querySelectorAll('.hyperlit-container-stacked').forEach((c) => c.classList.remove('open'));
    document.querySelectorAll('.ref-overlay-stacked').forEach((o) => { o.classList.remove('active'); o.remove?.(); });
    const ov = document.getElementById('ref-overlay');
    if (ov) ov.classList.remove('active');
    document.body.classList.remove('hyperlit-container-open');
  });
  await page
    .waitForFunction(() => {
      const ov = document.getElementById('ref-overlay');
      const stacked = document.querySelector('.ref-overlay-stacked.active');
      return (!ov || !ov.classList.contains('active')) && !stacked;
    }, null, { timeout: 5000 })
    .catch(() => {});
}

/** Ensure the main content is in edit mode (idempotent) before a toolbar gesture. */
async function ensureMainEditMode(page) {
  const editing = await page.evaluate(() => window.isEditing === true);
  if (editing) return;
  await page.click('#editButton').catch(() => {});
  await page.waitForFunction(() => window.isEditing === true, null, { timeout: 8000 }).catch(() => {});
}

/**
 * Run the offline authoring sequence against the main book. Assumes the book is in
 * edit mode with body content and the network is already OFFLINE.
 *
 * Returns a record of what was created:
 *   { hyperlightSubBookId, footnoteSubBookId, hyperciteId, pasteCount }
 *
 * IMPORTANT — scope note: each gesture creates a PARENT-node artifact (a `<mark>`,
 * `<sup>`, hypercite `<u>`, or pasted `<p>`) which is what persists locally and syncs.
 * We do NOT author *inside* the footnote/hyperlight SUB-BOOKS here: opening a freshly
 * created sub-book runs server fetches (hyperlitContainer/contentBuilders →
 * fetchLibraryFromServer / buildBookDataUrl) that can't complete offline, so the
 * sub-book never mounts an editable surface. Sub-book interior authoring offline is a
 * separate, network-coupled scenario — out of scope for this sync test.
 *
 * Each gesture mutates a main-content node, so each produces node changes → a
 * `historyLog` WAL entry (offline → pending) that also carries the annotation.
 */
export async function performOfflineAuthoring(page, spa) {
  const result = { hyperlightSubBookId: null, footnoteSubBookId: null, hyperciteId: null, pasteCount: 0 };
  const fnLogs = [];
  const onConsole = (msg) => {
    const t = msg.text();
    if (/footnote|cursor position|insert/i.test(t)) fnLogs.push(`[${msg.type()}] ${t}`.slice(0, 200));
  };
  page.on('console', onConsole);

  // ── Footnote FIRST, in the clean main-content edit context (mirrors the working
  //    authoring specs, which insert a footnote right after typing). Opening a sub-book
  //    and force-dismissing it offline leaves the editing context fragile, so the
  //    sub-book openers (footnote, highlight) bracket the rest. ──
  await ensureMainEditMode(page);
  await clickIntoFirstBody(page);
  const supsBefore = await page.evaluate(() => document.querySelectorAll('.main-content sup').length);
  await page.click('#footnoteButton');
  const gotSup = await page
    .waitForFunction((b) => document.querySelectorAll('.main-content sup').length > b, supsBefore, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!gotSup) {
    const diag = await page.evaluate(() => {
      const sel = window.getSelection();
      const main = document.querySelector('.main-content');
      const btn = document.getElementById('footnoteButton');
      return {
        isEditing: window.isEditing,
        mainEditable: main?.getAttribute('contenteditable'),
        fnBtnDisabled: btn?.classList.contains('disabled') || btn?.disabled || null,
        selText: sel?.toString(),
        rangeCount: sel?.rangeCount,
        anchorInMain: sel?.anchorNode && main ? main.contains(sel.anchorNode) : null,
      };
    });
    throw new Error(`footnote sup not inserted; diag=${JSON.stringify(diag)}; logs=${JSON.stringify(fnLogs.slice(-8))}`);
  }
  result.footnoteSubBookId = await activeSubBookId(page);
  await dismissContainer(page, spa);

  // ── Hypercite: select an early phrase → copy (inserts <u> in main content) → paste.
  //    #copy-hypercite does NOT open a sub-book, so this is offline-clean. ──
  await ensureMainEditMode(page);
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

  // ── Highlight LAST: select an early phrase → copy-hyperlight → new <mark>. Opens a
  //    sub-book (dismissed after); nothing further needs a clean editing context. ──
  await ensureMainEditMode(page);
  await selectPhraseInEarlyBody(page, 'lorem ipsum');
  await spa.waitForHyperlightButtons(page);
  const marksBefore = await page.evaluate(() => document.querySelectorAll('.main-content mark').length);
  await page.click('#copy-hyperlight');
  await page.waitForFunction((b) => document.querySelectorAll('.main-content mark').length > b, marksBefore, { timeout: 10000 });
  result.hyperlightSubBookId = await activeSubBookId(page);
  await dismissContainer(page, spa);

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
