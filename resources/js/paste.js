import { getNextIntegerId, generateIdBetween, setElementIds, generateNodeId } from './IDfunctions.js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { 
  trackChunkNodeCount, 
  handleChunkOverflow, 
  NODE_LIMIT, 
  chunkNodeCounts,
  getCurrentChunk
} from './chunkManager.js';
import { book } from './app.js';
import { getNodeChunksAfter,
         deleteNodeChunksAfter,
         writeNodeChunks,
         updateCitationForExistingHypercite,
         queueForSync,
         getNodeChunksFromIndexedDB,
         addCitationToHypercite,
         getHyperciteFromIndexedDB,
         updateHyperciteInIndexedDB,
         getNodeChunkFromIndexedDB,
         toPublicChunk } from './indexedDB.js';
import { syncIndexedDBtoPostgreSQL } from './postgreSQL.js';
import { initializeMainLazyLoader } from './initializePage.js';
import { parseHyperciteHref } from './hyperCites.js';
import { navigateToInternalId } from './scrolling.js';
import {
  getHandleHypercitePaste,
  setHandleHypercitePaste,
  isPasteInProgress,
  setPasteInProgress
} from './operationState.js';
import { queueNodeForSave } from './divEditor.js';
import { broadcastToOpenTabs } from './BroadcastListener.js';
import { processContentForFootnotesAndReferences } from './footnoteReferenceExtractor.js';
import { showSpinner, showTick, showError } from './editIndicator.js';
import { detectFormat } from './paste/format-detection/format-detector.js';
import { getFormatConfig } from './paste/format-detection/format-registry.js';

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

/**
 * Detect if pasted text is a URL and convert to appropriate HTML
 * @param {string} text - The pasted text
 * @returns {Object} - { isUrl, isYouTube, html, url }
 */
function detectAndConvertUrls(text) {
  // Trim and normalize whitespace (remove all newlines/returns)
  const trimmed = text.trim().replace(/[\n\r]/g, '');
  if (!trimmed) {
    return { isUrl: false };
  }

  // Check if it's a valid URL
  const urlPattern = /^https?:\/\/.+/i;
  if (!urlPattern.test(trimmed)) {
    return { isUrl: false };
  }

  // Security: Limit URL length to prevent DoS attacks
  const MAX_URL_LENGTH = 2048; // Standard browser limit
  if (trimmed.length > MAX_URL_LENGTH) {
    console.warn(`URL too long (${trimmed.length} chars), max is ${MAX_URL_LENGTH}`);
    return { isUrl: false };
  }

  // Validate it's actually a URL
  let url;
  try {
    url = new URL(trimmed);
  } catch (e) {
    return { isUrl: false };
  }

  // Security: Only allow http/https protocols (block javascript:, data:, file:, etc.)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn(`Blocked unsafe URL protocol: ${url.protocol}`);
    return { isUrl: false };
  }

  // Check for image URLs
  const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i;
  if (imageExtensions.test(url.pathname)) {
    // Escape URL for safe insertion (prevent attribute breakout)
    const safeUrl = escapeHtml(url.href);
    const imageHtml = `<img src="${safeUrl}" class="external-link" alt="Pasted image" referrerpolicy="no-referrer" />`;

    return {
      isUrl: true,
      isImage: true,
      html: imageHtml,
      url: url.href
    };
  }

  // Check for YouTube URLs

  const youtubePatterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|m\.youtube\.com\/watch\?v=|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of youtubePatterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      const videoId = match[1];

      // Generate YouTube embed HTML (IDs will be added by setElementIds later)
      // Note: Outer div is selectable (for deletion), inner wrapper is not editable
      const embedHtml = `<div class="video-embed">
  <button class="video-delete-btn" contenteditable="false" aria-label="Delete video" data-action="delete-video">×</button>
  <div class="video-wrapper" contenteditable="false">
    <iframe src="https://www.youtube.com/embed/${videoId}"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen>
    </iframe>
  </div>
</div>`;

      return {
        isUrl: true,
        isYouTube: true,
        html: embedHtml,
        url: trimmed,
        videoId
      };
    }
  }

  // Regular URL - create link with HTML-escaped display text
  const escapedDisplayUrl = escapeHtml(url.href);
  const escapedHrefUrl = escapeHtml(url.href);
  const linkHtml = `<a href="${escapedHrefUrl}" class="external-link" target="_blank" rel="noopener noreferrer">${escapedDisplayUrl}</a>`;

  return {
    isUrl: true,
    isYouTube: false,
    html: linkHtml,
    url: url.href
  };
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - HTML-escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function isPasteOperationActive() {
  return isPasteOperationInProgress;
}

export function addPasteListener(editableDiv) {
  console.log("Adding modular paste listener");
  editableDiv.addEventListener("paste", handlePaste); 
}
// 0) Create the modal but don't append yet
const conversionModal = document.createElement("div");
conversionModal.id = "conversion-modal";
conversionModal.style.cssText = `
  position: fixed;
  inset: 0;                 /* shorthand for top/right/bottom/left:0 */
  display: none;
  align-items: center;
  justify-content: center;
  background: #221F20;
  z-index: 9999;
  color: #221F20;
`;
conversionModal.innerHTML = `
  <div style="
    background: #CBCCCC;
    padding: 1em 2em;
    border-radius: 4px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    font: 16px sans-serif;
  ">
    <p id="conversion-message" style="margin:0">
      Converting… 
    </p>
  </div>
`;

// 1) Once DOMContentLoaded, append it exactly once
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(conversionModal);
  });
} else {
  document.body.appendChild(conversionModal);
}

// 2) show/hide helpers with double-rAF
async function showConversionModal(message) {
  conversionModal.querySelector("#conversion-message").textContent = message;
  conversionModal.style.display = "flex";
  // wait two frames to be sure it painted
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
}
function hideConversionModal() {
  conversionModal.style.display = "none";
}


// Update your modal to show progress
async function showProgressModal() {
  const modal = document.createElement("div");
  modal.className = "progress-modal";
  
  modal.innerHTML = `
    <div class="progress-modal-content">
      <p class="progress-text">Converting Markdown...</p>
      <div class="progress-bar-container">
        <div class="progress-bar"></div>
      </div>
      <p class="progress-details">Preparing...</p>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const bar = modal.querySelector('.progress-bar');
  const text = modal.querySelector('.progress-text');
  const details = modal.querySelector('.progress-details');
  
  return {
    modal,
    updateProgress: (percent, current, total) => {
      bar.style.width = percent + '%';
      text.textContent = `Converting Markdown... ${Math.round(percent)}%`;
      details.textContent = `Processing chunk ${current} of ${total}`;
    },
    complete: () => {
      bar.style.width = '100%';
      text.textContent = 'Conversion Complete!';
      details.textContent = 'Finalizing...';
      setTimeout(() => modal.remove(), 500);
    }
  };
}


/**
 * The definitive paste handler. It uses CONDITIONAL anchor injection.
 * - If a link target is a BLOCK element (p, li, h1...), it injects an <a>
 *   tag to hold the ID, freeing the block for a system ID.
 * - If a link target is an INLINE element (a, sup, b...), it simply prefixes
 *   the ID on the element itself, preserving its structure.
 */
async function assimilateHTML(rawHtml) {
  console.log('🔧 [REFACTORED] Using new processor architecture');

  // Detect format using new detection system
  const formatType = detectFormat(rawHtml);
  console.log(`📚 Detected format: ${formatType}`);

  // Get processor configuration
  const config = getFormatConfig(formatType);

  if (!config) {
    console.warn(`⚠️ No processor found for format: ${formatType}, using general`);
    const generalConfig = getFormatConfig('general');
    const ProcessorClass = generalConfig.processor;
    const processor = new ProcessorClass();
    const result = await processor.process(rawHtml, book);
    return {
      html: result.html,
      format: 'general',
      footnotes: result.footnotes,
      references: result.references
    };
  }

  // Instantiate and run processor
  const ProcessorClass = config.processor;
  const processor = new ProcessorClass();

  console.log(`⚙️ Running ${formatType} processor...`);
  const result = await processor.process(rawHtml, book);

  console.log(`✅ Processing complete: ${result.footnotes.length} footnotes, ${result.references.length} references`);

  return {
    html: result.html,
    format: result.formatType,
    footnotes: result.footnotes,
    references: result.references
  };
}

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

    // PRIORITIZE HTML PATH
    let extractedFootnotes = [];
    let extractedReferences = [];

    if (rawHtml.trim()) {
      const assimilated = await assimilateHTML(rawHtml);
      htmlContent = assimilated.html;
      formatType = assimilated.format;
      extractedFootnotes = assimilated.footnotes || [];
      extractedReferences = assimilated.references || [];
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

    // 3) Get our reliable estimate.
    const estimatedNodes = estimatePasteNodeCount(htmlContent || plainText);
    console.log(`🎯 [${pasteOpId}] Content analyzed: ${plainText.length} chars, ~${estimatedNodes} nodes`);

    // 4) Perform routing checks for special paste types.
    if (await handleHypercitePaste(event)) return; // Make sure this is awaited if it's async
    const chunk = getCurrentChunk();
    const chunkElement = chunk
      ? document.querySelector(`[data-chunk-id="${chunk}"],[id="${chunk}"]`)
      : null;
    if (handleCodeBlockPaste(event, chunkElement)) return;

    // 5) Route to the correct handler (small vs. large paste).
    if (handleSmallPaste(event, htmlContent, plainText, estimatedNodes)) {
      return;
    }

    const insertionPoint = getInsertionPoint(chunkElement);
    if (!insertionPoint) {
      console.error(`🎯 [${pasteOpId}] Could not determine insertion point. Aborting paste.`);
      return;
    }
    const contentToProcess = htmlContent || plainText;

    const newAndUpdatedNodes = await handleJsonPaste(
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

    console.log(`🔄 [${pasteOpId}] Updating lazy loader cache...`);

    // 1. Update cache from IndexedDB (truth source)
    loader.nodeChunks = await loader.getNodeChunks();
    console.log(`✅ [${pasteOpId}] Lazy loader cache updated: ${loader.nodeChunks.length} nodes`);

    // 2. Clear all chunks below insertion point from DOM
    const insertionElement = document.getElementById(insertionPoint.beforeNodeId);
    if (insertionElement) {
      console.log(`🧹 [${pasteOpId}] Clearing chunks below insertion point...`);
      let sibling = insertionElement.nextElementSibling;
      let clearedCount = 0;

      while (sibling) {
        const next = sibling.nextElementSibling; // Save before removal

        if (sibling.hasAttribute('data-chunk-id')) {
          const chunkId = sibling.dataset.chunkId;
          loader.currentlyLoadedChunks.delete(chunkId);
          sibling.remove();
          clearedCount++;
        }

        sibling = next;
      }

      console.log(`✅ [${pasteOpId}] Cleared ${clearedCount} chunks from DOM`);
    }

    // 3. Find first pasted node
    const firstPastedNode = newAndUpdatedNodes[0];
    const targetChunkId = firstPastedNode.chunk_id;
    const firstPastedId = firstPastedNode.startLine.toString();

    console.log(`🎯 [${pasteOpId}] First pasted element: ${firstPastedId} in chunk ${targetChunkId}`);

    // 4. Reload target chunk if already loaded (contains old data + new pasted content)
    if (loader.currentlyLoadedChunks.has(targetChunkId)) {
      console.log(`🔄 [${pasteOpId}] Reloading chunk ${targetChunkId} with fresh pasted content`);
      const oldChunkElement = loader.container.querySelector(`[data-chunk-id="${targetChunkId}"]`);
      if (oldChunkElement) {
        oldChunkElement.remove();
      }
      loader.currentlyLoadedChunks.delete(targetChunkId);
    }

    // 5. Load chunk containing first pasted content
    console.log(`📦 [${pasteOpId}] Loading chunk ${targetChunkId}`);
    loader.loadChunk(targetChunkId, "down");

    // 5a. Reposition sentinels to ensure lazy loading continues working
    console.log(`🔄 [${pasteOpId}] Repositioning sentinels for continued lazy loading`);
    const { repositionSentinels } = await import('./lazyLoaderFactory.js');
    repositionSentinels(loader, true);

    // 6. Scroll to first pasted element (use requestAnimationFrame to ensure chunk rendered)
    requestAnimationFrame(() => {
      const targetElement = document.getElementById(firstPastedId);

      if (targetElement) {
        console.log(`✨ [${pasteOpId}] Scrolling to first pasted element: ${firstPastedId}`);

        // Instant scroll to top of viewport
        targetElement.scrollIntoView({ block: 'start', behavior: 'instant' });

        // Set focus
        targetElement.focus();

        // Place cursor at end
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

      // 7. Hide modal after scroll completes
      setTimeout(() => {
        if (window._activeProgressModal) {
          window._activeProgressModal.complete();
          window._activeProgressModal = null;
          console.log(`🎯 [${pasteOpId}] Progress modal completed`);
        }
      }, 100);
    });

    console.log(`🎯 [${pasteOpId}] Paste render complete - chunks loaded`);

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

function getInsertionPoint(chunkElement) {
  const selection = window.getSelection();
  const range = selection.getRangeAt(0);
  const currentNode = range.startContainer;

  // Find the current node element (handle text nodes)
  let currentNodeElement = currentNode.nodeType === Node.TEXT_NODE
    ? currentNode.parentElement
    : currentNode;

  // Traverse up to find parent with numerical ID (including decimals)
  while (currentNodeElement && currentNodeElement !== chunkElement) {
    const id = currentNodeElement.id;

    // Check if ID exists and is numerical (including decimals)
    if (id && /^\d+(\.\d+)*$/.test(id)) {
      break; // Found our target element
    }

    // Move up to parent
    currentNodeElement = currentNodeElement.parentElement;
  }

  // If we didn't find a numerical ID, we might be at chunk level or need fallback
  if (!currentNodeElement || !currentNodeElement.id || !/^\d+(\.\d+)*$/.test(currentNodeElement.id)) {
    console.warn('Could not find parent element with numerical ID');
    return null;
  }

  const currentNodeId = currentNodeElement.id;
  const chunkId = chunkElement.dataset.chunkId || chunkElement.id;

  // Current node becomes the beforeNodeId (we're inserting after it)
  const beforeNodeId = currentNodeId;

  // Find the next element with a numerical ID (this is the afterNodeId)
  let afterElement = currentNodeElement.nextElementSibling;

  while (afterElement) {
    if (afterElement.id && /^\d+(\.\d+)*$/.test(afterElement.id)) {
      break;
    }

    afterElement = afterElement.nextElementSibling;
  }

  const afterNodeId = afterElement?.id || null;

  // Use existing chunk tracking
  const currentChunkNodeCount = chunkNodeCounts[chunkId] || 0;

  const result = {
    chunkId: chunkId,
    currentNodeId: currentNodeId,
    beforeNodeId: beforeNodeId,
    afterNodeId: afterNodeId,
    currentChunkNodeCount: currentChunkNodeCount,
    insertionStartLine: parseInt(currentNodeId), // startLine = node ID
    book: book // Available as const
  };

  console.log(`Insertion point: before=${beforeNodeId}, after=${afterNodeId || 'end'}, chunk=${chunkId}`);
  return result;
}

async function processMarkdownInChunks(text, onProgress) {
  const chunkSize = 50000; // 50KB chunks - adjust as needed
  const chunks = [];
  
  // Split on paragraph boundaries to avoid breaking markdown structure
  const paragraphs = text.split(/\n\s*\n/);
  let currentChunk = '';
  
  for (const para of paragraphs) {
    if (currentChunk.length + para.length > chunkSize && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  
  console.log(`Processing ${chunks.length} chunks, average size: ${Math.round(text.length / chunks.length)} chars`);
  
  let result = '';
  for (let i = 0; i < chunks.length; i++) {
    const progress = ((i + 1) / chunks.length) * 100;
    onProgress(progress, i + 1, chunks.length);
    
    // Process chunk (smart quotes already normalized at paste entry)
    const chunkHtml = marked(chunks[i]);
    result += chunkHtml;
    
    // Let browser breathe between chunks
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  
  return result;
}

// (1) change convertToJsonObjects to return both the list
//     and the final state it left off in

function convertToJsonObjects(textBlocks, insertionPoint) {
  const jsonObjects = [];

  let currentChunkId       = insertionPoint.chunkId;
  let nodesInCurrentChunk  = insertionPoint.currentChunkNodeCount;
  let beforeId             = insertionPoint.beforeNodeId;
  const afterId            = insertionPoint.afterNodeId;

  textBlocks.forEach((block) => {
    // rotate chunk?
    if (nodesInCurrentChunk >= NODE_LIMIT) {
      currentChunkId      = getNextIntegerId(currentChunkId);
      nodesInCurrentChunk = 0;
    }

    // Generate new node ID with 100-unit gaps (like renumbering system)
    const beforeNum = Math.floor(parseFloat(beforeId));
    const newNodeId = (beforeNum + 100).toString();

    // Generate stable node_id for this pasted node
    const nodeId = generateNodeId(insertionPoint.book);

    const trimmed     = block.trim();
    const htmlContent = convertTextToHtml(trimmed, newNodeId, nodeId);

    const key = `${insertionPoint.book},${newNodeId}`;
    jsonObjects.push({
      [key]: {
        content:   htmlContent,
        startLine: parseFloat(newNodeId),
        chunk_id:  parseFloat(currentChunkId),
        node_id:   nodeId  // Store node_id for tracking through renumbering
      }
    });

    // advance
    beforeId            = newNodeId;
    nodesInCurrentChunk++;
  });

  return {
    jsonObjects,
    state: {
      currentChunkId,
      nodesInCurrentChunk,
      beforeId
    }
  };
}



function isCompleteHTML(text) {
  // Basic check if the text appears to be complete HTML
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<") &&
    trimmed.endsWith(">") &&
    (trimmed.includes("</") || trimmed.match(/<\s*[a-z]+[^>]*\/>/i))
  );
}

function handleCodeBlockPaste(event, chunk) {
  const plainText = event.clipboardData.getData("text/plain");
  const htmlContent = event.clipboardData.getData("text/html");

  // Get the current selection and find if we're in a code block
  const selection = window.getSelection();
  if (!selection.rangeCount) return false;

  const range = selection.getRangeAt(0);
  let currentNode = range.startContainer;
  if (currentNode.nodeType !== Node.ELEMENT_NODE) {
    currentNode = currentNode.parentElement;
  }

  // Check if we're in a code block
  const codeBlock = currentNode.closest("pre");
  if (!codeBlock) return false;

  // If we have HTML content and it appears to be complete HTML
  if (htmlContent && isCompleteHTML(plainText)) {
    event.preventDefault();

    // Just insert the plain text directly
    range.deleteContents();
    const textNode = document.createTextNode(plainText);
    range.insertNode(textNode);

    // Update the code block in IndexedDB
    queueNodeForSave(codeBlock.id, 'update');

    return true;
  }

  return false;
}

/**
 * Handle small paste operations (≤ SMALL_NODE_LIMIT nodes)
 * @param {Event} event - The paste event
 * @param {string} htmlContent - Processed HTML content (from markdown or sanitized)
 * @param {string} plainText - Original plain text
 * @param {number} actualNodeCount - Actual node count
 * @param {number} estimatedNodes - Estimated node count
 * @returns {boolean} - True if handled, false if should continue to large paste handler
 */


function handleSmallPaste(event, htmlContent, plainText, nodeCount) {
  const SMALL_NODE_LIMIT = 20;

  if (nodeCount > SMALL_NODE_LIMIT) {
    return false; // Not a small paste, continue to large paste handler
  }

  console.log(
    `Small paste (≈${nodeCount} nodes); handling with browser insertion and ID fix-up.`
  );

  // --- 1. PREPARE THE CONTENT (initial) ---
  let finalHtmlToInsert = htmlContent;

  // --- 2. GET INSERTION CONTEXT (BEFORE PASTING) ---
  const selection = window.getSelection();
  if (!selection.rangeCount) return true;

  const range = selection.getRangeAt(0);
  let currentElement = range.startContainer;
  if (currentElement.nodeType === Node.TEXT_NODE) {
    currentElement = currentElement.parentElement;
  }

  let currentBlock = currentElement.closest(
    "p, h1, h2, h3, h4, h5, h6, div, pre, blockquote"
  );

  if (
    !currentBlock ||
    !currentBlock.id ||
    !/^\d+(\.\d+)*$/.test(currentBlock.id)
  ) {
    console.warn(
      "Small paste aborted: Could not find a valid anchor block with a numerical ID."
    );
    // Allow native paste as a fallback in this edge case.
    return false;
  }

  // --- 2.5. FINALIZE CONTENT PREPARATION (now that we have currentBlock) ---

  // If we only have plain text, convert it to structured HTML.
  if (!finalHtmlToInsert && plainText) {
    const parts = plainText
      .split(/\n\s*\n/) // Split on blank lines
      .filter((p) => p.trim());

    // Don't wrap in <p> if we're already inside a block element
    if (parts.length === 1 && currentBlock) {
      finalHtmlToInsert = parts[0];
    } else {
      finalHtmlToInsert = parts.map((p) => `<p>${p}</p>`).join("");
    }
  }

  // If pasting HTML with a single <p> wrapper into an existing <p>, unwrap it
  if (finalHtmlToInsert && currentBlock) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = finalHtmlToInsert;

    // Check if content is a single <p> tag
    if (tempDiv.children.length === 1 && tempDiv.children[0].tagName === 'P') {
      // Unwrap: use innerHTML of the <p> instead of the entire <p>
      finalHtmlToInsert = tempDiv.children[0].innerHTML;
      console.log(`Unwrapped <p> tag to prevent nesting in paste`);
    }
  }

  // If there's nothing to insert, we're done.
  if (!finalHtmlToInsert) {
    return true;
  }

  // --- 3. PERFORM THE PASTE ---
  event.preventDefault(); // Take control from the browser!

  // Save currentBlock's data-node-id before paste (execCommand may replace the element)
  const savedNodeId = currentBlock ? currentBlock.getAttribute('data-node-id') : null;
  const savedBlockId = currentBlock ? currentBlock.id : null;

  // Check if we're pasting into an H1 AND pasting block-level content
  const isH1Destination = currentBlock && currentBlock.tagName === 'H1';

  // Detect if pasted content contains block-level elements
  let hasBlockElements = false;
  if (isH1Destination && finalHtmlToInsert) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = finalHtmlToInsert;
    hasBlockElements = tempDiv.querySelector('p, h1, h2, h3, h4, h5, h6, div, blockquote, ul, ol, pre') !== null;
  }

  if (isH1Destination && hasBlockElements) {
    console.log(`H1 destination with block-level content - using manual insertion to prevent nesting`);

    // Parse the HTML content to extract individual blocks
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = finalHtmlToInsert;
    const blocks = Array.from(tempDiv.children);

    if (blocks.length > 0) {
      // 1. Replace H1 content with first block's content (but keep it as H1)
      const firstBlock = blocks[0];
      if (firstBlock.tagName === 'H1') {
        // If first pasted block is also H1, use its content
        currentBlock.innerHTML = firstBlock.innerHTML;
      } else {
        // Convert first pasted block content to H1 content
        currentBlock.innerHTML = firstBlock.innerHTML;
      }

      // 2. Insert remaining blocks AFTER the H1 as siblings
      let insertAfter = currentBlock;
      for (let i = 1; i < blocks.length; i++) {
        const blockToInsert = blocks[i].cloneNode(true);
        insertAfter.parentNode.insertBefore(blockToInsert, insertAfter.nextSibling);
        insertAfter = blockToInsert;
      }

      console.log(`Manually inserted ${blocks.length} blocks: 1 into H1, ${blocks.length - 1} as siblings`);
    }
  } else {
    // Normal paste - use execCommand (safe for text/inline content or non-H1 destinations)
    document.execCommand("insertHTML", false, finalHtmlToInsert);
  }

  // --- 4. FIX-UP: ASSIGN IDS TO NEWLY CREATED ELEMENTS ---
  console.log("Fix-up phase: Scanning for new nodes to assign IDs.");

  // The original block was modified, so save it.
  queueNodeForSave(currentBlock.id, "update");

  // Re-query currentBlock by ID (execCommand may have replaced it in DOM)
  const liveCurrentBlock = savedBlockId ? document.getElementById(savedBlockId) : null;

  if (liveCurrentBlock) {
    // Restore data-node-id if element was replaced by execCommand
    if (savedNodeId && !liveCurrentBlock.getAttribute('data-node-id')) {
      liveCurrentBlock.setAttribute('data-node-id', savedNodeId);
      console.log(`Restored data-node-id to element #${savedBlockId} after paste`);
    } else if (!liveCurrentBlock.getAttribute('data-node-id')) {
      // No saved node ID, generate a new one
      const newNodeId = generateNodeId(book);
      liveCurrentBlock.setAttribute('data-node-id', newNodeId);
      console.log(`Added new data-node-id to element #${savedBlockId}`);
    }
    // Update reference for subsequent loop
    currentBlock = liveCurrentBlock;
  } else {
    console.warn(`Could not find element #${savedBlockId} after paste - element may have been removed`);
  }

  // Find the ID of the next "stable" node that already has an ID.
  let nextStableElement = currentBlock ? currentBlock.nextElementSibling :
    currentElement.closest(".chunk")?.firstElementChild?.nextElementSibling;
  while (
    nextStableElement &&
    (!nextStableElement.id || !/^\d+(\.\d+)*$/.test(nextStableElement.id))
  ) {
    nextStableElement = nextStableElement.nextElementSibling;
  }
  const nextStableNodeId = nextStableElement ? nextStableElement.id : null;

  // Now, iterate through the new nodes between our original block and the next stable one.
  let lastKnownId = currentBlock.id;
  let elementToProcess = currentBlock.nextElementSibling;

  while (elementToProcess && elementToProcess !== nextStableElement) {
    // Process all block-level elements to ensure they have both id and data-node-id
    if (elementToProcess.matches("p, h1, h2, h3, h4, h5, h6, div, pre, blockquote")) {
      const hasValidId = elementToProcess.id && /^\d+(\.\d+)*$/.test(elementToProcess.id);
      const hasNodeId = elementToProcess.getAttribute('data-node-id');

      if (!hasValidId) {
        // Element needs a new numerical ID (and data-node-id)
        const newId = setElementIds(elementToProcess, lastKnownId, nextStableNodeId, book);
        console.log(`Assigned new ID ${newId} to pasted element.`);
        queueNodeForSave(newId, "create");
        lastKnownId = newId;
      } else if (!hasNodeId) {
        // Element has valid numerical ID but missing data-node-id
        elementToProcess.setAttribute('data-node-id', generateNodeId(book));
        console.log(`Added data-node-id to pasted element with existing ID ${elementToProcess.id}`);
        queueNodeForSave(elementToProcess.id, "create");
        lastKnownId = elementToProcess.id;
      } else {
        // Element has both IDs - CHECK if the ID is valid for this position
        const elementId = parseFloat(elementToProcess.id);
        const lastKnownNum = parseFloat(lastKnownId);
        const nextStableNum = nextStableNodeId ? parseFloat(nextStableNodeId) : null;

        // Validate: Is this ID in the correct sequential position?
        const needsNewId =
          elementId <= lastKnownNum || // ID is not greater than previous
          (nextStableNum && elementId >= nextStableNum); // ID is not less than next

        if (needsNewId) {
          // Generate new positional ID, but PRESERVE existing data-node-id
          const existingNodeId = elementToProcess.getAttribute('data-node-id');
          const newId = generateIdBetween(lastKnownId, nextStableNodeId);
          elementToProcess.id = newId;
          console.log(`Updated pasted element ID: ${elementToProcess.id} → ${newId} (preserved data-node-id: ${existingNodeId})`);
          queueNodeForSave(newId, 'update'); // Update since it has existing node_id
          lastKnownId = newId;
        } else {
          // ID is already correct for this position
          console.log(`Pasted element ID ${elementToProcess.id} is valid for position`);
          lastKnownId = elementToProcess.id;
        }
      }
    }
    elementToProcess = elementToProcess.nextElementSibling;
  }

  // --- 5. FINALIZE ---
  // The cursor is already placed correctly by execCommand.
  return true; // We handled it.
}

/**
 * Estimate how many nodes a paste operation will create
 */
/**
 * Estimate how many nodes a paste operation will create
 */
function estimatePasteNodeCount(content) {
  if (typeof content !== 'string') {
    return 1
  }

  // Quick & dirty HTML detection
  const isHTML = /<([a-z]+)(?:\s[^>]*)?>/i.test(content)

  if (isHTML) {
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = content

    let count = 0

    // Count block-level elements
    count +=
      tempDiv.querySelectorAll(
        'p, h1, h2, h3, h4, h5, h6, div, pre, blockquote, li'
      ).length

    // Count <br> as its own node
    count += tempDiv.querySelectorAll('br').length

    // Count top-level text fragments as paragraphs
    tempDiv.childNodes.forEach(node => {
      if (
        node.nodeType === Node.TEXT_NODE &&
        node.textContent.trim()
      ) {
        const paras = node.textContent
          .split(/\n\s*\n/) // split on blank lines
          .filter(p => p.trim())
        count += paras.length
      }
    })

    return Math.max(1, count)
  } else {
    // Plain text: first try splitting on blank lines
    const paragraphs = content
      .split(/\n\s*\n/)
      .filter(p => p.trim())

    if (paragraphs.length > 1) {
      return paragraphs.length
    }

    // Fallback: split on every newline
    const lines = content
      .split('\n')
      .filter(line => line.trim())

    return Math.max(1, lines.length)
  }
}

function convertTextToHtml(content, startLineId, nodeId) {
  // Check if content is already HTML
  if (content.trim().startsWith('<') && content.trim().endsWith('>')) {
    // It's HTML - add/update the ID and data-node-id on the first element
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;

    // Find the first element and give it the IDs
    const firstElement = tempDiv.querySelector('*');
    if (firstElement) {
      firstElement.id = startLineId;
      firstElement.setAttribute('data-node-id', nodeId);
      return tempDiv.innerHTML;
    }

    // Fallback if no elements found
    return content;
  } else {
    // It's plain text - wrap in paragraph with both id and data-node-id
    return `<p id="${startLineId}" data-node-id="${nodeId}">${content}</p>`;
  }
}

/**
 * 1) Assumes you have this helper already defined:
 *    async function getNodeChunksAfter(book, afterNodeId) { … }
 *
 * 2) Your convertToJsonObjects(textBlocks, insertionPoint) must
 *    produce an array of objects like:
 *      [ { "Book,2": { content, startLine: 2, chunk_id: 1 } }, … ]
 *
 * 3) This function merges them, renumbers the "tail", and logs the result.
 */
async function handleJsonPaste(
  event,
  insertionPoint,
  pastedContent,
  isHtmlContent = false,
  formatType = 'general',
  extractedFootnotes = [], // Accept processor-extracted footnotes
  extractedReferences = [] // Accept processor-extracted references
) {
  event.preventDefault();

  // --- 1. USE PROCESSOR-EXTRACTED FOOTNOTES AND REFERENCES ---
  let processedContent = pastedContent;

  // If footnotes/references were already extracted by the processor, use them
  // Otherwise, fall back to the old extraction method
  if (extractedFootnotes.length === 0 && extractedReferences.length === 0) {
    try {
      console.log(`📝 No footnotes/references from processor, using fallback extractor...`);
      const result = await processContentForFootnotesAndReferences(pastedContent, insertionPoint.book, isHtmlContent, formatType);
      processedContent = result.processedContent;
      extractedFootnotes = result.footnotes;
      extractedReferences = result.references;
      console.log(`✅ Extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);
    } catch (error) {
      console.error('❌ Error processing footnotes/references:', error);
      processedContent = pastedContent; // Fallback to original content on error
    }
  } else {
    console.log(`✅ Using processor-extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);
  }

  // --- 2. HANDLE H1 REPLACEMENT LOGIC ---
  const selection = window.getSelection();
  const currentElement = document.getElementById(insertionPoint.beforeNodeId);
  const isH1 = currentElement && currentElement.tagName === 'H1';

  // Check if pasted content contains block-level elements
  let hasBlockElements = false;
  if (isH1 && processedContent) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = processedContent;
    hasBlockElements = tempDiv.querySelector('p, h1, h2, h3, h4, h5, h6, div, blockquote, ul, ol, pre') !== null;
  }

  // Only replace H1 if there's a selection AND pasting block-level content
  const isH1Selected = isH1 && selection.toString().trim().length > 0 && hasBlockElements;

  if (isH1Selected) {
    console.log(`H1#${currentElement.id} is selected and pasting block-level content - replacing it entirely`);

    // Store the H1's ID before removing it
    const h1Id = currentElement.id;

    // Find the element BEFORE this H1 (to use as new insertion point)
    let beforeElement = currentElement.previousElementSibling;
    while (beforeElement && (!beforeElement.id || !/^\d+(\.\d+)*$/.test(beforeElement.id))) {
      beforeElement = beforeElement.previousElementSibling;
    }

    // Remove H1 from DOM
    currentElement.remove();

    // Delete H1 from IndexedDB
    const { deleteIndexedDBRecord } = await import('./indexedDB.js');
    await deleteIndexedDBRecord(insertionPoint.book, h1Id);

    // Update insertion point to be after the element before the deleted H1
    // (so pasted content takes the place of the deleted H1)
    insertionPoint.beforeNodeId = beforeElement ? beforeElement.id : "0";
    insertionPoint.currentNodeId = beforeElement ? beforeElement.id : "0";
    insertionPoint.afterNodeId = insertionPoint.afterNodeId; // Keep existing afterNodeId

    console.log('Updated insertion point for H1 replacement:', insertionPoint);
  }

  // --- 3. DATA LAYER: Calculate all database changes ---
  const { book, beforeNodeId, afterNodeId } = insertionPoint;
  const textBlocks = isHtmlContent
    ? parseHtmlToBlocks(processedContent)
    : processedContent.split(/\n\s*\n/).filter((blk) => blk.trim());
  if (!textBlocks.length) return [];

  const { jsonObjects: newJsonObjects, state } = convertToJsonObjects(
    textBlocks,
    insertionPoint
  );
  const newChunks = newJsonObjects.map((obj, index) => {
    const key = Object.keys(obj)[0];
    const { content, startLine, chunk_id, node_id } = obj[key];

    // Validate that content starts with an HTML element, not raw text
    const temp = document.createElement('div');
    temp.innerHTML = content;
    if (temp.firstChild && temp.firstChild.nodeType !== Node.ELEMENT_NODE) {
      console.warn(`⚠️ Chunk ${index} at line ${startLine} has non-element firstChild:`, {
        nodeType: temp.firstChild.nodeType,
        nodeName: temp.firstChild.nodeName,
        content: content.substring(0, 100)
      });
    }

    return {
      book: insertionPoint.book,
      startLine,
      chunk_id,
      content,
      node_id,  // Include node_id for stable tracking
      hyperlights: [],
      hypercites: [],
      footnotes: [],
    };
  });

  let toWrite = newChunks;
  if (afterNodeId != null) {
    const newLines = newJsonObjects.map(
      (o) => o[Object.keys(o)[0]].startLine
    );
    const maxNewLine = Math.max(...newLines);
    const existingChunks = await getNodeChunksAfter(book, afterNodeId);
    let currentChunkId = state.currentChunkId;
    let nodesInCurrentChunk = state.nodesInCurrentChunk;
    const tailChunks = existingChunks.map((origChunk, idx) => {
      if (nodesInCurrentChunk >= NODE_LIMIT) {
        currentChunkId = getNextIntegerId(currentChunkId);
        nodesInCurrentChunk = 0;
      }
      // Use 100-unit gaps for tail renumbering too (consistent with paste and renumbering system)
      const newStart = maxNewLine + ((idx + 1) * 100);
      const updatedContent = origChunk.content.replace(
        /id="\d+"/g,
        `id="${newStart}"`
      );
      nodesInCurrentChunk++;
      return {
        ...origChunk,
        startLine: newStart,
        chunk_id: currentChunkId,
        content: updatedContent,
      };
    });
    toWrite = [...newChunks, ...tailChunks];
    await deleteNodeChunksAfter(book, afterNodeId);
  }

  console.log(`Writing ${toWrite.length} chunks to IndexedDB`);
  await writeNodeChunks(toWrite);

  // Save extracted footnotes and references to IndexedDB
  if (extractedFootnotes.length > 0 || extractedReferences.length > 0) {
    const { saveAllFootnotesToIndexedDB, saveAllReferencesToIndexedDB } = await import('./indexedDB.js');

    if (extractedFootnotes.length > 0) {
      console.log(`💾 Saving ${extractedFootnotes.length} footnotes to IndexedDB...`);
      await saveAllFootnotesToIndexedDB(extractedFootnotes, insertionPoint.book);
    }

    if (extractedReferences.length > 0) {
      console.log(`💾 Saving ${extractedReferences.length} references to IndexedDB...`);
      await saveAllReferencesToIndexedDB(extractedReferences, insertionPoint.book);
    }
  }

  // For paste operations, sync immediately to PostgreSQL using bulk upsert
  // (Don't use debounced queue - that's for individual edits)
  console.log(`📤 Immediately syncing ${toWrite.length} pasted chunks to PostgreSQL...`);

  // Show orange indicator while syncing
  showSpinner();

  try {
    const response = await fetch('/api/db/node-chunks/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
      },
      credentials: 'include',
      body: JSON.stringify({
        book: insertionPoint.book,
        data: toWrite
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Failed to sync paste to PostgreSQL:', error);
      showError(); // Show red indicator on failure
    } else {
      const result = await response.json();
      console.log('✅ Paste synced to PostgreSQL:', result);
      // Don't call showTick() here - wait until entire paste operation completes
    }
  } catch (error) {
    console.error('❌ Error syncing paste to PostgreSQL:', error);
    showError(); // Show red indicator on exception
  }

  // Invalidate TOC cache after paste (heading IDs have changed)
  const { invalidateTocCache } = await import('./toc.js');
  invalidateTocCache();
  console.log('🔄 TOC cache invalidated after paste');

  return toWrite;
}

/**
 * Extract quoted text before a hypercite link element
 * @param {HTMLElement} container - Container holding the link
 * @param {HTMLElement} linkElement - The link element
 * @returns {string} - Cleaned quoted text
 */
function extractQuotedTextBeforeLink(container, linkElement) {
  // Method 1: Try to find text node immediately before the link
  let textNode = linkElement.previousSibling;
  let quotedText = "";

  while (textNode) {
    if (textNode.nodeType === Node.TEXT_NODE) {
      const text = textNode.textContent.trim();
      if (text) {
        quotedText = text + quotedText;
        break;
      }
    } else if (textNode.nodeType === Node.ELEMENT_NODE) {
      // Check if it's a span or other element containing text
      const textContent = textNode.textContent.trim();
      if (textContent) {
        quotedText = textContent + quotedText;
        break;
      }
    }
    textNode = textNode.previousSibling;
  }

  // Method 2: If no text found, try regex on container's text content
  if (!quotedText) {
    const fullText = container.textContent;
    const quoteMatch = fullText.match(/[''""]([^]*?)[''""](?=\s*↗|$)/);
    if (quoteMatch && quoteMatch[1]) {
      quotedText = quoteMatch[1];
    }
  }

  // Clean up quotes from start and end
  quotedText = quotedText.replace(/^[''""]/, '').replace(/[''""]$/, '');

  return quotedText;
}

/**
 * Handle pasting of hypercites
 * @returns {boolean} true if handled as hypercite, false otherwise
 */
async function handleHypercitePaste(event) {
  const clipboardHtml = event.clipboardData.getData("text/html");
  if (!clipboardHtml) return false;

  // Parse clipboard HTML
  const pasteWrapper = document.createElement("div");
  pasteWrapper.innerHTML = clipboardHtml;
  
  // Clear any numeric IDs to prevent conflicts
  pasteWrapper.querySelectorAll('[id]').forEach(el => {
    if (/^\d+(\.\d+)?$/.test(el.id)) {
      el.removeAttribute('id');
    }
  });
  
  // Look for hypercite link by href pattern (more reliable than id attribute)
  // Browsers may not preserve id or class attributes when copying, but href is always preserved
  const links = pasteWrapper.querySelectorAll('a[href*="#hypercite_"]');
  const citeLinks = []; // Collect ALL valid hypercite links

  console.log('🔍 Checking for hypercite links:', {
    foundLinks: links.length,
    pasteWrapperHTML: pasteWrapper.innerHTML.substring(0, 200)
  });

  // Find all links that have sup/span child with arrow (class may be stripped by browser)
  for (const link of links) {
    const hasSupOrSpan = link.querySelector('sup, span');
    // Remove all whitespace and zero-width spaces to handle \u200B from hypercite creation
    const linkText = link.innerText.replace(/[\u200B\s]/g, '');
    if (hasSupOrSpan && linkText === "↗") {
      citeLinks.push(link);
    }
  }

  // Check if this paste contains hypercite links
  if (citeLinks.length === 0) {
    return false; // Not a hypercite paste
  }

  console.log(`✅ Found ${citeLinks.length} hypercite link(s) in paste`);

  // Prevent default paste behavior
  event.preventDefault();

  console.log(`Detected ${citeLinks.length} hypercite(s) in pasted content`);

  // Get current book (where paste is happening)
  const bookb = book;

  // Process all hypercite links and build combined HTML
  let combinedHtml = '';
  const updateTasks = []; // Store update promises to await later

  for (const citeLink of citeLinks) {
    const originalHref = citeLink.getAttribute("href");
    const parsed = parseHyperciteHref(originalHref);

    if (!parsed) {
      console.warn("Failed to parse hypercite href:", originalHref);
      continue; // Skip this link and continue with others
    }

    const { booka, hyperciteIDa, citationIDa } = parsed;
    console.log("Parsed citation info:", { booka, hyperciteIDa, citationIDa });

    // Generate new hypercite ID for this instance
    const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);

    // Create the citation ID for this new instance
    const citationIDb = `/${bookb}#${hyperciteIDb}`;

    // Extract quoted text using helper function
    let quotedText = extractQuotedTextBeforeLink(pasteWrapper, citeLink);

    // Fallback to old extraction method if helper fails
    if (!quotedText) {
      quotedText = extractQuotedText(pasteWrapper);
    }

    console.log(`🔍 Extracted quoted text for link ${citeLinks.indexOf(citeLink) + 1}:`, `"${quotedText}"`);

    // Add to combined HTML (with space between multiple hypercites)
    if (combinedHtml) combinedHtml += ' ';
    combinedHtml += `'${quotedText}'<a href="${originalHref}" id="${hyperciteIDb}">\u200B<sup class="open-icon">↗</sup></a>`;

    // Store update task to process after insertion
    updateTasks.push({
      booka,
      hyperciteIDa,
      citationIDb,
      citationIDa
    });
  }

  // Check if we successfully processed any hypercites
  if (!combinedHtml) {
    console.warn("No valid hypercites were processed");
    return false;
  }

  console.log(`📝 Built combined HTML for ${updateTasks.length} hypercite(s)`);

  // Set the flag to prevent MutationObserver from processing this paste
  setHandleHypercitePaste(true);
  console.log("setHandleHypercitePaste flag to true");
  
  // Insert the combined content - use a more controlled approach
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);

    // Create a document fragment with all the hypercite links
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = combinedHtml;

    // Move all nodes from tempDiv to fragment
    while (tempDiv.firstChild) {
      fragment.appendChild(tempDiv.firstChild);
    }

    // Clear the range and insert our clean fragment
    range.deleteContents();
    range.insertNode(fragment);

    // Move cursor to end of insertion
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    // Fallback to execCommand if selection isn't available
    document.execCommand("insertHTML", false, combinedHtml);
  }
  
  // Get the current paragraph to manually save it
  saveCurrentParagraph();

  // Update all original hypercites' citedIN arrays
  // Use batched sync for multiple hypercites to avoid 429 rate limiting
  const shouldBatch = updateTasks.length > 1;

  try {
    console.log(`🔄 Updating ${updateTasks.length} original hypercite(s)... (${shouldBatch ? 'BATCHED' : 'IMMEDIATE'} sync)`);

    if (!shouldBatch) {
      // SINGLE HYPERCITE: Use existing immediate sync behavior
      for (const task of updateTasks) {
        const { booka, hyperciteIDa, citationIDb, citationIDa } = task;

        try {
          const updateResult = await updateCitationForExistingHypercite(
            booka,
            hyperciteIDa,
            citationIDb
          );

          if (updateResult && updateResult.success) {
            console.log(`✅ Successfully linked: ${citationIDa} cited in ${citationIDb}`);

            // Update the DOM in the CURRENT tab
            const localElement = document.getElementById(hyperciteIDa);
            if (localElement) {
              console.log(`(Paste Handler) Updating local DOM for ${hyperciteIDa} to class: ${updateResult.newStatus}`);
              localElement.className = updateResult.newStatus;
            }

            // Broadcast to OTHER tabs
            broadcastToOpenTabs(booka, updateResult.startLine);

          } else {
            console.warn(`⚠️ Failed to update citation for ${citationIDa}`);
          }
        } catch (error) {
          console.error(`❌ Error updating hypercite ${hyperciteIDa}:`, error);
          // Continue processing other hypercites even if one fails
        }
      }
    } else {
      // MULTIPLE HYPERCITES: Batch all updates into ONE request
      const updatedHypercites = [];
      const updatedNodeChunks = [];
      const domUpdates = []; // Store DOM updates to apply after successful sync

      // Process all hypercites and collect updates
      for (const task of updateTasks) {
        const { booka, hyperciteIDa, citationIDb, citationIDa } = task;

        try {
          // 1. Find and update the hypercite in nodeChunks
          const nodeChunks = await getNodeChunksFromIndexedDB(booka);
          if (!nodeChunks?.length) {
            console.warn(`No nodes found for book ${booka}`);
            continue;
          }

          let affectedStartLine = null;
          let updatedRelationshipStatus = "single";

          for (const record of nodeChunks) {
            if (!record.hypercites?.find((hc) => hc.hyperciteId === hyperciteIDa)) {
              continue;
            }
            const startLine = record.startLine;
            const result = await addCitationToHypercite(
              booka,
              startLine,
              hyperciteIDa,
              citationIDb
            );
            if (result.success) {
              affectedStartLine = startLine;
              updatedRelationshipStatus = result.relationshipStatus;
              break;
            }
          }

          if (!affectedStartLine) {
            console.warn(`No matching hypercite found in book ${booka} with ID ${hyperciteIDa}`);
            continue;
          }

          // 2. Update the hypercite record itself
          const existingHypercite = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
          if (!existingHypercite) {
            console.error(`Hypercite ${hyperciteIDa} not found in book ${booka}`);
            continue;
          }

          existingHypercite.citedIN ||= [];
          if (!existingHypercite.citedIN.includes(citationIDb)) {
            existingHypercite.citedIN.push(citationIDb);
          }
          existingHypercite.relationshipStatus = updatedRelationshipStatus;

          const hyperciteSuccess = await updateHyperciteInIndexedDB(
            booka,
            hyperciteIDa,
            {
              citedIN: existingHypercite.citedIN,
              relationshipStatus: updatedRelationshipStatus,
              hypercitedHTML: `<u id="${hyperciteIDa}" class="${updatedRelationshipStatus}">${existingHypercite.hypercitedText}</u>`,
            },
            true // skipQueue: we're doing batched sync immediately
          );

          if (!hyperciteSuccess) {
            console.error(`Failed to update hypercite ${hyperciteIDa}`);
            continue;
          }

          // 3. Get final records for sync
          const finalHyperciteRecord = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
          const finalNodeChunkRecord = await getNodeChunkFromIndexedDB(booka, affectedStartLine);

          if (finalHyperciteRecord && finalNodeChunkRecord) {
            // Add to batch collections
            updatedHypercites.push(finalHyperciteRecord);
            updatedNodeChunks.push(toPublicChunk(finalNodeChunkRecord));

            // Store DOM update for later
            domUpdates.push({
              hyperciteIDa,
              newStatus: updatedRelationshipStatus,
              startLine: affectedStartLine,
              booka,
              citationIDa
            });

            console.log(`✅ Prepared batch update for: ${citationIDa} cited in ${citationIDb}`);
          }
        } catch (error) {
          console.error(`❌ Error processing hypercite ${hyperciteIDa}:`, error);
          // Continue processing other hypercites even if one fails
        }
      }

      // 4. Make ONE batched API call for all hypercites
      if (updatedHypercites.length > 0) {
        console.log(`📤 Syncing ${updatedHypercites.length} hypercite(s) in ONE batched request...`);

        try {
          // Group hypercites by book for batching
          const hypercitesByBook = {};
          updatedHypercites.forEach(hc => {
            if (!hypercitesByBook[hc.book]) {
              hypercitesByBook[hc.book] = [];
            }
            hypercitesByBook[hc.book].push(hc);
          });

          // Sync each book's hypercites
          const hyperciteSyncPromises = Object.entries(hypercitesByBook).map(([book, hypercites]) =>
            fetch("/api/db/hypercites/upsert", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.getAttribute("content"),
              },
              credentials: "include",
              body: JSON.stringify({ book, data: hypercites }),
            })
          );

          // Group nodeChunks by book for batching
          const nodeChunksByBook = {};
          updatedNodeChunks.forEach(nc => {
            if (!nodeChunksByBook[nc.book]) {
              nodeChunksByBook[nc.book] = [];
            }
            nodeChunksByBook[nc.book].push(nc);
          });

          // Sync each book's nodeChunks
          const nodeChunkSyncPromises = Object.entries(nodeChunksByBook).map(([book, chunks]) =>
            fetch("/api/db/node-chunks/targeted-upsert", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.getAttribute("content"),
              },
              credentials: "include",
              body: JSON.stringify({ book, data: chunks }),
            })
          );

          // Wait for all sync operations to complete
          const allResponses = await Promise.all([...hyperciteSyncPromises, ...nodeChunkSyncPromises]);

          // Check if all requests succeeded
          const allSucceeded = allResponses.every(res => res.ok);

          if (allSucceeded) {
            console.log(`✅ Batched sync successful for ${updatedHypercites.length} hypercite(s)`);

            // 5. Apply DOM updates only after successful sync
            domUpdates.forEach(({ hyperciteIDa, newStatus, startLine, booka }) => {
              const localElement = document.getElementById(hyperciteIDa);
              if (localElement) {
                console.log(`(Paste Handler) Updating local DOM for ${hyperciteIDa} to class: ${newStatus}`);
                localElement.className = newStatus;
              }

              // Broadcast to OTHER tabs
              broadcastToOpenTabs(booka, startLine);
            });
          } else {
            console.error('❌ Some batched sync requests failed');
            allResponses.forEach((res, idx) => {
              if (!res.ok) {
                console.error(`Request ${idx + 1} failed with status: ${res.status}`);
              }
            });
          }
        } catch (error) {
          console.error('❌ Error during batched sync:', error);
        }
      }
    }

    console.log(`✅ Completed updating ${updateTasks.length} hypercite(s)`);

  } catch (error) {
    console.error("❌ Error during hypercite paste updates:", error);
  } finally {
    // Clear the flag in the finally block to guarantee it's always reset
    setHandleHypercitePaste(false);
    console.log("setHandleHypercitePaste cleared");
  }

  return true; // Successfully handled as hypercite
}


/**
 * Extract quoted text from a paste wrapper element
 */
export function extractQuotedText(pasteWrapper) {
  let quotedText = "";
  const fullText = pasteWrapper.textContent;
  // Updated regex to handle mixed quote types - match any opening quote with any closing quote

  const quoteMatch = fullText.match(/^[''""]([^]*?)[''""](?=\s*↗|$)/);
  
  if (quoteMatch && quoteMatch[1]) {
    quotedText = quoteMatch[1];
  } else {
    // Fallback to just using text before the citation
    const textNodes = Array.from(pasteWrapper.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE);
    if (textNodes.length > 0) {
      // Handle mixed quote types by removing any quote from start and end separately
      quotedText = textNodes[0].textContent.replace(/^[''""]/, '').replace(/[''""]$/, '');

    }
  }
  
  return quotedText;
}

/**
 * Save the current paragraph after a paste operation
 */
function saveCurrentParagraph() {
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let currentElement = range.startContainer;
    if (currentElement.nodeType !== Node.ELEMENT_NODE) {
      currentElement = currentElement.parentElement;
    }
    
    // Find the closest block element (paragraph, pre, blockquote, etc.)
    let blockElement = currentElement.closest('p, pre, blockquote, h1, h2, h3, h4, h5, h6');
    
    if (blockElement && blockElement.id) {
      console.log("Manually saving block element:", blockElement.id, blockElement.tagName);
      // Manually save the element to IndexedDB
      queueNodeForSave(blockElement.id, 'update');
    }
  }
}

/**
 * Detect if pasted text is a YouTube transcript
 * Checks both HTML structure and plainText patterns
 */
function detectYouTubeTranscript(plainText, rawHtml) {
  // First check HTML for YouTube transcript classes
  if (rawHtml && typeof rawHtml === 'string') {
    const hasYouTubeClasses =
      rawHtml.includes('ytd-transcript-segment-renderer') ||
      rawHtml.includes('segment-timestamp') ||
      (rawHtml.includes('yt-formatted-string') && rawHtml.includes('segment-text'));

    if (hasYouTubeClasses) {
      return { isYouTube: true, source: 'html' };
    }
  }

  // Fallback to plainText pattern detection
  if (!plainText || typeof plainText !== 'string') {
    return { isYouTube: false, source: null };
  }

  const lines = plainText.split('\n');
  let timestampCount = 0;

  // Check first 20 lines for timestamp patterns
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const line = lines[i].trim();
    // Match timestamp patterns: 8:59, 1:23:45, etc. (on their own line OR at start of line)
    if (/^\d{1,2}:\d{2}(:\d{2})?($|\s)/.test(line)) {
      timestampCount++;
    }
  }

  // If we find 3+ timestamps in the first 20 lines, it's likely a transcript
  if (timestampCount >= 3) {
    return { isYouTube: true, source: 'plaintext' };
  }

  return { isYouTube: false, source: null };
}

/**
 * Transform YouTube transcript into readable paragraphs
 * Removes timestamps and groups sentences
 */
function transformYouTubeTranscript(plainText, rawHtml, source) {
  let extractedText = '';

  if (source === 'html' && rawHtml) {
    // Parse HTML and extract text from transcript segments
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // Extract text from yt-formatted-string elements (the actual transcript text)
    const textElements = doc.querySelectorAll('.segment-text, yt-formatted-string.segment-text');
    const textParts = [];

    textElements.forEach(el => {
      const text = el.textContent.trim();
      if (text && !text.match(/^\d{1,2}:\d{2}/)) { // Skip timestamps
        textParts.push(text);
      }
    });

    extractedText = textParts.join(' ');
  } else {
    // Use plainText
    const lines = plainText.split('\n');
    const textLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip timestamp lines (standalone or at start of line)
      if (/^\d{1,2}:\d{2}(:\d{2})?($|\s)/.test(line)) {
        // If timestamp is at start, keep the rest of the line
        const afterTimestamp = line.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, '').trim();
        if (afterTimestamp) {
          textLines.push(afterTimestamp);
        }
        continue;
      }

      // Remove leading dash/bullet and add to text
      const cleaned = line.replace(/^[-•]\s*/, '').trim();
      if (cleaned) {
        textLines.push(cleaned);
      }
    }

    extractedText = textLines.join(' ');
  }

  // Split into sentences (ending with . ! ?)
  const sentences = extractedText.match(/[^.!?]+[.!?]+/g) || [extractedText];

  // Group sentences into paragraphs (3-4 sentences each)
  const paragraphs = [];
  const sentencesPerParagraph = 3;

  for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
    const paragraphSentences = sentences.slice(i, i + sentencesPerParagraph);
    paragraphs.push(paragraphSentences.join(' ').trim());
  }

  // Join paragraphs with double newlines for markdown parsing
  return paragraphs.join('\n\n');
}

function detectMarkdown(text) {
  if (!text || typeof text !== 'string') return false;
  
  console.log('detectMarkdown input:');
  
  const markdownPatterns = [
    /^#{1,6}\s+/m,                    // Headers
    /\*{1,2}[^*\n]+\*{1,2}/,         // Bold/italic (removed ^ anchor)
    /_{1,2}[^_\n]+_{1,2}/,           // Bold/italic with underscores
    /^\* /m,                         // Unordered lists
    /^\d+\. /m,                      // Ordered lists
    /^\> /m,                         // Blockquotes
    /`[^`]+`/,                       // Inline code (actual backticks only)
    /^```/m,                         // Code blocks
    /\[.+\]\(.+\)/,                  // Links (removed ^ anchor)
    /^!\[.*\]\(.+\)/m,               // Images
    /^\|.+\|/m,                      // Tables
    /^---+$/m,                       // Horizontal rules
    /^\- \[[ x]\]/m                  // Task lists
  ];
  
  // Count how many patterns match and log each one
  const matches = markdownPatterns.filter((pattern, index) => {
    const match = pattern.test(text);
    console.log(`Pattern ${index} (${pattern}):`, match);
    // Special debug for inline code pattern
    if (index === 6 && match) {
      const codeMatch = text.match(pattern);
      console.log(`🔍 Inline code match found:`, codeMatch);
    }
    return match;
  });
  
  console.log('Total matches:', matches.length);
  
  // Change this line: lower threshold to 1
  return matches.length >= 1;
}

/**
 * Check if an element is a block-level element
 */
function isBlockElement(tagName) {
  const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'BLOCKQUOTE', 
                     'UL', 'OL', 'LI', 'PRE', 'TABLE', 'FIGURE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER'];
  return blockTags.includes(tagName.toUpperCase());
}

/**
 * Parse HTML content into individual block elements
 */
function parseHtmlToBlocks(htmlContent) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const blocks = [];
  
  // The complex div-to-p logic has been moved to assimilateHTML.
  // This function now focuses on splitting into blocks and wrapping loose text.
  
  // Get direct children, INCLUDING text nodes
  Array.from(tempDiv.childNodes).forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // This is a block-level element
      const child = node;
      child.removeAttribute('id'); // Remove any conflicting IDs
      
      // Check if this element contains multiple <br> separated entries (common in bibliographies)
      const innerHTML = child.innerHTML;
      const brSeparatedParts = innerHTML.split(/<br\s*\/?>/i);

      // Don't split on <br> if:
      // 1. The element itself is a block element that shouldn't be split (table, ul, ol, etc.)
      // 2. The content contains nested block elements
      const isUnsplittableBlock = /^(TABLE|UL|OL|DIV)$/.test(child.tagName);
      const containsBlockElements = /<(?:table|div|section|ul|ol)/i.test(innerHTML);

      if (brSeparatedParts.length > 1 && !isUnsplittableBlock && !containsBlockElements) {
        // Split on <br> tags - each part becomes a separate block
        brSeparatedParts.forEach(part => {
          const trimmedPart = part.trim();
          if (trimmedPart) {
            // Use a wrapper div to parse the content (browser auto-corrects invalid nesting)
            const wrapper = document.createElement('div');
            wrapper.innerHTML = trimmedPart;

            // Extract all resulting nodes as separate blocks
            Array.from(wrapper.childNodes).forEach(node => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // This is an element - use it as-is
                blocks.push(node.outerHTML);
              } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
                // Loose text - wrap in the parent element type
                blocks.push(`<${child.tagName.toLowerCase()}>${node.textContent.trim()}</${child.tagName.toLowerCase()}>`);
              }
            });
          }
        });
      } else {
        // No <br> tags - use the whole element as one block
        blocks.push(child.outerHTML);
      }
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      // This is a "loose" text node that resulted from unwrapping. Wrap it in a <p> tag.
      blocks.push(`<p>${node.textContent.trim()}</p>`);

    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName && !isBlockElement(node.tagName)) {
      // This is a loose inline element (a, span, i, b, etc.) - wrap it in a <p> tag.
      blocks.push(`<p>${node.outerHTML}</p>`);
    }
  });
  
  // If no block children were found, but there's content, wrap the whole thing in a <p>.
  if (blocks.length === 0 && htmlContent.trim()) {
    blocks.push(`<p>${htmlContent}</p>`);
  }
  
  return blocks;
}






