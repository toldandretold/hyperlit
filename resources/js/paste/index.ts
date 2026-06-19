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
  console.log("Adding modular paste listener");
  // Use capture phase to intercept before browser's native handling
  editableDiv.addEventListener("paste", handlePaste, { capture: true });

  // Also add beforeinput handler to catch insertFromPaste
  editableDiv.addEventListener("beforeinput", (event: any) => {
    if (event.inputType === "insertFromPaste") {
      console.log("🛑 beforeinput: insertFromPaste - preventing default");
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
  console.log(`📤 Syncing FULL BOOK to PostgreSQL in background after paste...`);

  // Wait for initial book sync to complete first (prevents race condition with new book creation)
  const { getInitialBookSyncPromise } = await import('../utilities/operationState');
  const initialSyncPromise = getInitialBookSyncPromise();
  if (initialSyncPromise) {
    console.log("PASTE SYNC: Waiting for initial book sync to complete...");
    await initialSyncPromise;
    console.log("PASTE SYNC: Initial book sync complete. Proceeding with full book sync.");
  }

  // Show orange indicator while syncing
  glowCloudOrange();

  try {
    // Get ALL nodes for the book from IndexedDB
    const { getNodesFromIndexedDB } = await import('../indexedDB/index');
    const allNodes = await getNodesFromIndexedDB(bookId);
    console.log(`📊 Retrieved ${allNodes.length} total nodes from IndexedDB for full book sync`);

    // ⚠️ CRITICAL DIAGNOSTIC: Check for incomplete IndexedDB data before destructive sync
    const chunkIds = [...new Set(allNodes.map((n: any) => n.chunk_id))].sort((a, b) => a - b);
    const hasChunk0 = chunkIds.includes(0);
    const minStartLine = Math.min(...allNodes.map((n: any) => n.startLine));
    const maxStartLine = Math.max(...allNodes.map((n: any) => n.startLine));

    console.warn(`⚠️ FULL BOOK SYNC DIAGNOSTIC:`, {
      nodeCount: allNodes.length,
      chunkIds,
      hasChunk0,
      minStartLine,
      maxStartLine,
      bookId,
      timestamp: Date.now()
    });

    // ⚠️ SAFETY CHECK: Abort if IndexedDB looks incomplete
    // This prevents the scenario where IndexedDB was cleared mid-session
    if (allNodes.length > 0 && !hasChunk0 && chunkIds.length > 0) {
      console.error(`🚨 ABORTING FULL BOOK SYNC: IndexedDB missing chunk 0!`, {
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
      console.warn(`⚠️ SUSPICIOUS: Only ${allNodes.length} nodes in IndexedDB for full sync - potential data loss risk`);
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
      console.error('❌ Failed to sync full book to PostgreSQL:', errorText);
      const syncError = new Error(`Full book sync failed: ${errorText}`);
      (syncError as any).status = response.status;
      throw syncError;
    }

    const result = await response.json();
    console.log('✅ Full book synced to PostgreSQL:', result);

    // Show green tick when sync completes
    glowCloudGreen();

  } catch (error: any) {
    console.error('❌ Error syncing full book to PostgreSQL:', error);
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

      console.log(`[integrity] Post-paste check (${pasteOpId}): verifying ${nodeIds.length} nodes`);
      const result = await verifyNodesIntegrity(bookId, nodeIds);

      const hasIssues = result.mismatches.length > 0 || result.missingFromIDB.length > 0 || result.duplicateIds.length > 0;

      if (hasIssues) {
        // Self-healing: re-queue failed nodes for save and retry once
        const failedIds = [
          ...result.missingFromIDB.map((m: any) => m.nodeId),
          ...result.mismatches.map((m: any) => m.nodeId),
        ];

        if (failedIds.length > 0) {
          // Don't overwrite IDB with empty DOM — that's data destruction
          const safeToHeal = failedIds.filter((id: any) => {
            const m = result.mismatches.find((m: any) => m.nodeId === id);
            if (m && !m.domText.trim() && m.idbText.trim()) {
              console.warn(`[integrity] Skipping self-heal for node ${id}: DOM empty but IDB has "${m.idbText.substring(0, 50)}"`);
              return false;
            }
            return true;
          });
          console.log(`[integrity] Self-healing: re-queuing ${safeToHeal.length} failed nodes for save (${failedIds.length - safeToHeal.length} skipped — DOM empty)`);
          for (const id of safeToHeal) {
            queueNodeForSave(id, 'update', bookId);
          }
          await flushAllPendingSaves();

          // Re-verify after retry
          const retryResult = await verifyNodesIntegrity(bookId, nodeIds);
          const stillHasIssues = retryResult.mismatches.length > 0 || retryResult.missingFromIDB.length > 0 || retryResult.duplicateIds.length > 0;

          if (stillHasIssues) {
            console.warn(`[integrity] Self-healing failed — reporting (${pasteOpId})`);
            reportIntegrityFailure({
              bookId,
              mismatches: retryResult.mismatches,
              missingFromIDB: retryResult.missingFromIDB,
              duplicateIds: retryResult.duplicateIds,
              trigger: 'paste',
            });
          } else {
            console.log(`[integrity] Self-healing succeeded (${pasteOpId}): all ${retryResult.ok.length} nodes verified OK after retry`);
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
        console.log(`[integrity] Post-paste check (${pasteOpId}): all ${result.ok.length} nodes verified OK`);
      }

      // Orphan check: find block-level elements without numeric IDs
      const orphans = findOrphanedNodes(bookId);
      if (orphans.length > 0) {
        console.warn(`[integrity] Post-paste orphan check: found ${orphans.length} orphaned node(s)`);
        const { setElementIds, findPreviousElementId, findNextElementId } = await import('../utilities/IDfunctions');

        const orphanedNodes: any[] = [];
        for (const orphan of orphans) {
          try {
            const beforeId = findPreviousElementId(orphan.element);
            const afterId = findNextElementId(orphan.element);
            setElementIds(orphan.element, beforeId, afterId, bookId);
            console.log(`[integrity] Assigned ID ${orphan.element.id} to orphaned <${orphan.tag}> element`);
            queueNodeForSave(orphan.element.id, 'add', bookId);
            orphanedNodes.push({
              tag: orphan.tag,
              textSnippet: orphan.textSnippet,
              assignedId: orphan.element.id,
            });
          } catch (err: any) {
            console.error(`[integrity] Failed to heal orphaned <${orphan.tag}>:`, err);
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
      console.warn('[integrity] Post-paste verification error:', e);
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
  console.log(`🎯 [${pasteOpId}] Starting paste operation`);

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
        console.log(`🎯 [${pasteOpId}] Detected sub-book context: ${targetBookId}`);
      }
    }

    // 2) Grab and process clipboard data
    let plainText = event.clipboardData.getData("text/plain");
    let rawHtml = event.clipboardData.getData("text/html") || "";

    // 🔍 DEBUG: Log clipboard HTML to see iOS structure
    console.log(`🔍 [${pasteOpId}] Clipboard HTML (first 3000 chars):`, rawHtml.substring(0, 3000));
    console.log(`🔍 [${pasteOpId}] Has inline styles:`, rawHtml.includes('style='));
    console.log(`🔍 [${pasteOpId}] Has margin 0.0px:`, rawHtml.includes('margin: 0.0px'));
    console.log(`🔍 [${pasteOpId}] Has webkit:`, rawHtml.includes('webkit'));

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
    const hadMarkTags = rawHtml.includes('<mark');
    rawHtml = stripMarkTags(rawHtml);
    if (hadMarkTags) {
      console.log(`🧹 [${pasteOpId}] Stripped <mark> tags from pasted content`);
    }

    // Convert <dl>, <dt>, <dd> definition list tags to <p> paragraphs
    const hadDLTags = rawHtml.includes('<dt') || rawHtml.includes('<dd') || rawHtml.includes('<dl');
    rawHtml = convertDefinitionListTags(rawHtml);
    if (hadDLTags) {
      console.log(`🧹 [${pasteOpId}] Converted definition list tags to paragraphs`);
    }

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
      console.log(`📝 [${pasteOpId}] Detected raw HTML code paste - wrapping in <pre><code>`);
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
      console.log(`📺 [${pasteOpId}] Detected YouTube transcript (${youtubeDetection.source}) - formatting for readability`);
      const transformedText = transformYouTubeTranscript(plainText, rawHtml, youtubeDetection.source);
      // Clear rawHtml to force plaintext path, then convert to HTML
      rawHtml = '';
      const dirty = marked(transformedText);
      htmlContent = normalizeListItems(sanitizeHtml(dirty));
      console.log(`✅ [${pasteOpId}] YouTube transcript transformed and converted to HTML`);
    }

    // ✅ CHECK FOR URL PASTE - convert to links or embeds
    const urlConversion = detectAndConvertUrls(plainText.trim());
    if (urlConversion.isUrl) {
      event.preventDefault();

      // Novel Vacuum: mydramanovel.com URL detected — launch scraper flow
      if (urlConversion.isNovelScraper) {
        console.log(`📚 [${pasteOpId}] Novel Vacuum URL detected: ${urlConversion.url}`);
        handleNovelVacuum(urlConversion.url, targetBookId, isSubBook);
        return;
      }

      console.log(`🔗 [${pasteOpId}] Detected ${urlConversion.isYouTube ? 'YouTube embed' : 'external link'} paste: ${urlConversion.url}`);

      // For YouTube embeds (block-level), use execCommand which triggers mutation observer
      // For links (inline), insert directly
      if (urlConversion.isYouTube) {
        // YouTube embed - execCommand triggers mutation observer for ID assignment
        document.execCommand('insertHTML', false, urlConversion.html);

        // The mutation observer in divEditor.js will:
        // 1. Detect the new .video-embed element
        // 2. Call ensureNodeHasValidId() to assign id and data-node-id
        // 3. Queue it for saving via queueNodeForSave()

        console.log(`✅ [${pasteOpId}] YouTube embed inserted - IDs assigned by mutation observer`);
      } else {
        // Regular link - insert inline
        document.execCommand('insertHTML', false, urlConversion.html);

        // Save the parent paragraph
        saveCurrentParagraph();

        console.log(`✅ [${pasteOpId}] External link inserted`);
      }

      return;
    }

    // 3) Estimate size BEFORE processing (to route efficiently)
    const estimatedNodes = estimatePasteNodeCount(rawHtml || plainText);
    console.log(`🎯 [${pasteOpId}] Content analyzed: ${plainText.length} chars, ~${estimatedNodes} nodes`);

    // Define threshold for small vs large paste
    const SMALL_NODE_LIMIT = 10;

    // PRIORITIZE HTML PATH
    let extractedFootnotes: any[] = [];
    let extractedReferences: any[] = [];
    // Track whether markdown conversion happened (used in toast summary)
    let wasMarkdown = false;

    if (rawHtml.trim()) {
      console.log('🔧 [REFACTORED] Using new processor architecture');

      // Detect format using new detection system
      formatType = detectFormat(rawHtml);
      console.log(`📚 Detected format: ${formatType}`);

      // Get processor configuration
      const config = getFormatConfig(formatType);

      if (!config) {
        console.warn(`⚠️ No processor found for format: ${formatType}, using general`);
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
          console.log(`⚡ Running ${formatType} processor [LITE mode]...`);
          const result = await processor.processLite(rawHtml, targetBookId);
          htmlContent = result.html;
          formatType = result.formatType;
          extractedFootnotes = [];
          extractedReferences = [];
          console.log(`✅ [LITE] Processing complete (skipped footnote/reference extraction)`);
        } else {
          // 🐌 Large paste: Use full processing
          console.log(`⚙️ Running ${formatType} processor [FULL mode]...`);
          const result = await processor.process(rawHtml, targetBookId);
          htmlContent = result.html;
          formatType = result.formatType;
          extractedFootnotes = result.footnotes;
          extractedReferences = result.references;
          console.log(`✅ [FULL] Processing complete: ${extractedFootnotes.length} footnotes, ${extractedReferences.length} references`);
        }
      }

      console.log(`🎯 [${pasteOpId}] Format detected: ${formatType}`);
      console.log(`🎯 [${pasteOpId}] Extracted ${extractedFootnotes.length} footnotes, ${extractedReferences.length} references`);
    }
    // FALLBACK TO MARKDOWN/PLAINTEXT PATH
    else {
      const isMarkdown = detectMarkdown(plainText);
      if (isMarkdown) {
        wasMarkdown = true;
        console.log(`🎯 [${pasteOpId}] Markdown detected, converting to HTML`);
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
            console.error("Error during chunked conversion:", error);
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
    if (await handleHypercitePaste(event, targetBookId)) return;
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

      // Diagnostic logging to understand why insertion point failed
      const selection: any = window.getSelection();
      const currentNode = selection.anchorNode;
      const currentElement = currentNode?.nodeType === Node.TEXT_NODE ? currentNode.parentElement : currentNode;
      const mainContent = document.querySelector('.main-content');
      const chunksInDOM = document.querySelectorAll('[data-chunk-id]').length;
      const elementsWithNumericIds = document.querySelectorAll('[id]');
      const numericIdElements = Array.from<any>(elementsWithNumericIds).filter((el: any) => /^\d+(\.\d+)*$/.test(el.id));

      // Build parent chain string for error message
      const parentChain: any[] = [];
      let node = currentElement;
      while (node && node !== document.body) {
        const id = node.id ? `#${node.id}` : '';
        const classes = node.className ? `.${Array.from<any>(node.classList).join('.')}` : '';
        parentChain.push(`${node.tagName}${id}${classes}`);
        node = node.parentElement;
      }
      const parentChainStr = parentChain.join(' ← ');

      console.error(`❌ [${pasteOpId}] Could not determine insertion point. Aborting paste.`);
      console.error(`📍 Diagnostic Info - DOM STATE WHEN PASTE FAILED:`);
      console.error(`  - Cursor was in node:`, currentNode);
      console.error(`  - Cursor element:`, currentElement);
      console.error(`  - Element tag: ${currentElement?.tagName}`);
      console.error(`  - Element ID: "${currentElement?.id || '(none)'}"`);
      console.error(`  - Element classes: "${currentElement?.className || '(none)'}"`);
      console.error(`  - Parent chain: ${parentChainStr}`);
      console.error(`  - Chunks in DOM: ${chunksInDOM}`);
      console.error(`  - Elements with numeric IDs: ${numericIdElements.length}`);
      console.error(`  - Cursor inside .main-content: ${mainContent?.contains(currentNode)}`);
      console.error(`  - Current chunk element:`, chunkElement);

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
      console.log(`🎯 [${pasteOpId}] Paste resulted in no new nodes. Aborting render.`);
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
        console.error(`❌ [${pasteOpId}] Lazy loader not found for sub-book: ${targetBookId}`);
        await ProgressOverlayConductor.hide();
        return;
      }
      console.log(`✅ [${pasteOpId}] Using sub-book lazy loader: ${targetBookId}`);
    } else {
      // For main content, use the main lazy loader
      loader = initializeMainLazyLoader();
    }

    console.log(`🔄 [${pasteOpId}] Refreshing DOM via lazy loader...`);

    // 1. Update lazy loader cache from IndexedDB
    loader.nodes = await loader.getNodes();
    console.log(`✅ [${pasteOpId}] Lazy loader cache updated: ${loader.nodes.length} nodes`);

    // DEBUG: Log first pasted node's chunk assignment
    const firstPastedStartLine = newAndUpdatedNodes[0].startLine;
    const firstPastedChunkId = newAndUpdatedNodes[0].chunk_id;
    console.log(`🔍 [${pasteOpId}] First pasted node: ID=${firstPastedStartLine}, chunk_id=${firstPastedChunkId}`);

    // DEBUG: Check if first pasted node is in lazy loader cache
    const firstPastedInCache = loader.nodes.find((n: any) => n.startLine === firstPastedStartLine);
    console.log(`🔍 [${pasteOpId}] First pasted node in cache:`, firstPastedInCache ? `YES (chunk_id=${firstPastedInCache.chunk_id})` : 'NO');

    // DEBUG: Log all nodes in insertion chunk from cache
    const insertionChunkId = insertionPoint.chunkId;
    const nodesInInsertionChunk = loader.nodes.filter((n: any) => n.chunk_id === insertionChunkId);
    console.log(`🔍 [${pasteOpId}] Nodes in chunk ${insertionChunkId} from cache: ${nodesInInsertionChunk.length} nodes`);
    console.log(`🔍 [${pasteOpId}] Chunk ${insertionChunkId} startLine range:`,
      nodesInInsertionChunk.length > 0
        ? `${Math.min(...nodesInInsertionChunk.map((n: any) => n.startLine))} - ${Math.max(...nodesInInsertionChunk.map((n: any) => n.startLine))}`
        : 'EMPTY');

    // 2. Remove ALL chunks from DOM (clean slate)
    const allChunks = Array.from<any>(loader.container.querySelectorAll('[data-chunk-id]'));
    console.log(`🗑️ [${pasteOpId}] Removing ${allChunks.length} chunks from DOM for clean reload...`);

    allChunks.forEach((chunk: any) => {
      // parseChunkId = parseFloat (NOT parseInt): currentlyLoadedChunks holds decimal
      // chunk_ids, so a truncating delete would miss a fractional entry.
      const chunkId = parseChunkId(chunk.dataset.chunkId);
      chunk.remove();
      loader.currentlyLoadedChunks.delete(chunkId);
    });

    console.log(`✅ [${pasteOpId}] All chunks removed from DOM`);

    // 3. Reload only the insertion chunk (lazy loader will handle the rest on scroll)
    console.log(`📥 [${pasteOpId}] Reloading chunk ${insertionChunkId} with pasted content...`);
    loader.loadChunk(insertionChunkId, 'down');
    console.log(`✅ [${pasteOpId}] Chunk ${insertionChunkId} reloaded into DOM`);

    // Reposition sentinels to wrap around the newly loaded chunk
    loader.repositionSentinels();
    console.log(`✅ [${pasteOpId}] Sentinels repositioned for lazy loading`);

    // 4. Find first pasted node and scroll to it
    const firstPastedId = firstPastedStartLine.toString();
    const targetElement = document.getElementById(firstPastedId);

    if (targetElement) {
      console.log(`✨ [${pasteOpId}] Scrolling to first pasted element: ${firstPastedId}`);

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

      console.log(`✅ [${pasteOpId}] Scrolled to and focused pasted element`);
    } else {
      console.warn(`⚠️ [${pasteOpId}] Could not find pasted element: ${firstPastedId}`);
    }

    // Hide overlay immediately after scroll (DOM is already visible)
    await ProgressOverlayConductor.hide();
    console.log(`🎯 [${pasteOpId}] Progress overlay hidden - content visible`);

    console.log(`🎯 [${pasteOpId}] Paste render complete`);

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
      console.error('❌ Background full book sync failed:', err);
      glowCloudRed();
    });

    console.log(`🎯 [${pasteOpId}] Paste operation complete (full book sync happening in background)`);

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
