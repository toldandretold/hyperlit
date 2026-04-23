/**
 * Novel Vacuum Handler
 *
 * Scrapes all chapters from a mydramanovel.com book URL via the Laravel proxy,
 * assembles them into a single markdown string, converts to HTML, and feeds
 * the result through the existing large-paste pipeline.
 *
 * Uses its own standalone progress overlay (not ProgressOverlayConductor) because
 * this is a long-running operation (5-10 min) and the navigation overlay system
 * has cleanup hooks that nuke it on tab switch / visibilitychange.
 */

import { sanitizeHtml } from '../../utilities/sanitizeConfig.js';
import { preprocessMarkdownFootnotes, footnoteDefinitionsToHtml, processMarkdownInChunks } from '../utils/markdown-processor.js';
import { getInsertionPoint } from '../utils/insertion-point-calculator.js';
import { handleLargePaste } from './largePasteHandler.js';
import { getCurrentChunk } from '../../chunkManager.js';
import { glowCloudGreen, glowCloudOrange, glowCloudRed } from '../../components/editIndicator.js';
import { initializeMainLazyLoader, lazyLoaders } from '../../initializePage.js';
import {
  setPasteInProgress,
  isPasteInProgress as isPasteInProgressState
} from '../../utilities/operationState.js';

// ─── Standalone progress overlay ────────────────────────────────────────────
// Completely separate from ProgressOverlayConductor / ProgressOverlayEnactor.
// Nothing else in the app knows about this element, so nothing can hide it.

let vacuumOverlay = null;
let vacuumBar = null;
let vacuumStatus = null;
let vacuumDetail = null;
let vacuumCancelled = false;

function createVacuumOverlay() {
  vacuumCancelled = false;

  vacuumOverlay = document.createElement('div');
  vacuumOverlay.id = 'novel-vacuum-overlay';
  vacuumOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#1e1e2e;border-radius:12px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;';

  const title = document.createElement('h3');
  title.textContent = 'Novel Vacuum';
  title.style.cssText = 'margin:0 0 16px;font-size:18px;color:#f5c2e7;';

  vacuumStatus = document.createElement('p');
  vacuumStatus.textContent = 'Starting...';
  vacuumStatus.style.cssText = 'margin:0 0 12px;font-size:14px;color:#cdd6f4;';

  const barContainer = document.createElement('div');
  barContainer.style.cssText = 'width:100%;height:16px;background:#313244;border-radius:8px;overflow:hidden;';

  vacuumBar = document.createElement('div');
  vacuumBar.style.cssText = 'width:2%;height:100%;background:linear-gradient(to right,#f5c2e7,#cba6f7);border-radius:8px;transition:width 0.3s;';

  vacuumDetail = document.createElement('p');
  vacuumDetail.textContent = '';
  vacuumDetail.style.cssText = 'margin:10px 0 0;font-size:12px;color:#a6adc8;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'margin:16px 0 0;padding:8px 18px;border-radius:6px;border:1px solid #585b70;background:transparent;color:#cdd6f4;cursor:pointer;font-size:14px;width:100%;';
  cancelBtn.addEventListener('click', () => { vacuumCancelled = true; });

  barContainer.appendChild(vacuumBar);
  card.appendChild(title);
  card.appendChild(vacuumStatus);
  card.appendChild(barContainer);
  card.appendChild(vacuumDetail);
  card.appendChild(cancelBtn);
  vacuumOverlay.appendChild(card);
  document.body.appendChild(vacuumOverlay);
}

function updateVacuumProgress(percent, status, detail) {
  if (vacuumBar) vacuumBar.style.width = Math.max(2, Math.min(100, percent)) + '%';
  if (status && vacuumStatus) vacuumStatus.textContent = status;
  if (detail !== undefined && vacuumDetail) vacuumDetail.textContent = detail;
}

function destroyVacuumOverlay() {
  if (vacuumOverlay) {
    vacuumOverlay.remove();
    vacuumOverlay = null;
    vacuumBar = null;
    vacuumStatus = null;
    vacuumDetail = null;
  }
}

// ─── Confirm dialog ─────────────────────────────────────────────────────────

function showConfirmDialog(url) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e1e2e;color:#cdd6f4;border-radius:12px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;';

    dialog.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:18px;color:#f5c2e7;">Novel Vacuum</h3>
      <p style="margin:0 0 8px;font-size:14px;line-height:1.5;">Scrape all chapters from this novel into the current book?</p>
      <p style="margin:0 0 20px;font-size:12px;color:#a6adc8;word-break:break-all;">${url}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="nv-cancel" style="padding:8px 18px;border-radius:6px;border:1px solid #585b70;background:transparent;color:#cdd6f4;cursor:pointer;font-size:14px;">Cancel</button>
        <button id="nv-confirm" style="padding:8px 18px;border-radius:6px;border:none;background:#f5c2e7;color:#1e1e2e;cursor:pointer;font-size:14px;font-weight:600;">Vacuum</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    dialog.querySelector('#nv-cancel').addEventListener('click', () => cleanup(false));
    dialog.querySelector('#nv-confirm').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content || '';
}

async function fetchChapterList(url) {
  const response = await fetch('/api/scrape/novel/chapters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': getCsrfToken() },
    credentials: 'include',
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new Error(`Failed to fetch chapter list: ${await response.text()}`);
  return response.json();
}

async function fetchChapter(url) {
  const response = await fetch('/api/scrape/novel/chapter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': getCsrfToken() },
    credentials: 'include',
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new Error(`Failed to fetch chapter: ${await response.text()}`);
  return response.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * @param {string} url - The pasted mydramanovel.com URL
 * @param {string} targetBookId - The book ID to insert into
 * @param {boolean} isSubBook - Whether the paste target is a sub-book
 */
export async function handleNovelVacuum(url, targetBookId, isSubBook) {
  // Capture insertion point NOW while cursor is still in place.
  // By the time scraping finishes (minutes later) the cursor will be gone.
  const chunk = getCurrentChunk();
  const chunkElement = chunk
    ? document.querySelector(`[data-chunk-id="${chunk}"],[id="${chunk}"]`)
    : null;
  const insertionPoint = getInsertionPoint(chunkElement, targetBookId);

  if (!insertionPoint) {
    alert('Place your cursor inside a paragraph first, then paste the URL.');
    return;
  }

  const confirmed = await showConfirmDialog(url);
  if (!confirmed) {
    console.log('[NovelVacuum] User cancelled');
    return;
  }

  console.log(`[NovelVacuum] Starting vacuum for: ${url}`);
  setPasteInProgress(true);
  createVacuumOverlay();

  try {
    // 1. Fetch chapter list
    updateVacuumProgress(3, 'Fetching chapter list...', '');

    const { title: bookTitle, chapters } = await fetchChapterList(url);
    console.log(`[NovelVacuum] Found ${chapters.length} chapters for "${bookTitle}"`);

    if (chapters.length === 0) {
      destroyVacuumOverlay();
      alert('No chapters found at this URL.');
      return;
    }

    // 2. Fetch each chapter sequentially
    const markdownParts = [`# ${bookTitle}\n`];
    const totalChapters = chapters.length;

    for (let i = 0; i < totalChapters; i++) {
      if (vacuumCancelled) {
        console.log(`[NovelVacuum] Cancelled by user at chapter ${i + 1}/${totalChapters}`);
        destroyVacuumOverlay();
        return;
      }

      const chapter = chapters[i];
      const percent = Math.round(5 + (i / totalChapters) * 75); // 5% → 80%
      updateVacuumProgress(percent, `Vacuuming chapter ${i + 1} / ${totalChapters}...`, chapter.title);

      try {
        const { title: chapterTitle, paragraphs } = await fetchChapter(chapter.url);
        markdownParts.push(`\n## ${chapterTitle}\n`);
        for (const p of paragraphs) {
          markdownParts.push(`\n${p}\n`);
        }
        console.log(`[NovelVacuum] Chapter ${i + 1}/${totalChapters}: "${chapterTitle}" (${paragraphs.length} paragraphs)`);
      } catch (err) {
        console.error(`[NovelVacuum] Failed chapter ${i + 1}: ${chapter.url}`, err);
        markdownParts.push(`\n## ${chapter.title}\n\n*[Failed to fetch this chapter]*\n`);
      }

      if (i < totalChapters - 1) await sleep(1000);
    }

    // 3. Build markdown
    const markdown = markdownParts.join('');
    console.log(`[NovelVacuum] Total markdown length: ${markdown.length} chars`);

    // 4. Convert markdown → HTML in chunks
    updateVacuumProgress(82, 'Converting to HTML...', `${markdown.length} characters`);

    const { text: preprocessedText, footnoteDefinitions } = preprocessMarkdownFootnotes(markdown);
    const footnoteSuffix = footnoteDefinitionsToHtml(footnoteDefinitions);
    const dirty = await processMarkdownInChunks(preprocessedText, (percent, current, total) => {
      const scaled = 82 + (percent / 100) * 8; // 82% → 90%
      updateVacuumProgress(scaled, `Converting markdown...`, `Chunk ${current}/${total}`);
    });
    const htmlContent = sanitizeHtml(dirty + footnoteSuffix);

    // 5. Insert into book (insertion point was captured before scraping started)
    updateVacuumProgress(91, 'Inserting into book...', '');

    // 6. Feed through handleLargePaste
    // (handleLargePaste internally shows ProgressOverlayConductor — hide it immediately
    //  after it returns since we have our own vacuum overlay)
    const syntheticEvent = { preventDefault: () => {} };
    const pasteResult = await handleLargePaste(
      syntheticEvent,
      insertionPoint,
      htmlContent,
      true, 'general', [], []
    );

    // Kill the navigation progress overlay that handleLargePaste spawned
    const { ProgressOverlayConductor } = await import('../../navigation/ProgressOverlayConductor.js');
    await ProgressOverlayConductor.hide();

    if (!pasteResult || !pasteResult.chunks || pasteResult.chunks.length === 0) {
      console.log('[NovelVacuum] Paste resulted in no new nodes.');
      destroyVacuumOverlay();
      return;
    }

    const newAndUpdatedNodes = pasteResult.chunks;
    const pasteBook = pasteResult.book;

    // 7. Refresh DOM via lazy loader
    updateVacuumProgress(94, 'Rebuilding view...', '');

    let loader;
    if (isSubBook) {
      loader = lazyLoaders[targetBookId];
      if (!loader) {
        console.error(`[NovelVacuum] Lazy loader not found for sub-book: ${targetBookId}`);
        destroyVacuumOverlay();
        return;
      }
    } else {
      loader = initializeMainLazyLoader();
    }

    loader.nodes = await loader.getNodeChunks();

    const insertionChunkId = insertionPoint.chunkId;
    const allChunks = Array.from(loader.container.querySelectorAll('[data-chunk-id]'));
    allChunks.forEach(chunkEl => {
      const cid = parseInt(chunkEl.dataset.chunkId);
      chunkEl.remove();
      loader.currentlyLoadedChunks.delete(cid);
    });

    loader.loadChunk(insertionChunkId, 'down');
    loader.repositionSentinels();

    // Scroll to first pasted node
    const firstPastedStartLine = newAndUpdatedNodes[0].startLine;
    const targetElement = document.getElementById(firstPastedStartLine.toString());
    if (targetElement) {
      targetElement.scrollIntoView({ block: 'start', behavior: 'instant' });
      targetElement.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(targetElement);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // Clear browser undo stack
    if (loader.container) {
      loader.container.contentEditable = 'false';
      loader.container.contentEditable = 'true';
    }

    // 8. Sync to PostgreSQL
    updateVacuumProgress(97, 'Syncing to server...', '');
    glowCloudOrange();

    try {
      const { getNodeChunksFromIndexedDB } = await import('../../indexedDB/index.js');
      const allNodes = await getNodeChunksFromIndexedDB(pasteBook);

      const response = await fetch('/api/db/node-chunks/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': getCsrfToken() },
        credentials: 'include',
        body: JSON.stringify({ book: pasteBook, data: allNodes }),
      });

      if (response.ok) {
        glowCloudGreen();
        console.log(`[NovelVacuum] Synced ${allNodes.length} nodes to PostgreSQL`);
      } else {
        glowCloudRed();
        console.error('[NovelVacuum] PostgreSQL sync failed');
      }
    } catch (err) {
      glowCloudRed();
      console.error('[NovelVacuum] PostgreSQL sync error:', err);
    }

    updateVacuumProgress(100, 'Done!', `${newAndUpdatedNodes.length} nodes from ${totalChapters} chapters`);
    console.log(`[NovelVacuum] Complete — ${newAndUpdatedNodes.length} nodes inserted from ${totalChapters} chapters`);

    // Brief pause so user sees "Done!" before overlay disappears
    await sleep(800);
    destroyVacuumOverlay();

  } catch (err) {
    console.error('[NovelVacuum] Error:', err);
    destroyVacuumOverlay();
    alert(`Novel Vacuum failed: ${err.message}`);
  } finally {
    if (isPasteInProgressState()) {
      setPasteInProgress(false);
    }
  }
}
