import { getNextIntegerId, generateIdBetween } from './IDfunctions.js';
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
         queueForSync } from './cache-indexedDB.js';
import { syncIndexedDBtoPostgreSQL } from './postgreSQL.js';
import { initializeMainLazyLoader } from './initializePage.js';
import { parseHyperciteHref } from './hyperCites.js';
import {
  getHandleHypercitePaste,
  setHandleHypercitePaste,
  isPasteInProgress,
  setPasteInProgress
} from './operationState.js';
import { queueNodeForSave } from './divEditor.js';
import { broadcastToOpenTabs } from './BroadcastListener.js';

// Configure marked options
marked.setOptions({
  breaks: true,        // Convert \n to <br>
  gfm: true,          // GitHub Flavored Markdown
  sanitize: false,    // We'll use DOMPurify instead
  smartypants: true   // Smart quotes, dashes, etc.
});

// Flag to prevent double-handling
let pasteHandled = false;

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
function assimilateHTML(rawHtml) {
  // 1) Sanitize
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_TAGS: [
      "sup", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
      "ul", "ol", "li",
    ],
    ADD_ATTR: ["id", "href"],
  });

  // 2) Parse
  const doc = new DOMParser().parseFromString(cleanHtml, "text/html");
  const body = doc.body;

  // --- Helper Functions (unchanged) ---
  function replaceTag(el, newTagName) {
    const newEl = doc.createElement(newTagName);
    for (const { name, value } of el.attributes) {
      if (name !== "style" && name !== "class") {
        newEl.setAttribute(name, value);
      }
    }
    while (el.firstChild) {
      newEl.appendChild(el.firstChild);
    }
    el.replaceWith(newEl);
    return newEl;
  }

  function unwrap(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    el.remove();
  }

  // --- Main Transformation Pipeline ---

  // 3) CONDITIONAL ANCHOR INJECTION & LINK PROCESSING
  const idPrefix = "pasted-";
  (function processLinksAndInjectAnchors() {
    const linksToProcess = new Map();
    const blockTags = [
      "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6",
      "BLOCKQUOTE", "UL", "OL", "PRE", "DIV",
    ];

    // Step A: Find all internal links and their targets.
    body.querySelectorAll('a[href*="#"]').forEach((link) => {
      try {
        const url = new URL(link.href);
        if (url.hash) {
          const targetId = url.hash.substring(1);
          const targetElement = body.querySelector(`#${targetId}`);
          if (targetElement) {
            if (!linksToProcess.has(targetId)) {
              linksToProcess.set(targetId, {
                targetElement: targetElement,
                links: [],
              });
            }
            linksToProcess.get(targetId).links.push(link);
          }
        }
      } catch (e) { /* ignore invalid URLs */ }
    });

    // Step B: Process the found links with conditional logic.
    linksToProcess.forEach((data, targetId) => {
      const { targetElement, links } = data;
      const newPrefixedId = `${idPrefix}${targetId}`;

      // *** THE NEW CONDITIONAL LOGIC ***
      if (blockTags.includes(targetElement.tagName)) {
        // It's a block element: INJECT a new anchor to hold the ID.
        console.log(`Injecting anchor for block target: #${targetId}`);
        const anchor = doc.createElement("a");
        anchor.id = newPrefixedId;
        targetElement.prepend(anchor);
        targetElement.removeAttribute("id");
      } else {
        // It's an inline element (<a>, <sup>, etc.): PREFIX the ID directly.
        console.log(`Prefixing ID for inline target: #${targetId}`);
        targetElement.id = newPrefixedId;
      }

      // Step C: Update all links to point to the new prefixed ID.
      links.forEach((link) => {
        link.setAttribute("href", `#${newPrefixedId}`);
      });
    });
  })();

  // 4) Structural transformation (unchanged)
  const nodesToProcess = Array.from(body.querySelectorAll("*"));
  for (let i = nodesToProcess.length - 1; i >= 0; i--) {
    const node = nodesToProcess[i];
    if (["SPAN", "FONT"].includes(node.tagName)) {
      if (!node.classList.contains("open-icon")) unwrap(node);
      continue;
    }
    const tagsToRecastAsP = [
      "DIV", "ARTICLE", "SECTION", "MAIN",
      "HEADER", "FOOTER", "ASIDE", "NAV", "BUTTON",
    ];
    if (tagsToRecastAsP.includes(node.tagName)) {
      replaceTag(node, "p");
    }
  }

  // 5) Cleanup (unchanged)
  body.querySelectorAll("p, blockquote, h1, h2, h3, li").forEach((el) => {
    if (
      !el.textContent.trim() &&
      !el.querySelector("img") &&
      !el.querySelector("a[id^='pasted-']")
    ) {
      el.remove();
    }
  });
  body.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("style");
    el.removeAttribute("class");
    if (el.id && !el.id.startsWith(idPrefix)) {
      el.removeAttribute("id");
    }
  });

  return body.innerHTML;
}

async function handlePaste(event) {
  // Set the flag immediately to disable the MutationObserver
  setPasteInProgress(true);

  try {
    // 1) Prevent double-handling
    if (pasteHandled) return;
    pasteHandled = true;
    setTimeout(() => (pasteHandled = false), 0);

    // 2) Grab and process clipboard data
    const plainText = event.clipboardData.getData("text/plain");
    const rawHtml = event.clipboardData.getData("text/html") || "";
    let htmlContent = "";
    const isMarkdown = detectMarkdown(plainText);

    if (isMarkdown) {
      console.log("Entering markdown branch");
      event.preventDefault(); // This is now safe to call
      // ... (the rest of your markdown processing logic is correct) ...
      if (plainText.length > 1000) {
        const progressModal = await showProgressModal();
        try {
          const dirty = await processMarkdownInChunks(plainText, (p, c, t) =>
            progressModal.updateProgress(p, c, t)
          );
          htmlContent = DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
          progressModal.complete();
        } catch (error) {
          console.error("Error during chunked conversion:", error);
          progressModal.modal.remove();
          return;
        }
      } else {
        const dirty = marked(plainText);
        htmlContent = DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
      }
    } else if (rawHtml.trim()) {
      console.log("Assimilating pasted HTML...");
      htmlContent = assimilateHTML(rawHtml);
      console.log("Assimilation complete. Cleaned HTML:", htmlContent);
    }

    // 3) Get our reliable estimate.
    const estimatedNodes = estimatePasteNodeCount(htmlContent || plainText);
    console.log("PASTE EVENT:", {
      length: plainText.length,
      isMarkdown,
      estimatedNodes,
    });

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
      console.error("Could not determine insertion point. Aborting paste.");
      return;
    }
    const contentToProcess = htmlContent || plainText;

    const newAndUpdatedNodes = await handleJsonPaste(
      event,
      insertionPoint,
      contentToProcess,
      !!htmlContent
    );

    if (!newAndUpdatedNodes || newAndUpdatedNodes.length === 0) {
      console.log("Paste resulted in no new nodes. Aborting render.");
      return;
    }

    const loader = initializeMainLazyLoader();
    await loader.updateAndRenderFromPaste(
      newAndUpdatedNodes,
      insertionPoint.beforeNodeId
    );

  } finally {
    // THIS IS ESSENTIAL: No matter what happens, re-enable the observer.
    setPasteInProgress(false);
  }
}

function getInsertionPoint(chunkElement) {
  console.log('=== getInsertionPoint START ===');
  
  const selection = window.getSelection();
  const range = selection.getRangeAt(0);
  const currentNode = range.startContainer;
  
  console.log('Selection details:', {
    currentNode: currentNode,
    nodeType: currentNode.nodeType,
    textContent: currentNode.textContent?.substring(0, 50)
  });
  
  // Find the current node element (handle text nodes)
  let currentNodeElement = currentNode.nodeType === Node.TEXT_NODE 
    ? currentNode.parentElement 
    : currentNode;
  
  console.log('Initial currentNodeElement:', {
    element: currentNodeElement,
    id: currentNodeElement?.id,
    tagName: currentNodeElement?.tagName
  });
  
  // Traverse up to find parent with numerical ID (including decimals)
  while (currentNodeElement && currentNodeElement !== chunkElement) {
    const id = currentNodeElement.id;
    console.log('Checking element:', {
      element: currentNodeElement,
      id: id,
      tagName: currentNodeElement.tagName,
      matchesRegex: id && /^\d+(\.\d+)*$/.test(id)
    });
    
    // Check if ID exists and is numerical (including decimals)
    if (id && /^\d+(\.\d+)*$/.test(id)) {
      console.log('Found target element with numerical ID:', id);
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
  
  console.log('Found current node:', {
    currentNodeId,
    chunkId,
    element: currentNodeElement
  });
  
  // Current node becomes the beforeNodeId (we're inserting after it)
  const beforeNodeId = currentNodeId;
  
  // Find the next element with a numerical ID (this is the afterNodeId)
  let afterElement = currentNodeElement.nextElementSibling;
  console.log('Starting search for afterElement from:', afterElement);
  
  while (afterElement) {
    console.log('Examining potential afterElement:', {
      element: afterElement,
      id: afterElement.id,
      tagName: afterElement.tagName,
      hasNumericalId: afterElement.id && /^\d+(\.\d+)*$/.test(afterElement.id)
    });
    
    if (afterElement.id && /^\d+(\.\d+)*$/.test(afterElement.id)) {
      console.log('Found afterElement with numerical ID:', afterElement.id);
      break;
    }
    
    afterElement = afterElement.nextElementSibling;
  }
  
  const afterNodeId = afterElement?.id || null;
  
  console.log('Final before/after determination:', {
    beforeNodeId,
    afterNodeId,
    afterElement: afterElement
  });
  
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
  
  console.log('=== getInsertionPoint RESULT ===', result);
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
    
    // Process chunk
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
  console.log('=== convertToJsonObjects START ===');
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

    // new node id
    const newNodeId = getNextIntegerId(beforeId);

    const trimmed     = block.trim();
    const htmlContent = convertTextToHtml(trimmed, newNodeId);

    const key = `${insertionPoint.book},${newNodeId}`;
    jsonObjects.push({
      [key]: {
        content:   htmlContent,
        startLine: parseFloat(newNodeId),
        chunk_id:  parseFloat(currentChunkId)
      }
    });

    // advance
    beforeId            = newNodeId;
    nodesInCurrentChunk++;
  });

  console.log('=== convertToJsonObjects END ===');
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
    `Small paste (≈${nodeCount} nodes); handling with ID-aware insertion.`
  );

  if (htmlContent) {
    event.preventDefault();
    const selection = window.getSelection();
    if (!selection.rangeCount) return true;

    const range = selection.getRangeAt(0);
    let currentElement = range.startContainer;
    if (currentElement.nodeType === Node.TEXT_NODE) {
      currentElement = currentElement.parentElement;
    }

    const currentBlock = currentElement.closest(
      "p, h1, h2, h3, h4, h5, h6, div, pre, blockquote"
    );

    if (!currentBlock || !currentBlock.id || !/^\d+(\.\d+)*$/.test(currentBlock.id)) {
      console.warn("Small paste aborted: Could not find a valid anchor block with a numerical ID.");
      return true;
    }

    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = htmlContent;
    tempDiv.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));

    const elementsToInsert = Array.from(tempDiv.children);
    let lastInsertedElement = currentBlock;
    
    // ✅ NEW: Track inserted elements for saving
    const insertedElements = [];

    elementsToInsert.forEach((elementToInsert) => {
      let nextSiblingWithId = lastInsertedElement.nextElementSibling;
      while (nextSiblingWithId && (!nextSiblingWithId.id || !/^\d+(\.\d+)*$/.test(nextSiblingWithId.id))) {
        nextSiblingWithId = nextSiblingWithId.nextElementSibling;
      }
      const nextId = nextSiblingWithId ? nextSiblingWithId.id : null;

      const newId = generateIdBetween(lastInsertedElement.id, nextId);
      elementToInsert.id = newId;
      console.log(`Assigning new ID ${newId} to pasted element.`);

      lastInsertedElement.insertAdjacentElement("afterend", elementToInsert);
      
      // ✅ NEW: Track this element
      insertedElements.push(elementToInsert);
      
      lastInsertedElement = elementToInsert;
    });

    // ✅ NEW: Explicitly save all inserted elements
    insertedElements.forEach(element => {
      console.log(`Explicitly saving small paste element: ${element.id}`);
      queueNodeForSave(element.id, 'create'); // or 'update' if you prefer
    });

    // Move cursor to end
    if (lastInsertedElement && lastInsertedElement !== currentBlock) {
      const newRange = document.createRange();
      newRange.selectNodeContents(lastInsertedElement);
      newRange.collapse(false);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }

    return true;
  } else {
    console.log("Small plain text paste, deferring to native contentEditable");
    setPasteInProgress(false);
    return false;
  }
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

function convertTextToHtml(content, nodeId) {
  // Check if content is already HTML
  if (content.trim().startsWith('<') && content.trim().endsWith('>')) {
    // It's HTML - add/update the ID on the first element
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;
    
    // Find the first element and give it the nodeId
    const firstElement = tempDiv.querySelector('*');
    if (firstElement) {
      firstElement.id = nodeId;
      return tempDiv.innerHTML;
    }
    
    // Fallback if no elements found
    return content;
  } else {
    // It's plain text - wrap in paragraph
    return `<p id="${nodeId}">${content}</p>`;
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
  isHtmlContent = false
) {
  event.preventDefault();

  // --- 1. DATA LAYER: Calculate all database changes ---
  const { book, beforeNodeId, afterNodeId } = insertionPoint;
  const textBlocks = isHtmlContent
    ? parseHtmlToBlocks(pastedContent)
    : pastedContent.split(/\n\s*\n/).filter((blk) => blk.trim());
  if (!textBlocks.length) return [];

  const { jsonObjects: newJsonObjects, state } = convertToJsonObjects(
    textBlocks,
    insertionPoint
  );
  const newChunks = newJsonObjects.map((obj) => {
    const key = Object.keys(obj)[0];
    const { content, startLine, chunk_id } = obj[key];
    return {
      book: insertionPoint.book,
      startLine,
      chunk_id,
      content,
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
      const newStart = maxNewLine + idx + 1;
      const updatedContent = origChunk.content.replace(
        /id="[^"]*"/,
        `id="${newStart}"`
      );
      nodesInCurrentChunk++;
      return {
        ...origChunk,
        startLine: newStart,
        chunk_id: parseFloat(currentChunkId),
        content: updatedContent,
      };
    });
    toWrite = [...newChunks, ...tailChunks];
  }

  // --- 2. DATABASE LAYER: Execute the transaction & queue for sync ---
  if (afterNodeId != null) {
    await deleteNodeChunksAfter(book, afterNodeId);
  }
  await writeNodeChunks(toWrite);
  console.log("📦 IndexedDB has been updated with new and renumbered chunks!");
  
  // MODIFIED: Pass the full 'chunk' object to the queue.
  toWrite.forEach((chunk) => {
    queueForSync("nodeChunks", chunk.startLine, "update", chunk);
  });
  
  console.log(
    `✅ Queued ${toWrite.length} total affected chunks for sync.`
  );

  // --- 3. RETURN THE DATA ---
  return toWrite;
}
/**
 * Handle pasting of hypercites
 * @returns {boolean} true if handled as hypercite, false otherwise
 */
async function handleHypercitePaste(event) {
  const clipboardHtml = event.clipboardData.getData("text/html");
  if (!clipboardHtml) return false;

  console.log("🔍 DEBUG - Raw clipboard HTML:", clipboardHtml); // ADD THIS
  
  // Parse clipboard HTML
  const pasteWrapper = document.createElement("div");
  pasteWrapper.innerHTML = clipboardHtml;

  console.log("🔍 DEBUG - Parsed wrapper innerHTML:", pasteWrapper.innerHTML); // ADD THIS
  console.log("🔍 DEBUG - Wrapper structure:", pasteWrapper); // ADD THIS
  
  // Clear any numeric IDs to prevent conflicts
  pasteWrapper.querySelectorAll('[id]').forEach(el => {
    if (/^\d+(\.\d+)?$/.test(el.id)) {
      el.removeAttribute('id');
    }
  });
  
  // Look for hypercite link
  const citeLink = pasteWrapper.querySelector(
    'a[id^="hypercite_"] > span.open-icon'
  )?.parentElement;
  
  // Check if this is a hypercite link
  if (!(citeLink && 
      (citeLink.innerText.trim() === "↗" || 
       (citeLink.closest("span") && citeLink.closest("span").classList.contains("open-icon"))))) {
    return false; // Not a hypercite
  }
  
  // Prevent default paste behavior
  event.preventDefault();
  
  console.log("Detected a hypercite in pasted content");
  
  const originalHref = citeLink.getAttribute("href");
  const parsed = parseHyperciteHref(originalHref);
  if (!parsed) return false;
  
  const { booka, hyperciteIDa, citationIDa } = parsed;
  console.log("Parsed citation info:", { booka, hyperciteIDa, citationIDa });
  
  // Generate new hypercite ID for this instance
  const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);
  
  // Get current book (where paste is happening)
  const bookb = book;
  
  // Create the citation ID for this new instance
  const citationIDb = `/${bookb}#${hyperciteIDb}`;
  
  // Extract quoted text - IMPROVED VERSION
  let quotedText = "";

  // Method 1: Try regex to extract quoted text from raw HTML
  const quoteMatch = clipboardHtml.match(/'([^']*)'/);
  if (quoteMatch) {
    quotedText = quoteMatch[1];
    console.log("🔍 Found quoted text via regex:", quotedText);
  }

  // Method 2: If regex failed, try DOM parsing
  if (!quotedText) {
    // First try to find the text directly before the citation link
    let textNode = citeLink.previousSibling;
    while (textNode) {
      if (textNode.nodeType === Node.TEXT_NODE) {
        quotedText = textNode.textContent.trim() + quotedText;
        break;
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
    console.log("🔍 Found quoted text via DOM:", quotedText);
  }

  // Method 3: Fallback - extract all text before the link
  if (!quotedText) {
    quotedText = extractQuotedText(pasteWrapper);
    console.log("🔍 Found quoted text via fallback:", quotedText);
  }

  // Clean up the quoted text
  quotedText = quotedText.replace(/^['"]|['"]$/g, ''); // Remove quotes
  console.log("🔍 Final cleaned quoted text:", `"${quotedText}"`);
  
  // Create the reference HTML with no space between text and sup
  const referenceHtml = `'${quotedText}'<a href="${originalHref}" id="${hyperciteIDb}">\u200B<sup class="open-icon">↗</sup></a>`;
  
  // Set the flag to prevent MutationObserver from processing this paste
  setHandleHypercitePaste(true);
  console.log("setHandleHypercitePaste flag to true");
  
  // Insert the content - use a more controlled approach
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    
    // Create a document fragment with just the text and link
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = referenceHtml;
    
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
    document.execCommand("insertHTML", false, referenceHtml);
  }
  
  // Get the current paragraph to manually save it
  saveCurrentParagraph();
  
  // Update the original hypercite's citedIN array
  try {
    // ✅ 3. AWAIT the function and capture the full result object.
    const updateResult = await updateCitationForExistingHypercite(
      booka, 
      hyperciteIDa, 
      citationIDb
    );

    if (updateResult && updateResult.success) {
      console.log(`Successfully linked: ${citationIDa} cited in ${citationIDb}`);

      // ✅ 4. Perform BOTH the local DOM update and the broadcast.
      // ACTION A: Update the DOM in the CURRENT tab.
      const localElement = document.getElementById(hyperciteIDa);
      if (localElement) {
        console.log(`(Paste Handler) Updating local DOM for ${hyperciteIDa} to class: ${updateResult.newStatus}`);
        localElement.className = updateResult.newStatus;
      }

      // ACTION B: Broadcast to OTHER tabs.
      broadcastToOpenTabs(booka, updateResult.startLine);

    } else {
      console.warn(`Failed to update citation for ${citationIDa}`);
    }
  } catch (error) {
    console.error("Error during hypercite paste update:", error);
  } finally {
    // ✅ 5. Clear the flag in the finally block to guarantee it's always reset.
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
  const quoteMatch = fullText.match(/^"(.+?)"/);
  
  if (quoteMatch && quoteMatch[1]) {
    quotedText = quoteMatch[1];
  } else {
    // Fallback to just using text before the citation
    const textNodes = Array.from(pasteWrapper.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE);
    if (textNodes.length > 0) {
      quotedText = textNodes[0].textContent.replace(/^"(.+)"$/, "$1");
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
    /`[^`]+`/,                       // Inline code
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
    return match;
  });
  
  console.log('Total matches:', matches.length);
  
  // Change this line: lower threshold to 1
  return matches.length >= 1;
}

/**
 * Parse HTML content into individual block elements
 */
function parseHtmlToBlocks(htmlContent) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const blocks = [];
  
  // Get direct children (block-level elements)
  Array.from(tempDiv.children).forEach(child => {
    // Remove any existing IDs to prevent conflicts
    child.removeAttribute('id');
    blocks.push(child.outerHTML);
  });
  
  // If no block children, treat the whole thing as one block
  if (blocks.length === 0) {
    blocks.push(htmlContent);
  }
  
  return blocks;
}





