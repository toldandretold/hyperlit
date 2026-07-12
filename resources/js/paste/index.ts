/**
 * ================================================================================================
 * PASTE SYSTEM - Main Orchestrator
 * ================================================================================================
 *
 * This file coordinates all paste operations in Hyperlit, routing clipboard content through
 * specialized processors based on size, type, and format.
 *
 * ================================================================================================
 * ARCHITECTURE OVERVIEW
 * ================================================================================================
 *
 * paste/index (THIS FILE)        - Main orchestrator, event handling, routing logic
 * paste/handlers/                   - Specialized paste handlers (small, large, hypercite, code)
 * paste/ui/                          - UI components (modals, progress indicators)
 * paste/utils/                       - Reusable utilities (URL detection, markdown, HTML parsing)
 * paste/format-detection/            - Detects publisher formats (Cambridge, OUP, etc.)
 * paste/format-processors/           - Format-specific extraction pipelines
 *
 * ================================================================================================
 */

import { sanitizeHtml } from '../utilities/sanitizeConfig';
import { log, verbose } from '../utilities/logger';
import { marked } from 'marked';
import type { BookId } from '../utilities/idHelpers';
import { parseChunkId } from '../utilities/idHelpers';
import { getActiveBook } from '../hyperlitContainer/utilities/activeContext';
import { getCurrentChunk } from '../utilities/chunkState';
import { initializeMainLazyLoader, lazyLoaders } from '../pageLoad/index';
import { glowCloudGreen, glowCloudOrange, glowCloudRed } from '../components/cloudRef/editIndicator';
import {
  setPasteInProgress,
  isPasteInProgress as isPasteInProgressState
} from '../utilities/operationState';

// Import handlers
import { handleCodeBlockPaste } from './handlers/codeBlockHandler';
import { handleSmallPaste } from './handlers/smallPasteHandler';
import { handleLargePaste, undoLastLargePaste } from './handlers/largePasteHandler';
import { handleHypercitePaste, extractQuotedText } from './handlers/hyperciteHandler';
import { handleNovelVacuum } from './handlers/novelVacuumHandler';

// Import UI
import { ProgressOverlayConductor } from '../SPA/navigation/ProgressOverlayConductor';
import { showPasteUndoToast } from './ui/pasteUndoToast';

// Import utilities
import { detectFormat } from './format-detection/format-detector';
import { getFormatConfig } from './format-detection/format-registry';
import { detectAndConvertUrls } from './utils/url-detector';
import { detectMarkdown } from './utils/markdown-detector';
import { getInsertionPoint } from './utils/insertion-point-calculator';
import { processMarkdownInChunks, preprocessMarkdownFootnotes, footnoteDefinitionsToHtml } from './utils/markdown-processor';
import { estimatePasteNodeCount } from './utils/dom-helpers';
import { saveCurrentParagraph } from './handlers/hyperciteHandler';
import { detectYouTubeTranscript, transformYouTubeTranscript } from './utils/youtube-helpers';
import { stripMarkTags, convertDefinitionListTags, normalizeListItems } from './utils/normalizer';
import { verifyNodesIntegrity, findOrphanedNodes } from '../integrity/verifier';
import { reportIntegrityFailure } from '../integrity/reporter';
import { startPasteCapture } from '../integrity/logCapture';
import { INLINE_SKIP_TAGS } from '../utilities/blockElements';

// Configure marked options
marked.setOptions(<any>{
  breaks: true,        // Convert \n to <br>
  gfm: true,          // GitHub Flavored Markdown
  sanitize: false,    // We'll use DOMPurify instead
  smartypants: true   // Smart quotes, dashes, etc.
});

// Flag to prevent double-handling
let pasteHandled = false;

// Paste-in-progress flag lives in the ./pasteState leaf (so divEditor can read it without
// importing this barrel). Re-export the reader for existing importers.
import { isPasteOperationActive, setPasteOperationInProgress } from './pasteState';
export { isPasteOperationActive } from './pasteState';

export function addPasteListener(editableDiv: HTMLElement) {
  // Use capture phase to intercept before browser's native handling
  editableDiv.addEventListener("paste", handlePaste, { capture: true });

  // Also add beforeinput handler to catch insertFromPaste
  editableDiv.addEventListener("beforeinput", (event: any) => {
    if (event.inputType === "insertFromPaste") {
      event.preventDefault();
    }
  }, { capture: true });
}

// Export extractQuotedText for external use
// Re-export from utilities (moved to avoid circular dependency with hyperlights)
export { extractQuotedText } from '../utilities/textExtraction';

/**
 * Sync pasted nodes to PostgreSQL in background
 * Fire-and-forget function that handles errors gracefully
 */
async function syncPasteToPostgreSQL(bookId: BookId) {
  // Wait for initial book sync to complete first (prevents race condition with new book creation)
  const { getInitialBookSyncPromise } = await import('../utilities/operationState');
  const initialSyncPromise = getInitialBookSyncPromise();
  if (initialSyncPromise) {
    await initialSyncPromise;
  }

  // Show orange indicator while syncing
  glowCloudOrange();

  try {
    // Get ALL nodes for the book from IndexedDB
    const { getNodesFromIndexedDB } = await import('../indexedDB/index');
    const allNodes = await getNodesFromIndexedDB(bookId);

    // 🔢 Canonical footnote numbering. Paste bakes the SOURCE label into each <sup fn-count-id>,
    // but the app numbers footnotes by DOCUMENT ORDER. Reconcile here — over the full node set,
    // before the POST below — so the full-book sync carries canonical numbers, local IDB is
    // canonical, the rendered sups are corrected immediately, and the first full-book LOAD's
    // rebuildAndRenumber finds nothing to change (no write-on-read). Idempotent once converged.
    // Reuse the leaf helpers, NOT rebuildAndRenumber: its per-node queueForSync would double-sync
    // against this POST. Non-fatal — footnote numbering must never break the paste sync.
    try {
      const { buildFootnoteMap, updateFootnoteNumbersInDOM, applyFootnoteMapToStoredHTML } =
        await import('../footnotes/FootnoteNumberingService');
      buildFootnoteMap(bookId, allNodes);   // canonical doc-order map (populates the module map)
      updateFootnoteNumbersInDOM();          // fix the already-rendered (chunk 0) sups now
      const corrected: typeof allNodes = [];
      for (const n of allNodes) {
        if (!n.content) continue;
        const { changed, newContent } = applyFootnoteMapToStoredHTML(n.content);
        if (changed) { n.content = newContent; corrected.push(n); }  // mutate the array we POST
      }
      if (corrected.length > 0) {
        // Direct put (keyPath ["book","startLine"]) — records are already hydrated, so do NOT
        // route through loadNodesToIndexedDB (a wire-format normalizer that would re-parse them).
        const { openDatabase } = await import('../indexedDB/core/connection');
        const fnDb = await openDatabase();
        await new Promise<void>((resolve, reject) => {
          const tx = fnDb.transaction('nodes', 'readwrite');
          const store = tx.objectStore('nodes');
          for (const n of corrected) store.put(n);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
    } catch (e) {
      log.error('Paste footnote canonicalisation skipped (non-fatal)', '/paste/index.ts', e);
    }

    // ⚠️ CRITICAL DIAGNOSTIC: Check for incomplete IndexedDB data before destructive sync
    const chunkIds = [...new Set(allNodes.map((n: any) => n.chunk_id))].sort((a, b) => a - b);
    const hasChunk0 = chunkIds.includes(0);
    const minStartLine = Math.min(...allNodes.map((n: any) => n.startLine));

    // ⚠️ SAFETY CHECK: Abort if IndexedDB looks incomplete
    // This prevents the scenario where IndexedDB was cleared mid-session
    if (allNodes.length > 0 && !hasChunk0 && chunkIds.length > 0) {
      log.error('ABORTING FULL BOOK SYNC: IndexedDB missing chunk 0!', '/paste/index.ts', {
        stack: new Error().stack,
        chunkIds,
        nodeCount: allNodes.length,
        lowestStartLine: minStartLine
      });
      // Glow + toast handled by the single catch below; tag the cause for the classifier.
      const incompleteError = new Error(`Full book sync aborted: IndexedDB appears incomplete (missing chunk 0). This may indicate IndexedDB was cleared mid-session.`);
      (incompleteError as any).kind = 'incomplete';
      throw incompleteError;
    }

    // Also warn if very few nodes (potential data loss)
    if (allNodes.length < 10 && allNodes.length > 0) {
      log.error(`SUSPICIOUS: Only ${allNodes.length} nodes in IndexedDB for full sync - potential data loss risk`, '/paste/index.ts');
    }

    // Full book sync: deletes all existing nodes for book, then inserts all fresh
    const response = await fetch('/api/db/nodes/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content
      },
      credentials: 'include',
      body: JSON.stringify({
        book: bookId,
        data: allNodes
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Failed to sync full book to PostgreSQL', '/paste/index.ts', errorText);
      const syncError = new Error(`Full book sync failed: ${errorText}`);
      (syncError as any).status = response.status;
      throw syncError;
    }

    await response.json();

    // Push paste-seeded footnotes + references now. Their eager per-store syncs are
    // SKIPPED while a paste is in progress (see indexedDB/footnotes & bibliography):
    // during a paste into a fresh book those fire before the `library` row exists
    // server-side and get rejected 500 by the footnotes/bibliography RLS insert policy.
    // We're past getInitialBookSyncPromise() here, so the book row is guaranteed to
    // exist and the inserts pass. Non-fatal — nodes are the primary payload.
    try {
      const [{ getAllFootnotesForBook, syncFootnotesToPostgreSQL }, { getAllReferencesForBook, syncReferencesToPostgreSQL }] = await Promise.all([
        import('../indexedDB/footnotes/index'),
        import('../indexedDB/bibliography/index'),
      ]);
      const footnotes = await getAllFootnotesForBook(bookId);
      if (footnotes.length > 0) {
        await syncFootnotesToPostgreSQL(bookId, footnotes);
      }
      const references = await getAllReferencesForBook(bookId);
      if (references.length > 0) {
        await syncReferencesToPostgreSQL(bookId, references);
      }
    } catch (fnRefErr) {
      log.error('Post-paste footnote/reference sync failed', '/paste/index.ts', fnRefErr);
    }

    // Show green tick when sync completes
    glowCloudGreen();

  } catch (error: any) {
    log.error('Error syncing full book to PostgreSQL', '/paste/index.ts', error);
    // Full-book sync is a full replace with no local-save fallback, so a failure is
    // action-required (unless it's the explicit incomplete-data abort, tagged via .kind).
    glowCloudRed({ error, status: error.status, kind: error.kind, savedLocally: false });
    throw error; // Re-throw for caller's catch block
  }
}

/**
 * Schedule a post-paste integrity check.
 * Waits 500ms for MutationObserver to re-queue nodes, then flushes all
 * pending saves and verifies DOM nodes made it to IndexedDB.
 */
function _schedulePasteVerification(bookId: BookId, pasteOpId: string) {
  if (!bookId) return;

  setTimeout(async () => {
    try {
      // Flush all pending saves (cancels debounce timers, awaits in-flight writes)
      const { flushAllPendingSaves, queueNodeForSave } = await import('../divEditor/index');
      await flushAllPendingSaves();

      // Collect all rendered node IDs for this book
      const container = document.querySelector(`[data-book-id="${bookId}"]`)
        || document.getElementById(bookId);
      if (!container) return;

      const nodeEls = container.querySelectorAll('[id]');
      const nodeIds: any[] = [];
      nodeEls.forEach((el: any) => {
        if (/^\d+(\.\d+)?$/.test(el.id) && !INLINE_SKIP_TAGS.has(el.tagName)) {
          nodeIds.push(el.id);
        }
      });

      if (nodeIds.length === 0) return;

      verbose.content(`[integrity] Post-paste check (${pasteOpId}): verifying ${nodeIds.length} nodes`, '/paste/index.ts');
      const result = await verifyNodesIntegrity(bookId, nodeIds);

      const hasIssues = result.mismatches.length > 0 || result.missingFromIDB.length > 0 || result.duplicateIds.length > 0;

      if (hasIssues) {
        // Self-healing: re-queue failed nodes for save and retry once.
        // CRITICAL: re-queue by the numeric startLine (the DOM `id`, e.g. "6200"),
        // NOT the data-node-id (`m.nodeId`, e.g. "book_…_m5n38pktk"). queueNodeForSave
        // rejects any non-numeric id and drops it silently, so passing nodeId here made
        // the entire self-heal a no-op — re-verify hit the same record and always escalated.
        const failedIds = [
          ...result.missingFromIDB.map((m: any) => m.startLine),
          ...result.mismatches.map((m: any) => m.startLine),
        ];

        if (failedIds.length > 0) {
          // Don't overwrite IDB with empty DOM — that's data destruction
          const safeToHeal = failedIds.filter((id: any) => {
            const m = result.mismatches.find((m: any) => m.startLine === id);
            if (m && !m.domText.trim() && m.idbText.trim()) {
              log.error(`[integrity] Skipping self-heal for node ${id}: DOM empty but IDB has "${m.idbText.substring(0, 50)}"`, '/paste/index.ts');
              return false;
            }
            return true;
          });
          verbose.content(`[integrity] Self-healing: re-queuing ${safeToHeal.length} failed nodes for save (${failedIds.length - safeToHeal.length} skipped — DOM empty)`, '/paste/index.ts');
          for (const id of safeToHeal) {
            queueNodeForSave(id, 'update', bookId);
          }
          await flushAllPendingSaves();

          // Re-verify after retry
          const retryResult = await verifyNodesIntegrity(bookId, nodeIds);
          const stillHasIssues = retryResult.mismatches.length > 0 || retryResult.missingFromIDB.length > 0 || retryResult.duplicateIds.length > 0;

          if (stillHasIssues) {
            log.error(`[integrity] Self-healing failed — reporting (${pasteOpId})`, '/paste/index.ts');
            reportIntegrityFailure({
              bookId,
              mismatches: retryResult.mismatches,
              missingFromIDB: retryResult.missingFromIDB,
              duplicateIds: retryResult.duplicateIds,
              trigger: 'paste',
            });
          } else {
            verbose.content(`[integrity] Self-healing succeeded (${pasteOpId}): all ${retryResult.ok.length} nodes verified OK after retry`, '/paste/index.ts');
          }
        } else if (result.duplicateIds.length > 0) {
          // Duplicates only — can't self-heal, just report
          reportIntegrityFailure({
            bookId,
            mismatches: result.mismatches,
            missingFromIDB: result.missingFromIDB,
            duplicateIds: result.duplicateIds,
            trigger: 'paste',
          });
        }
      } else {
        verbose.content(`[integrity] Post-paste check (${pasteOpId}): all ${result.ok.length} nodes verified OK`, '/paste/index.ts');
      }

      // Orphan check: find block-level elements without numeric IDs
      const orphans = findOrphanedNodes(bookId);
      if (orphans.length > 0) {
        log.error(`[integrity] Post-paste orphan check: found ${orphans.length} orphaned node(s)`, '/paste/index.ts');
        const { setElementIds, findPreviousElementId, findNextElementId } = await import('../utilities/IDfunctions');

        const orphanedNodes: any[] = [];
        for (const orphan of orphans) {
          try {
            const beforeId = findPreviousElementId(orphan.element);
            const afterId = findNextElementId(orphan.element);
            setElementIds(orphan.element, beforeId, afterId, bookId);
            queueNodeForSave(orphan.element.id, 'add', bookId);
            orphanedNodes.push({
              tag: orphan.tag,
              textSnippet: orphan.textSnippet,
              assignedId: orphan.element.id,
            });
          } catch (err: any) {
            log.error(`[integrity] Failed to heal orphaned <${orphan.tag}>`, '/paste/index.ts', err);
            orphanedNodes.push({
              tag: orphan.tag,
              textSnippet: orphan.textSnippet,
              healFailed: true,
              error: err.message,
            });
          }
        }

        await flushAllPendingSaves();

        reportIntegrityFailure({
          bookId,
          mismatches: [],
          missingFromIDB: [],
          duplicateIds: [],
          orphanedNodes,
          trigger: 'paste',
          selfHealed: true,
        });
      }
    } catch (e: any) {
      log.error('[integrity] Post-paste verification error', '/paste/index.ts', e);
    }
  }, 500);
}

/**
 * Main paste event handler
 * Routes paste operations to appropriate handlers based on content type and size
 */
async function handlePaste(event: any) {
  // CRITICAL: Prevent browser's default paste IMMEDIATELY before any processing
  // This stops the browser from inserting unsanitized content
  event.preventDefault();

  // Start capturing all console logs for this paste operation
  startPasteCapture();

  // 🎯 Generate unique paste operation ID for tracing
  const pasteOpId = `paste_${Date.now()}`;

  try {
    // 1) Prevent double-handling
    if (pasteHandled) return;
    pasteHandled = true;
    setTimeout(() => (pasteHandled = false), 0);

    // 🔍 Detect sub-book context EARLY (before any processing that needs book ID)
    // Check if cursor is in a sub-book (hyperlit-container) by looking at current selection
    const selection: any = window.getSelection();
    let targetBookId = getActiveBook();
    let isSubBook = false;
    let subBookEl: any = null;
    
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      let node = range.startContainer;
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node = node.parentElement;
      }
      subBookEl = node?.closest('[data-book-id][contenteditable="true"]');
      if (subBookEl) {
        targetBookId = subBookEl.dataset.bookId;
        isSubBook = true;
      }
    }

    // 2) Grab and process clipboard data
    let plainText = event.clipboardData.getData("text/plain");
    let rawHtml = event.clipboardData.getData("text/html") || "";

    // Pristine clipboard HTML captured SYNCHRONOUSLY (before the smart-quote/mark/dl
    // mutations below). handleHypercitePaste runs after an `await`, by which point
    // Firefox has emptied event.clipboardData — so it must receive this captured copy.
    const pristineClipboardHtml = rawHtml;

    // Strip all smart quotes and backticks immediately to prevent any issues
    plainText = plainText
      .replace(/'/g, "'")  // Replace smart single quotes with regular ones
      .replace(/'/g, "'")  // Replace other smart single quotes
      .replace(/"/g, '"')  // Replace smart double quotes
      .replace(/"/g, '"')  // Replace other smart double quotes
      .replace(/`/g, "'"); // Replace backticks with regular single quotes

    rawHtml = rawHtml
      .replace(/'/g, "'")  // Replace smart single quotes with regular ones
      .replace(/'/g, "'")  // Replace other smart single quotes
      .replace(/"/g, '"')  // Replace smart double quotes
      .replace(/"/g, '"')  // Replace other smart double quotes
      .replace(/`/g, "'"); // Replace backticks with regular single quotes

    // 🚨 Strip <mark> tags to prevent them from becoming rogue top-level nodes
    // Mark tags are inline highlights - they should NEVER become their own paragraph/node
    rawHtml = stripMarkTags(rawHtml);

    // Convert <dl>, <dt>, <dd> definition list tags to <p> paragraphs
    rawHtml = convertDefinitionListTags(rawHtml);

    // Declare variables that will be used throughout the paste flow
    let htmlContent = "";
    let formatType = 'general'; // Default format

    // 🔍 DETECT RAW HTML SOURCE CODE (not rendered content)
    // If someone pastes HTML source code, wrap it in a code block instead of rendering
    // NOTE: Only check &lt;/&gt; entities if plainText itself has HTML tag patterns.
    // This prevents false positives from &lt;/&gt; in DOIs, math, URLs in angle brackets, etc.
    // (e.g. doi:10.1002/(SICI)1097-0266(199708)18:7<509::AID-SMJ882>3.0.CO;2-Z)
    // (e.g. <www.example.com>, <http://example.com/path>)
    // The regex requires tag name followed by whitespace, >, or / — ruling out URLs (which have . or :)
    const plainTextHasHTMLTags = /<\/?[a-z]+[\s>\/]/i.test(plainText);
    const looksLikeRawHTMLCode = plainTextHasHTMLTags && (
      (rawHtml.includes('&lt;') || rawHtml.includes('&gt;')) || // Escaped tags in HTML
      (rawHtml && !rawHtml.match(/<[a-z]+[^>]*>/i)) // No real tags in HTML
    );

    if (looksLikeRawHTMLCode) {
      // Use plainText (which has the actual code) and wrap it in a code block
      const escapedCode = plainText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      rawHtml = `<pre><code>${escapedCode}</code></pre>`;
      plainText = ''; // Clear plainText to force HTML path
    }

    // ✅ CHECK FOR YOUTUBE TRANSCRIPT - format for readability
    const youtubeDetection = detectYouTubeTranscript(plainText, rawHtml);
    if (youtubeDetection.isYouTube) {
      const transformedText = transformYouTubeTranscript(plainText, rawHtml, youtubeDetection.source);
      // Clear rawHtml to force plaintext path, then convert to HTML
      rawHtml = '';
      const dirty = marked(transformedText);
      htmlContent = normalizeListItems(sanitizeHtml(dirty));
    }

    // ✅ CHECK FOR URL PASTE - convert to links or embeds
    const urlConversion = detectAndConvertUrls(plainText.trim());
    if (urlConversion.isUrl) {
      event.preventDefault();

      // Novel Vacuum: mydramanovel.com URL detected — launch scraper flow
      if (urlConversion.isNovelScraper) {
        handleNovelVacuum(urlConversion.url, targetBookId, isSubBook);
        return;
      }

      // For YouTube embeds (block-level), use execCommand which triggers mutation observer
      // For links (inline), insert directly
      if (urlConversion.isYouTube) {
        // YouTube embed - execCommand triggers mutation observer for ID assignment
        document.execCommand('insertHTML', false, urlConversion.html);

        // The mutation observer in divEditor.js will:
        // 1. Detect the new .video-embed element
        // 2. Call ensureNodeHasValidId() to assign id and data-node-id
        // 3. Queue it for saving via queueNodeForSave()
      } else {
        // Regular link - insert inline
        document.execCommand('insertHTML', false, urlConversion.html);

        // Save the parent paragraph
        saveCurrentParagraph();
      }

      return;
    }

    // 3) Estimate size BEFORE processing (to route efficiently)
    const estimatedNodes = estimatePasteNodeCount(rawHtml || plainText);

    // Define threshold for small vs large paste
    const SMALL_NODE_LIMIT = 10;

    // PRIORITIZE HTML PATH
    let extractedFootnotes: any[] = [];
    let extractedReferences: any[] = [];
    // Track whether markdown conversion happened (used in toast summary)
    let wasMarkdown = false;

    if (rawHtml.trim()) {
      // Detect format using new detection system
      formatType = detectFormat(rawHtml);

      // Get processor configuration
      const config = getFormatConfig(formatType);

      if (!config) {
        const generalConfig = getFormatConfig('general');
        const ProcessorClass = generalConfig.processor;
        const processor = new ProcessorClass();
        const result = await processor.process(rawHtml, targetBookId);
        htmlContent = result.html;
        formatType = 'general';
        extractedFootnotes = result.footnotes;
        extractedReferences = result.references;
      } else {
        // Instantiate processor
        const ProcessorClass = config.processor;
        const processor = new ProcessorClass();

        // Route based on estimated size
        if (estimatedNodes <= SMALL_NODE_LIMIT) {
          // 🚀 Small paste: Use lite processing (normalize + cleanup only)
          const result = await processor.processLite(rawHtml, targetBookId);
          htmlContent = result.html;
          formatType = result.formatType;
          extractedFootnotes = [];
          extractedReferences = [];
        } else {
          // 🐌 Large paste: Use full processing
          const result = await processor.process(rawHtml, targetBookId);
          htmlContent = result.html;
          formatType = result.formatType;
          extractedFootnotes = result.footnotes;
          extractedReferences = result.references;
        }
      }
    }
    // FALLBACK TO MARKDOWN/PLAINTEXT PATH
    else {
      const isMarkdown = detectMarkdown(plainText);
      if (isMarkdown) {
        wasMarkdown = true;
        event.preventDefault(); // This is now safe to call

        // Pre-process [^N] footnotes before marked conversion
        // (marked v15 treats [^N]: as link references, breaking footnote extraction)
        const { text: preprocessedText, footnoteDefinitions } = preprocessMarkdownFootnotes(plainText);
        const footnoteSuffix = footnoteDefinitionsToHtml(footnoteDefinitions);

        if (preprocessedText.length > 1000) {
          ProgressOverlayConductor.showSPATransition(5, 'Converting Markdown...', true);
          try {
            const dirty = await processMarkdownInChunks(preprocessedText, (percent: any, current: any, total: any) => {
              ProgressOverlayConductor.updateProgress(percent, `Processing chunk ${current}/${total}`);
            });
            htmlContent = sanitizeHtml(dirty + footnoteSuffix);
            // Don't hide overlay yet - wait until after paste and scroll complete
          } catch (error: any) {
            log.error('Error during chunked conversion', '/paste/index.ts', error);
            await ProgressOverlayConductor.hide();
            return;
          }
        } else {
          const dirty = marked(preprocessedText);
          htmlContent = normalizeListItems(sanitizeHtml(dirty + footnoteSuffix));
        }
      }
    }

    // 4) Perform routing checks for special paste types.
    if (await handleHypercitePaste(event, targetBookId, pristineClipboardHtml)) return;
    const chunk = getCurrentChunk();
    const chunkElement = chunk
      ? document.querySelector(`[data-chunk-id="${chunk}"],[id="${chunk}"]`)
      : null;
    
    if (handleCodeBlockPaste(event, chunkElement, targetBookId)) return;

    // 5) Route to the correct handler (small vs. large paste).
    if (handleSmallPaste(event, htmlContent, plainText, estimatedNodes, targetBookId)) {
      // Small paste completed — observer was active the whole time
      await ProgressOverlayConductor.hide();

      // Post-paste integrity check: 3s delay (1.5s debounce + 1.5s margin)
      _schedulePasteVerification(targetBookId, pasteOpId);
      return;
    }

    // Large paste DOES need the flags — it does brutal DOM surgery
    setPasteInProgress(true);
    setPasteOperationInProgress(true);

    const insertionPoint = getInsertionPoint(chunkElement, targetBookId);
    if (!insertionPoint) {
      // Prevent browser default paste that would dump raw HTML into DOM
      event.preventDefault();

      const selection: any = window.getSelection();
      const currentNode = selection.anchorNode;
      const currentElement = currentNode?.nodeType === Node.TEXT_NODE ? currentNode.parentElement : currentNode;

      log.error(`[${pasteOpId}] Could not determine insertion point. Aborting paste.`, '/paste/index.ts');

      // Show user-friendly error message with cursor location
      const cursorLocation = currentElement?.tagName
        ? `${currentElement.tagName}${currentElement.id ? `#${currentElement.id}` : ''}`
        : 'unknown location';
      alert(`Cannot paste at current cursor position (cursor was in: ${cursorLocation}).\n\nPossible issues:\n- Cursor not inside a paragraph with numeric ID\n- Chunks already in DOM\n- Invalid DOM state\n\nPlease re-position cursor to a valid location (inside a paragraph) and try again.\n\nCheck console for detailed diagnostic info.`);
      return;
    }
    const contentToProcess = htmlContent || plainText;

    const pasteResult: any = await handleLargePaste(
      event,
      insertionPoint,
      contentToProcess,
      !!htmlContent,
      formatType, // Pass the detected format
      extractedFootnotes, // Pass processor-extracted footnotes
      extractedReferences // Pass processor-extracted references
    );

    if (!pasteResult || !pasteResult.chunks || pasteResult.chunks.length === 0) {
      return;
    }

    const newAndUpdatedNodes = pasteResult.chunks;
    const pasteBook = pasteResult.book;

    // Get the correct lazy loader based on context
    let loader: any;
    if (isSubBook) {
      // For sub-books, use the lazy loader from the registry
      loader = lazyLoaders[targetBookId];
      if (!loader) {
        log.error(`[${pasteOpId}] Lazy loader not found for sub-book`, '/paste/index.ts', targetBookId);
        await ProgressOverlayConductor.hide();
        return;
      }
    } else {
      // For main content, use the main lazy loader
      loader = initializeMainLazyLoader();
    }

    // 1. Update lazy loader cache from IndexedDB
    loader.nodes = await loader.getNodes();

    const firstPastedStartLine = newAndUpdatedNodes[0].startLine;

    const insertionChunkId = insertionPoint.chunkId;

    // 2. Remove ALL chunks from DOM (clean slate)
    const allChunks = Array.from<any>(loader.container.querySelectorAll('[data-chunk-id]'));

    allChunks.forEach((chunk: any) => {
      // parseChunkId = parseFloat (NOT parseInt): currentlyLoadedChunks holds decimal
      // chunk_ids, so a truncating delete would miss a fractional entry.
      const chunkId = parseChunkId(chunk.dataset.chunkId);
      chunk.remove();
      loader.currentlyLoadedChunks.delete(chunkId);
    });

    // 3. Reload only the insertion chunk (lazy loader will handle the rest on scroll)
    loader.loadChunk(insertionChunkId, 'down');

    // Reposition sentinels to wrap around the newly loaded chunk
    loader.repositionSentinels();

    // 4. Find first pasted node and scroll to it
    const firstPastedId = firstPastedStartLine.toString();
    const targetElement = document.getElementById(firstPastedId);

    if (targetElement) {
      // Scroll to top of viewport
      targetElement.scrollIntoView({ block: 'start', behavior: 'instant' });

      // Set focus and cursor
      targetElement.focus();
      const selection: any = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(targetElement);
      range.collapse(false); // Collapse to end
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      log.error(`[${pasteOpId}] Could not find pasted element`, '/paste/index.ts', firstPastedId);
    }

    // Hide overlay immediately after scroll (DOM is already visible)
    await ProgressOverlayConductor.hide();

    // Clear the browser's undo stack — the DOM was rebuilt via lazy loader,
    // so stale undo entries would reference dead nodes and cause phantom saves.
    // Toggling contentEditable is the standard way to reset the undo stack.
    if (loader.container) {
      loader.container.contentEditable = 'false';
      loader.container.contentEditable = 'true';
    }

    // Show undo toast for large paste (with conversion summary)
    const conversionSummary = {
      formatType,
      wasMarkdown,
      wasHtml: !!rawHtml.trim(),
      footnoteCount: extractedFootnotes.length,
      referenceCount: extractedReferences.length,
      nodeCount: newAndUpdatedNodes.length,
      bookId: pasteBook,
      pastedContent: rawHtml.trim() || plainText,
    };
    showPasteUndoToast(() => undoLastLargePaste(), conversionSummary);

    // Sync FULL BOOK to PostgreSQL in background (fire and forget - don't block user)
    // Full sync ensures no orphaned records after paste renumbering
    syncPasteToPostgreSQL(pasteBook).catch(err => {
      log.error('Background full book sync failed', '/paste/index.ts', err);
      glowCloudRed();
    });

    // Post-paste integrity check for large pastes
    _schedulePasteVerification(pasteBook, pasteOpId);

  } finally {
    // Only clear flags if they were set (small pastes skip flag-setting)
    if (isPasteInProgressState()) {
      setPasteInProgress(false);
    }
    if (isPasteOperationActive()) {
      setPasteOperationInProgress(false);
    }
  }
}
