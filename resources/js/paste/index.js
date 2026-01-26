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
 * paste/index.js (THIS FILE)        - Main orchestrator, event handling, routing logic
 * paste/handlers/                   - Specialized paste handlers (small, large, hypercite, code)
 * paste/ui/                          - UI components (modals, progress indicators)
 * paste/utils/                       - Reusable utilities (URL detection, markdown, HTML parsing)
 * paste/format-detection/            - Detects publisher formats (Cambridge, OUP, etc.)
 * paste/format-processors/           - Format-specific extraction pipelines
 *
 * ================================================================================================
 */

import { sanitizeHtml } from '../utilities/sanitizeConfig.js';
import { marked } from 'marked';
import { book } from '../app.js';
import { getCurrentChunk } from '../chunkManager.js';
import { initializeMainLazyLoader } from '../initializePage.js';
import { glowCloudGreen, glowCloudOrange, glowCloudRed } from '../components/editIndicator.js';
import {
  setPasteInProgress,
  isPasteInProgress as isPasteInProgressState
} from '../utilities/operationState.js';

// Import handlers
import { handleCodeBlockPaste } from './handlers/codeBlockHandler.js';
import { handleSmallPaste } from './handlers/smallPasteHandler.js';
import { handleLargePaste } from './handlers/largePasteHandler.js';
import { handleHypercitePaste, extractQuotedText } from './handlers/hyperciteHandler.js';

// Import UI
import { ProgressOverlayConductor } from '../navigation/ProgressOverlayConductor.js';

// Import utilities
import { detectFormat } from './format-detection/format-detector.js';
import { getFormatConfig } from './format-detection/format-registry.js';
import { detectAndConvertUrls } from './utils/url-detector.js';
import { detectMarkdown } from './utils/markdown-detector.js';
import { getInsertionPoint } from './utils/insertion-point-calculator.js';
import { processMarkdownInChunks } from './utils/markdown-processor.js';
import { estimatePasteNodeCount } from './utils/dom-helpers.js';
import { saveCurrentParagraph } from './handlers/hyperciteHandler.js';
import { detectYouTubeTranscript, transformYouTubeTranscript } from './utils/youtube-helpers.js';

// Configure marked options
marked.setOptions({
  breaks: true,        // Convert \n to <br>
  gfm: true,          // GitHub Flavored Markdown
  sanitize: false,    // We'll use DOMPurify instead
  smartypants: true   // Smart quotes, dashes, etc.
});

// Flag to prevent double-handling
let pasteHandled = false;

// Flag to temporarily disable safety mechanism during paste operations
let isPasteOperationInProgress = false;

export function isPasteOperationActive() {
  return isPasteOperationInProgress;
}

export function addPasteListener(editableDiv) {
  console.log("Adding modular paste listener");
  // Use capture phase to intercept before browser's native handling
  editableDiv.addEventListener("paste", handlePaste, { capture: true });

  // Also add beforeinput handler to catch insertFromPaste
  editableDiv.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertFromPaste") {
      console.log("🛑 beforeinput: insertFromPaste - preventing default");
      event.preventDefault();
    }
  }, { capture: true });
}

// Export extractQuotedText for external use
// Re-export from utilities (moved to avoid circular dependency with hyperlights)
export { extractQuotedText } from '../utilities/textExtraction.js';

/**
 * Sync pasted nodes to PostgreSQL in background
 * Fire-and-forget function that handles errors gracefully
 */
async function syncPasteToPostgreSQL(bookId) {
  console.log(`📤 Syncing FULL BOOK to PostgreSQL in background after paste...`);

  // Show orange indicator while syncing
  glowCloudOrange();

  try {
    // Get ALL nodes for the book from IndexedDB
    const { getNodeChunksFromIndexedDB } = await import('../indexedDB/index.js');
    const allNodes = await getNodeChunksFromIndexedDB(bookId);
    console.log(`📊 Retrieved ${allNodes.length} total nodes from IndexedDB for full book sync`);

    // ⚠️ CRITICAL DIAGNOSTIC: Check for incomplete IndexedDB data before destructive sync
    const chunkIds = [...new Set(allNodes.map(n => n.chunk_id))].sort((a, b) => a - b);
    const hasChunk0 = chunkIds.includes(0);
    const minStartLine = Math.min(...allNodes.map(n => n.startLine));
    const maxStartLine = Math.max(...allNodes.map(n => n.startLine));

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
      glowCloudRed();
      throw new Error(`Full book sync aborted: IndexedDB appears incomplete (missing chunk 0). This may indicate IndexedDB was cleared mid-session.`);
    }

    // Also warn if very few nodes (potential data loss)
    if (allNodes.length < 10 && allNodes.length > 0) {
      console.warn(`⚠️ SUSPICIOUS: Only ${allNodes.length} nodes in IndexedDB for full sync - potential data loss risk`);
    }

    // Full book sync: deletes all existing nodes for book, then inserts all fresh
    const response = await fetch('/api/db/node-chunks/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
      },
      credentials: 'include',
      body: JSON.stringify({
        book: bookId,
        data: allNodes
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Failed to sync full book to PostgreSQL:', error);
      glowCloudRed();
      throw new Error(`Full book sync failed: ${error}`);
    }

    const result = await response.json();
    console.log('✅ Full book synced to PostgreSQL:', result);

    // Show green tick when sync completes
    glowCloudGreen();

  } catch (error) {
    console.error('❌ Error syncing full book to PostgreSQL:', error);
    glowCloudRed();
    throw error; // Re-throw for caller's catch block
  }
}

/**
 * Main paste event handler
 * Routes paste operations to appropriate handlers based on content type and size
 */
async function handlePaste(event) {
  // CRITICAL: Prevent browser's default paste IMMEDIATELY before any processing
  // This stops the browser from inserting unsanitized content
  event.preventDefault();

  // 🎯 Generate unique paste operation ID for tracing
  const pasteOpId = `paste_${Date.now()}`;
  console.log(`🎯 [${pasteOpId}] Starting paste operation`);

  // Set the flag immediately to disable the MutationObserver
  setPasteInProgress(true);

  // Also set flag to disable safety mechanism
  isPasteOperationInProgress = true;

  try {
    // 1) Prevent double-handling
    if (pasteHandled) return;
    pasteHandled = true;
    setTimeout(() => (pasteHandled = false), 0);

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

    // Declare variables that will be used throughout the paste flow
    let htmlContent = "";
    let formatType = 'general'; // Default format

    // 🔍 DETECT RAW HTML SOURCE CODE (not rendered content)
    // If someone pastes HTML source code, wrap it in a code block instead of rendering
    const looksLikeRawHTMLCode = (
      (rawHtml.includes('&lt;') || rawHtml.includes('&gt;')) || // Escaped tags in HTML
      (plainText.match(/<[a-z]+[^>]*>/i) && rawHtml && !rawHtml.match(/<[a-z]+[^>]*>/i)) // Tags in plain but not in HTML
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
      htmlContent = sanitizeHtml(dirty);
      console.log(`✅ [${pasteOpId}] YouTube transcript transformed and converted to HTML`);
    }

    // ✅ CHECK FOR URL PASTE - convert to links or embeds
    const urlConversion = detectAndConvertUrls(plainText.trim());
    if (urlConversion.isUrl) {
      event.preventDefault();
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
    let extractedFootnotes = [];
    let extractedReferences = [];

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
        const result = await processor.process(rawHtml, book);
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
          const result = await processor.processLite(rawHtml, book);
          htmlContent = result.html;
          formatType = result.formatType;
          extractedFootnotes = [];
          extractedReferences = [];
          console.log(`✅ [LITE] Processing complete (skipped footnote/reference extraction)`);
        } else {
          // 🐌 Large paste: Use full processing
          console.log(`⚙️ Running ${formatType} processor [FULL mode]...`);
          const result = await processor.process(rawHtml, book);
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
        console.log(`🎯 [${pasteOpId}] Markdown detected, converting to HTML`);
        event.preventDefault(); // This is now safe to call

        if (plainText.length > 1000) {
          ProgressOverlayConductor.showSPATransition(5, 'Converting Markdown...', true);
          try {
            const dirty = await processMarkdownInChunks(plainText, (percent, current, total) => {
              ProgressOverlayConductor.updateProgress(percent, `Processing chunk ${current}/${total}`);
            });
            htmlContent = sanitizeHtml(dirty);
            // Don't hide overlay yet - wait until after paste and scroll complete
          } catch (error) {
            console.error("Error during chunked conversion:", error);
            await ProgressOverlayConductor.hide();
            return;
          }
        } else {
          const dirty = marked(plainText);
          htmlContent = sanitizeHtml(dirty);
        }
      }
    }

    // 4) Perform routing checks for special paste types.
    if (await handleHypercitePaste(event)) return;
    const chunk = getCurrentChunk();
    const chunkElement = chunk
      ? document.querySelector(`[data-chunk-id="${chunk}"],[id="${chunk}"]`)
      : null;
    if (handleCodeBlockPaste(event, chunkElement)) return;

    // 5) Route to the correct handler (small vs. large paste).
    if (handleSmallPaste(event, htmlContent, plainText, estimatedNodes, book)) {
      // Small paste completed - hide overlay if it was shown (markdown conversion)
      await ProgressOverlayConductor.hide();
      return;
    }

    const insertionPoint = getInsertionPoint(chunkElement, book);
    if (!insertionPoint) {
      // Prevent browser default paste that would dump raw HTML into DOM
      event.preventDefault();

      // Diagnostic logging to understand why insertion point failed
      const selection = window.getSelection();
      const currentNode = selection.anchorNode;
      const currentElement = currentNode?.nodeType === Node.TEXT_NODE ? currentNode.parentElement : currentNode;
      const mainContent = document.querySelector('.main-content');
      const chunksInDOM = document.querySelectorAll('[data-chunk-id]').length;
      const elementsWithNumericIds = document.querySelectorAll('[id]');
      const numericIdElements = Array.from(elementsWithNumericIds).filter(el => /^\d+(\.\d+)*$/.test(el.id));

      // Build parent chain string for error message
      const parentChain = [];
      let node = currentElement;
      while (node && node !== document.body) {
        const id = node.id ? `#${node.id}` : '';
        const classes = node.className ? `.${Array.from(node.classList).join('.')}` : '';
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

    const pasteResult = await handleLargePaste(
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

    const loader = initializeMainLazyLoader();

    console.log(`🔄 [${pasteOpId}] Refreshing DOM via lazy loader...`);

    // 1. Update lazy loader cache from IndexedDB
    loader.nodes = await loader.getNodeChunks();
    console.log(`✅ [${pasteOpId}] Lazy loader cache updated: ${loader.nodes.length} nodes`);

    // DEBUG: Log first pasted node's chunk assignment
    const firstPastedStartLine = newAndUpdatedNodes[0].startLine;
    const firstPastedChunkId = newAndUpdatedNodes[0].chunk_id;
    console.log(`🔍 [${pasteOpId}] First pasted node: ID=${firstPastedStartLine}, chunk_id=${firstPastedChunkId}`);

    // DEBUG: Check if first pasted node is in lazy loader cache
    const firstPastedInCache = loader.nodes.find(n => n.startLine === firstPastedStartLine);
    console.log(`🔍 [${pasteOpId}] First pasted node in cache:`, firstPastedInCache ? `YES (chunk_id=${firstPastedInCache.chunk_id})` : 'NO');

    // DEBUG: Log all nodes in insertion chunk from cache
    const insertionChunkId = insertionPoint.chunkId;
    const nodesInInsertionChunk = loader.nodes.filter(n => n.chunk_id === insertionChunkId);
    console.log(`🔍 [${pasteOpId}] Nodes in chunk ${insertionChunkId} from cache: ${nodesInInsertionChunk.length} nodes`);
    console.log(`🔍 [${pasteOpId}] Chunk ${insertionChunkId} startLine range:`,
      nodesInInsertionChunk.length > 0
        ? `${Math.min(...nodesInInsertionChunk.map(n => n.startLine))} - ${Math.max(...nodesInInsertionChunk.map(n => n.startLine))}`
        : 'EMPTY');

    // 2. Remove ALL chunks from DOM (clean slate)
    const allChunks = Array.from(loader.container.querySelectorAll('[data-chunk-id]'));
    console.log(`🗑️ [${pasteOpId}] Removing ${allChunks.length} chunks from DOM for clean reload...`);

    allChunks.forEach(chunk => {
      const chunkId = parseInt(chunk.dataset.chunkId);
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
      const selection = window.getSelection();
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

    // Sync FULL BOOK to PostgreSQL in background (fire and forget - don't block user)
    // Full sync ensures no orphaned records after paste renumbering
    syncPasteToPostgreSQL(pasteBook).catch(err => {
      console.error('❌ Background full book sync failed:', err);
      glowCloudRed();
    });

    console.log(`🎯 [${pasteOpId}] Paste operation complete (full book sync happening in background)`);

  } finally {
    // THIS IS ESSENTIAL: No matter what happens, re-enable the observer.
    setPasteInProgress(false);
    // Also clear the safety mechanism flag
    isPasteOperationInProgress = false;
  }
}
