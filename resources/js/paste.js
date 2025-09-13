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
import { processContentForFootnotesAndReferences } from './footnote-reference-extractor.js';

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
  // 1) Replace nbsp entities with regular spaces to prevent layout shifts
  // Handle both direct nbsp entities and Apple-converted-space spans
  let cleanedHtml = rawHtml
    .replace(/<span class="Apple-converted-space">\s*&nbsp;\s*<\/span>/g, ' ')
    .replace(/<span class="Apple-converted-space">\s*<\/span>/g, ' ')
    .replace(/&nbsp;/g, ' ');
  
  // 2) Sanitize
  const cleanHtml = DOMPurify.sanitize(cleanedHtml, {
    USE_PROFILES: { html: true },
    ADD_TAGS: [
      "sup", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
      "ul", "ol", "li",
    ],
    ADD_ATTR: ["id", "href", "content-id"],
  });

  // 2) Parse
  const doc = new DOMParser().parseFromString(cleanHtml, "text/html");
  const body = doc.body;

  // --- Helper Functions ---
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

    linksToProcess.forEach((data, targetId) => {
      const { targetElement, links } = data;
      const newPrefixedId = `${idPrefix}${targetId}`;

      if (blockTags.includes(targetElement.tagName)) {
        const anchor = doc.createElement("a");
        anchor.id = newPrefixedId;
        targetElement.prepend(anchor);
        targetElement.removeAttribute("id");
      } else {
        targetElement.id = newPrefixedId;
      }

      links.forEach((link) => {
        link.setAttribute("href", `#${newPrefixedId}`);
      });
    });
  })();

  // 4) Structural transformation (NEW: Router-based strategy with OUP)

  function parseSageBibliography(body) {
    console.log("Parsing with Aggressive Flattening strategy.");
    const biblioItems = body.querySelectorAll('.ref, [role="listitem"], .js-splitview-ref-item');
    
    biblioItems.forEach(item => {
        const clone = item.cloneNode(true);
        clone.querySelectorAll('.external-links, .to-citation__wrapper, .citation-links').forEach(el => el.remove());
        
        const contentSource = clone.querySelector('.citation-content, .mixed-citation') || clone;
        let content = contentSource.innerHTML;

        content = content.replace(/<div[^>]*>/g, ' ').replace(/<\/div>/g, ' ');
        content = content.replace(/<\/?p[^>]*>/g, ' ');
        content = content.replace(/<\/?span[^>]*>/g, '');
        
        const p = document.createElement('p');
        p.innerHTML = content.replace(/\s+/g, ' ').trim();
        item.replaceWith(p);
    });
  }

  
  function parseOupContent(body) {
    console.log("Parsing with OUP-specific strategy.");
    
    // Handle OUP footnotes: convert complex nested structure to simple number + content
    const footnotes = body.querySelectorAll('[content-id^="fn"].footnote');
    
    footnotes.forEach(footnote => {
      // Extract the footnote number from the nested structure
      const numberSpan = footnote.querySelector('.end-note-link');
      const number = numberSpan ? numberSpan.textContent.trim() : '';
      
      // Extract the footnote content from the nested paragraph
      const contentParagraph = footnote.querySelector('.footnote-compatibility');
      const content = contentParagraph ? contentParagraph.innerHTML.trim() : '';
      
      if (number && content) {
        // Create a single clean paragraph: number + content
        const p = document.createElement('p');
        p.innerHTML = `${number}. ${content}`;
        footnote.replaceWith(p);
        console.log(`📝 OUP: Merged footnote ${number} with content`);
      } else {
        console.warn(`📝 OUP: Failed to extract number (${number}) or content (${content.substring(0, 50)}) from footnote`);
      }
    });

    // Handle other OUP bibliography items
    const biblioItems = body.querySelectorAll('.ref, [role="listitem"], .js-splitview-ref-item');
    biblioItems.forEach(item => {
        const clone = item.cloneNode(true);
        clone.querySelectorAll('.external-links, .to-citation__wrapper, .citation-links').forEach(el => el.remove());
        
        const contentSource = clone.querySelector('.citation-content, .mixed-citation') || clone;
        let content = contentSource.innerHTML;

        content = content.replace(/<div[^>]*>/g, ' ').replace(/<\/div>/g, ' ');
        content = content.replace(/<\/?p[^>]*>/g, ' ');
        content = content.replace(/<\/?span[^>]*>/g, '');
        
        const p = document.createElement('p');
        p.innerHTML = content.replace(/\s+/g, ' ').trim();
        item.replaceWith(p);
    });

    // Apply general cleanup for any remaining nested structures
    parseGeneralContent(body);
  }

  function parseTaylorFrancisContent(body) {
    console.log("Parsing with Taylor & Francis structure strategy.");
    
    // Find and mark footnote paragraphs with special class
    // Look for Notes sections and summation-section divs
    const notesHeadings = body.querySelectorAll('h1, h2, h3, h4, h5, h6');
    notesHeadings.forEach(heading => {
      if (/notes/i.test(heading.textContent.trim()) || heading.id === 'inline_frontnotes') {
        console.log(`📝 T&F: Found Notes heading: "${heading.textContent.trim()}"`);
        
        // Mark all following paragraphs as footnotes until we hit another heading
        let nextElement = heading.nextElementSibling;
        while (nextElement) {
          if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
            // Hit another heading, stop
            break;
          }
          
          if (nextElement.tagName === 'P') {
            const pText = nextElement.textContent.trim();
            // Check if it starts with a number (footnote pattern)
            if (/^(\d+)[\.\)\s]/.test(pText)) {
              nextElement.classList.add('footnote');
              console.log(`📝 T&F: Marked paragraph as footnote: "${pText.substring(0, 50)}..."`);
            }
          } else if (nextElement.tagName === 'DIV') {
            // Look inside divs (like summation-section)
            const paragraphs = nextElement.querySelectorAll('p');
            paragraphs.forEach(p => {
              const pText = p.textContent.trim();
              if (/^(\d+)[\.\)\s]/.test(pText)) {
                p.classList.add('footnote');
                console.log(`📝 T&F: Marked paragraph in div as footnote: "${pText.substring(0, 50)}..."`);
              }
            });
          }
          
          nextElement = nextElement.nextElementSibling;
        }
      }
    });
    
    // Also check for summation-section divs specifically
    const summationSections = body.querySelectorAll('.summation-section, div[id^="EN"]');
    summationSections.forEach(section => {
      console.log(`📝 T&F: Found footnote section: ${section.className || section.id}`);
      const paragraphs = section.querySelectorAll('p');
      paragraphs.forEach(p => {
        const pText = p.textContent.trim();
        if (/^(\d+)[\.\)\s]/.test(pText)) {
          p.classList.add('footnote');
          console.log(`📝 T&F: Marked paragraph in section as footnote: "${pText.substring(0, 50)}..."`);
        }
      });
    });
    
    // Apply general content parsing to handle structure
    parseGeneralContent(body);
  }

  function parseGeneralContent(body) {
    console.log("Parsing with General (Structure Preserving) strategy.");
    function wrapLooseNodes(container) {
        const blockTags = /^(P|H[1-6]|BLOCKQUOTE|UL|OL|LI|PRE|DIV|TABLE|FIGURE)$/;
        const nodesToProcess = Array.from(container.childNodes);
        let currentWrapper = null;
        for (const node of nodesToProcess) {
            const isBlock = node.nodeType === Node.ELEMENT_NODE && blockTags.test(node.tagName);
            if (isBlock) {
                currentWrapper = null;
                continue;
            }
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '') {
                continue;
            }
            if (!currentWrapper) {
                currentWrapper = document.createElement('p');
                container.insertBefore(currentWrapper, node);
            }
            currentWrapper.appendChild(node);
        }
    }
    const containers = Array.from(body.querySelectorAll('div, article, section, main, header, footer, aside, nav, button'));
    containers.reverse().forEach(container => {
        wrapLooseNodes(container);
        unwrap(container);
    });
    body.querySelectorAll('font').forEach(unwrap);
  }

  // --- ROUTER ---
  let formatType = 'general';
  const isTaylorFrancis = body.querySelector('.ref-lnk.lazy-ref.bibr, .NLM_sec, .hlFld-Abstract, li[id^="CIT"]');
  const isSage = body.querySelector('.citations, .ref, [role="listitem"]');
  const isOup = body.querySelector('[content-id^="bib"], .js-splitview-ref-item, .footnote[content-id^="fn"]');

  if (isTaylorFrancis) {
    formatType = 'taylor-francis';
    console.log('📚 Detected Taylor & Francis format - applying citation cleanup');
    parseTaylorFrancisContent(body);
  } else if (isOup) {
    formatType = 'oup';
    parseOupContent(body);
  } else if (isSage) {
    formatType = 'sage';
    parseGeneralContent(body);
  } else {
    parseGeneralContent(body);
  }

  // 5) Cleanup (unchanged)
  body.querySelectorAll("p, blockquote, h1, h2, h3, li").forEach((el) => {
    if (!el.textContent.trim() && !el.querySelector("img") && !el.querySelector("a[id^='pasted-']")) {
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

  // 6) Final cleanup: Wrap any remaining loose inline elements
  const looseInlineElements = Array.from(body.childNodes).filter(node => 
    node.nodeType === Node.ELEMENT_NODE && 
    node.tagName && 
    !isBlockElement(node.tagName)
  );
  
  looseInlineElements.forEach(element => {
    const wrapper = doc.createElement('p');
    element.parentNode.insertBefore(wrapper, element);
    wrapper.appendChild(element);
  });

  return { html: body.innerHTML, format: formatType };
}

async function handlePaste(event) {
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
    
    
    let htmlContent = "";
    let formatType = 'general'; // Default format

    // PRIORITIZE HTML PATH
    if (rawHtml.trim()) {
      console.log("HTML found on clipboard, prioritizing HTML path.");
      const assimilated = assimilateHTML(rawHtml);
      htmlContent = assimilated.html;
      formatType = assimilated.format;
      console.log(`Assimilation complete. Detected format: ${formatType}`);
      
    }
    // FALLBACK TO MARKDOWN/PLAINTEXT PATH
    else {
      const isMarkdown = detectMarkdown(plainText);
      if (isMarkdown) {
        console.log("No HTML found, entering markdown branch");
        event.preventDefault(); // This is now safe to call
        
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
      }
    }

    // 3) Get our reliable estimate.
    const estimatedNodes = estimatePasteNodeCount(htmlContent || plainText);
    console.log("PASTE EVENT:", {
      length: plainText.length,
      isMarkdown: detectMarkdown(plainText), // Re-check for logging
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
      !!htmlContent,
      formatType // Pass the detected format
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
    // Also clear the safety mechanism flag
    isPasteOperationInProgress = false;
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
    `Small paste (≈${nodeCount} nodes); handling with browser insertion and ID fix-up.`
  );

  // --- 1. PREPARE THE CONTENT ---
  let finalHtmlToInsert = htmlContent;

  // If we only have plain text, convert it to structured HTML.
  // This ensures that pasting text with blank lines creates new paragraphs.
  if (!finalHtmlToInsert && plainText) {
    finalHtmlToInsert = plainText
      .split(/\n\s*\n/) // Split on blank lines
      .filter((p) => p.trim())
      .map((p) => `<p>${p}</p>`) // Wrap each part in a <p> tag
      .join("");
  }

  // If there's nothing to insert, we're done.
  if (!finalHtmlToInsert) {
    return true;
  }

  // --- 2. GET INSERTION CONTEXT (BEFORE PASTING) ---
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

  // --- 3. PERFORM THE PASTE ---
  event.preventDefault(); // Take control from the browser!

  // Check if we're pasting into an H1 - always use manual insertion to prevent nesting
  const isH1Destination = currentBlock && currentBlock.tagName === 'H1';
  
  if (isH1Destination) {
    console.log(`H1 destination detected with ${nodeCount} nodes - using manual insertion to prevent nesting`);
    
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
      
      // 3. Manually trigger title sync for H1#1 changes (since we bypassed mutation observer)
      if (currentBlock.id === '1') {
        console.log('Triggering manual title sync for H1#1 after paste');
        const newTitle = currentBlock.innerText.trim();
        
        // Import and call updateLibraryTitle directly
        import('./divEditor.js').then(({ updateLibraryTitle }) => {
          updateLibraryTitle(book, newTitle).catch(console.error);
        });
        
        // Also trigger a manual input event to ensure initTitleSync picks it up
        setTimeout(() => {
          const inputEvent = new Event('input', { bubbles: true });
          currentBlock.dispatchEvent(inputEvent);
        }, 0);
      }
    }
  } else {
    // Normal paste - use execCommand (safe for small pastes or non-H1 destinations)
    document.execCommand("insertHTML", false, finalHtmlToInsert);
  }

  // --- 4. FIX-UP: ASSIGN IDS TO NEWLY CREATED ELEMENTS ---
  console.log("Fix-up phase: Scanning for new nodes to assign IDs.");

  // The original block was modified, so save it.
  queueNodeForSave(currentBlock.id, "update");

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
    // Only process block-level elements that are missing a valid ID.
    if (
      elementToProcess.matches("p, h1, h2, h3, h4, h5, h6, div, pre, blockquote") &&
      (!elementToProcess.id || !/^\d+(\.\d+)*$/.test(elementToProcess.id))
    ) {
      const newId = generateIdBetween(lastKnownId, nextStableNodeId);
      elementToProcess.id = newId;
      console.log(`Assigned new ID ${newId} to pasted element.`);

      // This is a newly created element.
      queueNodeForSave(newId, "create");
      lastKnownId = newId;
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
  isHtmlContent = false,
  formatType = 'general' // Add formatType argument
) {
  event.preventDefault();

  // --- 1. PROCESS FOOTNOTES AND REFERENCES ---
  let processedContent = pastedContent;
  let extractedFootnotes = [];
  let extractedReferences = [];
  
  try {
    // Pass the formatType to the processor
    const result = await processContentForFootnotesAndReferences(pastedContent, insertionPoint.book, isHtmlContent, formatType);
    processedContent = result.processedContent;
    extractedFootnotes = result.footnotes;
    extractedReferences = result.references;
    console.log(`✅ Extracted ${extractedFootnotes.length} footnotes and ${extractedReferences.length} references.`);

  } catch (error) {
      console.error('❌ Error processing footnotes/references:', error);
      processedContent = pastedContent; // Fallback to original content on error
  }

  // --- 2. HANDLE H1 REPLACEMENT LOGIC ---
  const selection = window.getSelection();
  const currentElement = document.getElementById(insertionPoint.beforeNodeId);
  const isH1 = currentElement && currentElement.tagName === 'H1' && currentElement.id === '1';
  const isH1Selected = isH1 && selection.toString().trim().length > 0;
  
  if (isH1Selected) {
    console.log('H1 is selected - replacing it entirely with pasted content');
    // Remove H1 from DOM
    currentElement.remove();
    
    // Delete H1 from IndexedDB
    const { deleteIndexedDBRecord } = await import('./cache-indexedDB.js');
    await deleteIndexedDBRecord(insertionPoint.book, "1");
    
    // Update insertion point to be after node 0 (so first paste becomes node 1)
    insertionPoint.beforeNodeId = "0";
    insertionPoint.currentNodeId = "0";
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

  console.log("Writing chunks to IndexedDB:", toWrite.length);
  await writeNodeChunks(toWrite);
  
  // Queue each chunk for PostgreSQL sync
  toWrite.forEach((chunk) => {
    if (chunk && chunk.startLine) {
      queueForSync("nodeChunks", chunk.startLine, "update", chunk);
    }
  });
  
  console.log("Successfully merged paste with tail chunks");

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
  // Updated regex to handle mixed quote types (regular + smart quotes)
  const quoteMatch = clipboardHtml.match(/[''""]([^]*?)[''""](?=<a|$)/);
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

  // Clean up the quoted text - handle both ASCII and smart quotes, including mixed types
  // Remove any quote character from start and end separately to handle mixed quote types
  quotedText = quotedText.replace(/^[''""]/, '').replace(/[''""]$/, ''); // Remove quotes
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
      
      if (brSeparatedParts.length > 1) {
        // Split on <br> tags - each part becomes a separate block
        brSeparatedParts.forEach(part => {
          const trimmedPart = part.trim();
          if (trimmedPart) {
            // Create a new element of the same type with the split content
            const newElement = document.createElement(child.tagName.toLowerCase());
            newElement.innerHTML = trimmedPart;
            blocks.push(newElement.outerHTML);
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






