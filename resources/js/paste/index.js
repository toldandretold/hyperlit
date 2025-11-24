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

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { book } from '../app.js';
import { getCurrentChunk } from '../chunkManager.js';
import { initializeMainLazyLoader } from '../initializePage.js';
import { showTick } from '../components/editIndicator.js';
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
import { showProgressModal } from './ui/modalManager.js';

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
  editableDiv.addEventListener("paste", handlePaste);
}

// Export extractQuotedText for external use
// Re-export from utilities (moved to avoid circular dependency with hyperlights)
export { extractQuotedText } from '../utilities/textExtraction.js';

/**
 * Main paste event handler
 * Routes paste operations to appropriate handlers based on content type and size
 */
async function handlePaste(event) {
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

    // ✅ CHECK FOR YOUTUBE TRANSCRIPT - format for readability
    const youtubeDetection = detectYouTubeTranscript(plainText, rawHtml);
    if (youtubeDetection.isYouTube) {
      console.log(`📺 [${pasteOpId}] Detected YouTube transcript (${youtubeDetection.source}) - formatting for readability`);
      const transformedText = transformYouTubeTranscript(plainText, rawHtml, youtubeDetection.source);
      // Clear rawHtml to force plaintext path, then convert to HTML
      rawHtml = '';
      const dirty = marked(transformedText);
      htmlContent = DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
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
          const progressModal = await showProgressModal();
          // Store modal reference for later cleanup (after paste completes)
          window._activeProgressModal = progressModal;
          try {
            const dirty = await processMarkdownInChunks(plainText, (p, c, t) =>
              progressModal.updateProgress(p, c, t)
            );
            htmlContent = DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
            // Don't complete modal yet - wait until after paste and scroll complete
          } catch (error) {
            console.error("Error during chunked conversion:", error);
            progressModal.modal.remove();
            window._activeProgressModal = null;
            return;
          }
        } else {
          const dirty = marked(plainText);
          htmlContent = DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
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
      return;
    }

    const insertionPoint = getInsertionPoint(chunkElement, book);
    if (!insertionPoint) {
      console.error(`🎯 [${pasteOpId}] Could not determine insertion point. Aborting paste.`);
      return;
    }
    const contentToProcess = htmlContent || plainText;

    const newAndUpdatedNodes = await handleLargePaste(
      event,
      insertionPoint,
      contentToProcess,
      !!htmlContent,
      formatType, // Pass the detected format
      extractedFootnotes, // Pass processor-extracted footnotes
      extractedReferences // Pass processor-extracted references
    );

    if (!newAndUpdatedNodes || newAndUpdatedNodes.length === 0) {
      console.log(`🎯 [${pasteOpId}] Paste resulted in no new nodes. Aborting render.`);
      return;
    }

    const loader = initializeMainLazyLoader();

    console.log(`🔄 [${pasteOpId}] Updating DOM in place (like full renumbering)...`);

    // 1. Update lazy loader cache from IndexedDB
    loader.nodes = await loader.getNodeChunks();
    console.log(`✅ [${pasteOpId}] Lazy loader cache updated: ${loader.nodes.length} nodes`);

    // 2. Update existing DOM elements in place using node_id as stable reference
    // This mirrors the full renumbering approach in IDfunctions.js lines 182-194
    let domUpdateCount = 0;
    let newNodeCount = 0;

    newAndUpdatedNodes.forEach(node => {
      const element = document.querySelector(`[data-node-id="${node.node_id}"]`);

      if (element) {
        // Existing element - just update its ID
        const oldId = element.id;
        element.id = node.startLine.toString();
        domUpdateCount++;
        console.log(`🔄 [${pasteOpId}] Updated existing node: ${oldId} → ${node.startLine} (${node.node_id.slice(-10)})`);
      } else {
        // New pasted element - needs to be inserted
        newNodeCount++;
      }
    });

    console.log(`✅ [${pasteOpId}] Updated ${domUpdateCount} existing nodes in DOM`);
    console.log(`🆕 [${pasteOpId}] Found ${newNodeCount} new nodes that need insertion`);

    // 3. Insert new pasted nodes if any
    if (newNodeCount > 0) {
      // Find insertion point in DOM
      const insertionElement = document.getElementById(insertionPoint.beforeNodeId);
      if (insertionElement) {
        // Create temporary container for new nodes
        const tempContainer = document.createElement('div');

        // Filter for only NEW nodes (those not already in DOM)
        const newNodes = newAndUpdatedNodes.filter(n => !document.querySelector(`[data-node-id="${n.node_id}"]`));

        newNodes.forEach(node => {
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = node.content;
          const firstElement = tempDiv.querySelector('*');
          if (firstElement) {
            tempContainer.appendChild(firstElement);
          }
        });

        // Insert all new nodes after the insertion point
        let currentElement = insertionElement;
        Array.from(tempContainer.children).forEach(child => {
          currentElement.insertAdjacentElement('afterend', child);
          currentElement = child;
        });

        console.log(`✅ [${pasteOpId}] Inserted ${newNodes.length} new pasted nodes into DOM`);
      }
    }

    // 4. Find first pasted node for scrolling
    const firstPastedId = newAndUpdatedNodes[0].startLine.toString();

    // 5. Scroll to first pasted element
    requestAnimationFrame(() => {
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

      // Hide modal after scroll completes
      setTimeout(() => {
        if (window._activeProgressModal) {
          window._activeProgressModal.complete();
          window._activeProgressModal = null;
          console.log(`🎯 [${pasteOpId}] Progress modal completed`);
        }
      }, 100);
    });

    console.log(`🎯 [${pasteOpId}] Paste render complete`);

    console.log(`🎯 [${pasteOpId}] Paste operation complete`);

    // Show green indicator now that entire paste operation is complete
    // (sync, DOM manipulation, lazy loading, scrolling all done)
    showTick();

  } finally {
    // THIS IS ESSENTIAL: No matter what happens, re-enable the observer.
    setPasteInProgress(false);
    // Also clear the safety mechanism flag
    isPasteOperationInProgress = false;
  }
}
