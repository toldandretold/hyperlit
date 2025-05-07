import { book } from "./app.js";
import { 
  updateIndexedDBRecord, 
  getNodeChunksFromIndexedDB,
  parseNodeId,
  createNodeChunksKey, 
  deleteIndexedDBRecordWithRetry,
  deleteIndexedDBRecord
          } from "./cache-indexedDB.js";
import { 
  withPending
} from './operationState.js';
import { openDatabase,
         updateCitationForExistingHypercite,
         updateHyperciteInIndexedDB,
         saveFootnotesToIndexedDB
          } from "./cache-indexedDB.js";
import { buildBibtexEntry } from "./bibtexProcessor.js";
import { generateUniqueId, 
         isDuplicateId, 
         getNextDecimalForBase,
         normalizeNodeIds,
         generateInsertedNodeId,
          } from "./IDfunctions.js";
import {
  broadcastToOpenTabs
} from './BroadcastListener.js';

import { convertMarkdownToHtml, parseMarkdownIntoChunksInitial } from './convert-markdown.js';
import { processFootnotes } from './footnotes.js';


// Tracking sets
const modifiedNodes = new Set(); // Track element IDs whose content was modified.
const addedNodes = new Set(); // Track newly-added element nodes.
const removedNodeIds = new Set(); // Track IDs of removed nodes.

// Global observer variable
let observer;
// Global variable to track the currently observed chunk.
let currentObservedChunk = null;
// Track document changes for debounced normalization
let documentChanged = false;
// hypercite paste handling
let hypercitePasteInProgress = false;
// track user activity
let debounceTimer = null;





// Start observing only inside the current chunk container.
export function startObserving(editableDiv) {
  console.log("🤓 startObserving function called");

  // Tell the browser "Enter key ⇒ <p>" instead of <div>
  document.execCommand('defaultParagraphSeparator', false, 'p');

  // Stop any existing observer first
  stopObserving();
  
  const currentChunk = editableDiv || getCurrentChunk();
  if (!currentChunk) {
    console.warn("No active chunk found; observer not attached.");
    return;
  }
  currentObservedChunk = currentChunk;
  console.log("Observing changes in chunk:", currentChunk);

  // Modify the MutationObserver callback in startObserving function
  observer = new MutationObserver(async (mutations) => {
    // Skip processing if a hypercite paste is in progress
    if (hypercitePasteInProgress) {
      console.log("Skipping mutations during hypercite paste");
      return;
    }

    // Skip mutations related to status icons
    if (mutations.some(mutation => 
        mutation.target.id === "status-icon" || 
        (mutation.target.parentNode && mutation.target.parentNode.id === "status-icon") ||
        mutation.addedNodes.length && Array.from(mutation.addedNodes).some(node => 
          node.id === "status-icon" || (node.parentNode && node.parentNode.id === "status-icon")
        )
      )) {
      console.log("Skipping mutations related to status icons");
      return;
    }

    
    // Track parent nodes that need updates
    const parentsToUpdate = new Set();

    for (const mutation of mutations) {
      // Process removals first to ensure they're not missed
      if (mutation.type === "childList" && mutation.removedNodes.length > 0) {
        let shouldUpdateParent = false;
        let parentNode = null;
        
        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if this is a top-level paragraph/heading being removed
            if (node.id && node.id.match(/^\d+(\.\d+)?$/)) {
              console.log(`Top-level node removed: ${node.id}`, node);
              await deleteIndexedDBRecordWithRetry(node.id);
              removedNodeIds.add(node.id);
            } 
            // Check if this is a child element (like a hypercite) being removed
            else if (node.id && node.id.startsWith("hypercite_")) {
              // Instead of deleting, mark the parent for update
              parentNode = mutation.target;
              shouldUpdateParent = true;
              console.log(`Hypercite removed from parent: ${parentNode.id}`, node);
            }
          }
        }
         
        
        // If we found a parent that needs updating, add it to our set
        if (shouldUpdateParent && parentNode) {
          // Find the closest parent with a numeric ID
          let closestParent = parentNode;
          while (closestParent && (!closestParent.id || !closestParent.id.match(/^\d+(\.\d+)?$/))) {
            closestParent = closestParent.parentElement;
          }
          
          if (closestParent && closestParent.id) {
            parentsToUpdate.add(closestParent);
          }
        }
      }

      // --- NEW GUARD: skip any childList where all added nodes are arrow‐icons ---
      if (mutation.type === "childList") {
        const allAreIcons = Array.from(mutation.addedNodes).every((n) => {
          if (n.nodeType !== Node.ELEMENT_NODE) return false;
          const el = /** @type {HTMLElement} */ (n);
          // span.open-icon itself
          if (el.classList.contains("open-icon")) return true;
          // or an <a> whose only child is that span
          if (
            el.tagName === "A" &&
            el.children.length === 1 &&
            el.firstElementChild.classList.contains("open-icon")
          ) {
            return true;
          }
          return false;
        });
        if (allAreIcons) {
          // console.log("Skipping pure-icon mutation");
          continue;
        }
      }

      // 1) Title-sync logic for H1#1
      const h1 = document.getElementById("1");
      if (h1) {
        // characterData inside H1
        if (
          mutation.type === "characterData" &&
          mutation.target.parentNode?.closest('h1[id="1"]')
        ) {
          const newTitle = h1.innerText.trim();
          updateLibraryTitle(book, newTitle).catch(console.error);
          updateIndexedDBRecord({
            id: h1.id,
            html: h1.outerHTML,
            action: "update"
          }).catch(console.error);
        }
        // childList under H1 (e.g. paste)
        if (
          mutation.type === "childList" &&
          Array.from(mutation.addedNodes).some((n) =>
            n.closest && n.closest('h1[id="1"]')
          )
        ) {
          const newTitle = h1.innerText.trim();
          updateLibraryTitle(book, newTitle).catch(console.error);
          updateIndexedDBRecord({
            id: h1.id,
            html: h1.outerHTML,
            action: "update"
          }).catch(console.error);
        }
      }

      // 2) Original logic: additions / deletions
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            ensureNodeHasValidId(node);
            updateIndexedDBRecord({
              id: node.id,
              html: node.outerHTML,
              action: "add"
            }).catch(console.error);
            addedNodes.add(node);
          }
        });
        
        // We're handling removals differently now, so this part is modified
        // to only handle top-level node removals
      }
      // 3) Original logic: characterData updates
      else if (mutation.type === "characterData") {
        const parent = mutation.target.parentNode;
        if (parent && parent.id) {
          updateIndexedDBRecord({
            id: parent.id,
            html: parent.outerHTML,
            action: "update"
          }).catch(console.error);
          modifiedNodes.add(parent.id);
        }
      }
    }
    
    // Process all parent nodes that need updates
    parentsToUpdate.forEach(parent => {
      console.log(`Updating parent node after child removal: ${parent.id}`);
      updateIndexedDBRecord({
        id: parent.id,
        html: parent.outerHTML,
        action: "update"
      }).catch(console.error);
      modifiedNodes.add(parent.id);
    });

    debouncedNormalize(currentObservedChunk);
  });


  observer.observe(currentChunk, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  console.log("Observer started in chunk:", currentChunk);
  
  setTimeout(() => {
    normalizeNodeIds(currentChunk);
  }, 1000);
}


// Function to stop the MutationObserver.
export function stopObserving() {
  if (observer) {
    observer.disconnect();
    observer = null;
    console.log("Observer disconnected");
  }
  
  // Reset all state variables
  currentObservedChunk = null;
  modifiedNodes.clear();
  addedNodes.clear();
  removedNodeIds.clear();
  documentChanged = false;
  
  // Remove any lingering spinner
  const existingSpinner = document.getElementById("status-icon");
  if (existingSpinner) {
    existingSpinner.remove();
    console.log("Removed lingering spinner");
  }
  
  console.log("Observer and related state fully reset");
}


// Listen for selection changes and restart observing if the current chunk has changed.
document.addEventListener("selectionchange", () => {
  // Only perform chunk-observer restarts in edit mode.
  if (!window.isEditing) return;

  const newChunk = getCurrentChunk();
  if (newChunk !== currentObservedChunk) {
    console.log("Chunk change detected. Restarting observer...");
    stopObserving();
    if (newChunk) {
      startObserving(newChunk);
    } else {
      currentObservedChunk = null;
      console.warn("Lost focus on any chunk.");
    }
  }
});

// Add paste event listener to handle hypercites
export function addPasteListener(editableDiv) {
  console.log("Adding paste listener for hypercite updates");
  
  editableDiv.addEventListener("paste", async (event) => {
    const clipboardHtml = event.clipboardData.getData("text/html");
    if (!clipboardHtml) return;
    
    // Parse clipboard HTML
    const pasteWrapper = document.createElement("div");
    pasteWrapper.innerHTML = clipboardHtml;
    
    pasteWrapper.querySelectorAll('p[id]').forEach(el => {
      // only clear numeric IDs
      if (/^\d+(\.\d+)?$/.test(el.id)) {
        el.removeAttribute('id');
      }
    });

    // Look for either the link directly or a link inside a sup with class "open-icon"
    const citeLink = pasteWrapper.querySelector(
      'a[id^="hypercite_"] > span.open-icon'
    )?.parentElement;
    
    // Check if this is a hypercite link by examining the structure and href
    if (citeLink && 
        (citeLink.innerText.trim() === "↗" || 
         (citeLink.closest("span") && citeLink.closest("span").classList.contains("open-icon")))) {
      
      // Prevent default paste behavior
      event.preventDefault();
      
      console.log("Detected a hypercite in pasted content");
      
      const originalHref = citeLink.getAttribute("href");
      const parsed = parseHyperciteHref(originalHref);
      if (!parsed) return;
      
      const { booka, hyperciteIDa, citationIDa } = parsed;
      console.log("Parsed citation info:", { booka, hyperciteIDa, citationIDa });
      
      // Generate new hypercite ID for this instance
      const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);
      
      // Get current book (where paste is happening)
      const bookb = book;
      
      // Create the citation ID for this new instance
      const citationIDb = `/${bookb}#${hyperciteIDb}`;
      
      // Get the text content that was quoted - look for the quoted text pattern
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
      
      // Create the reference HTML with no space between text and sup
     const referenceHtml = `${quotedText}<a href="${originalHref}" id="${hyperciteIDb}">\u200B<sup class="open-icon">↗</sup></a>`;

      
      // Set the flag to prevent MutationObserver from processing this paste
      hypercitePasteInProgress = true;
      console.log("Setting hypercitePasteInProgress flag to true");
      
      // Insert the content
      document.execCommand("insertHTML", false, referenceHtml);
      
      // Get the current paragraph to manually save it
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        let currentParagraph = range.startContainer;
        while (currentParagraph && currentParagraph.nodeName !== 'P') {
          currentParagraph = currentParagraph.parentNode;
        }
        
        if (currentParagraph && currentParagraph.id) {

          console.log("Manually saving paragraph:", currentParagraph.id);
          // Manually save the paragraph to IndexedDB
          updateIndexedDBRecord({
            id: currentParagraph.id,
            html: currentParagraph.outerHTML,
            action: "update"
          }).catch(console.error);
        }
      }
      
      // Update the original hypercite's citedIN array
      const updated = await updateCitationForExistingHypercite(
        booka, 
        hyperciteIDa, 
        citationIDb,
        false // Don't insert content, just update the database
      );
      
      if (updated) {
        console.log(`Successfully linked: ${citationIDa} cited in ${citationIDb}`);
      } else {
        console.warn(`Failed to update citation for ${citationIDa}`);
      }
      
      // Clear the flag after a short delay to allow DOM to settle
      setTimeout(() => {
        hypercitePasteInProgress = false;
        console.log("Cleared hypercitePasteInProgress flag");
      }, 100);
    }
  });
}

// Track typing activity
document.addEventListener("keydown", function handleTypingActivity() {
  // Only show spinner if in edit mode
  if (!window.isEditing) return;
  
  
    if (currentObservedChunk) {
      debouncedNormalize(currentObservedChunk);
    }
});

function handlePaste(event) {
  const text = event.clipboardData.getData('text/plain');
  const html = event.clipboardData.getData('text/html');
  if (!text || html) return;  // only handle pure-text

  event.preventDefault();

  // 1) find the insertion point
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  let ref = sel.getRangeAt(0).startContainer;
  while (ref && !ref.id) ref = ref.parentElement;
  if (!ref) return;
  const parent = ref.parentNode;

  // 2) process footnotes & convert markdown
  const footData = processFootnotes(text);
  saveFootnotesToIndexedDB(
    footData.pairs.map(p => ({ id: p.reference.id, content: p.definition.content })),
    book
  );
  const rendered = convertMarkdownToHtml(text);

  // 3) build nodes and strip any IDs
  const wrapper = document.createElement('div');
  wrapper.innerHTML = rendered;
  wrapper.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

  // 4) insert after ref
  let insertAfter = ref;
  Array.from(wrapper.childNodes).forEach(node => {
    parent.insertBefore(node, insertAfter.nextSibling);
    insertAfter = node;
  });

  // 5) remove empty <p>
  let node = ref.nextSibling;
  while (node && !node.id) {
    const nxt = node.nextSibling;
    if (
      node.tagName === 'P' &&
      node.textContent.trim() === ''
    ) {
      parent.removeChild(node);
    }
    node = nxt;
  }

  // 6) assign decimal IDs
  const baseMatch = ref.id.match(/^(\d+)(?:\.\d+)?$/);
  if (!baseMatch) return;
  const base = baseMatch[1];

  node = ref.nextSibling;
  const toId = [];
  while (node && !node.id) {
    if (['P','H1','H2','H3','H4','BLOCKQUOTE'].includes(node.tagName)) {
      toId.push(node);
    }
    node = node.nextSibling;
  }

  toId.forEach(el => {
    el.id = getNextDecimalForBase(base);
  });
}
// lookup the element
const editableDiv = document.getElementById(book);
// attach the listener
editableDiv.addEventListener("paste", handlePaste);


// ----------------------------------------------------------------
// Track cursor position when Enter is pressed
// ----------------------------------------------------------------
document.addEventListener("keydown", function handleENTERpress(event) {
  if (event.key === "Enter") {
    const selection = document.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      let currentNode = range.startContainer;
      if (currentNode.nodeType !== Node.ELEMENT_NODE) {
        currentNode = currentNode.parentElement;
      }
      while (currentNode && (!currentNode.id || 
             !['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI'].includes(currentNode.tagName))) {
        currentNode = currentNode.parentElement;
      }
      if (currentNode && currentNode.id) {
        let cursorPosition = "middle";
        if (range.startOffset === 0) {
          cursorPosition = "start";
        } else if (range.startContainer.nodeType === Node.TEXT_NODE && 
                  range.startOffset === range.startContainer.length) {
          cursorPosition = "end";
        }
        window.__enterKeyInfo = {
          nodeId: currentNode.id,
          cursorPosition: cursorPosition,
          timestamp: Date.now()
        };
        console.log("Enter pressed in node:", currentNode.id, "at position:", cursorPosition);
      }
    }
  }
});





// Helper: Parse hypercite URL to extract components
function parseHyperciteHref(href) {
  try {
    const url = new URL(href, window.location.origin);
    const booka = url.pathname.replace(/^\//, ""); // e.g., "booka"
    const hyperciteIDa = url.hash.substr(1);       // e.g., "hyperciteIda"
    const citationIDa = `/${booka}#${hyperciteIDa}`; // e.g., "/booka#hyperciteIda"
    return { citationIDa, hyperciteIDa, booka };
  } catch (error) {
    console.error("Error parsing hypercite href:", href, error);
    return null;
  }
}




/**
 * Ensure there's a library record for this book. If it doesn't exist,
 * create a minimal one (you can expand this with author/timestamp/bibtex).
 */
/** Ensure there’s a library record for this book (or create a stub). */
async function ensureLibraryRecord(bookId) {
  const db = await openDatabase();

  // FIRST: read‑only to check existence
  {
    const tx = db.transaction("library", "readonly");
    const store = tx.objectStore("library");
    const rec = await new Promise((res, rej) => {
      const req = store.get(bookId);
      req.onsuccess  = () => res(req.result);
      req.onerror    = () => rej(req.error);
    });
    await tx.complete;  // make sure the readonly tx closes
    if (rec) {
      return rec;      // already there—no open tx left dangling
    }
  }

  // SECOND: read‑write to create
  {
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    const newRec = {
      citationID: bookId,
      title: "",
      author: localStorage.getItem("authorId") || "anon",
      type: "book",
      timestamp: new Date().toISOString(),
    };
    store.put(newRec);
    await tx.complete;
    return newRec;
  }
}



/** Update only the title field (and regenerate bibtex) in the library record. */
export async function updateLibraryTitle(bookId, newTitle) {
  const db = await openDatabase();
  const tx = db.transaction("library", "readwrite");
  const store = tx.objectStore("library");

  return new Promise((resolve, reject) => {
    const req = store.get(bookId);
    req.onsuccess = (e) => {
      const rec = e.target.result;
      if (!rec) return reject(new Error("Library record missing"));

      // 1) Update title
      rec.title = newTitle;

      // 2) Regenerate the bibtex string so it stays in sync
      rec.bibtex = buildBibtexEntry(rec);

      // 3) Write back the record
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve(rec);
      putReq.onerror   = (e) => reject(e.target.error);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}




/**
 * Call this in edit mode to:
 *   1) make sure library[bookId] exists
 *   2) watch <h1 id="1"> inside the div#bookId
 *   3) sync its text into library.title
 */
export async function initTitleSync(bookId) {
  console.log("⏱ initTitleSync()", { bookId });
  const editableContainer = document.getElementById(bookId);
  if (!editableContainer) {
    console.warn(`initTitleSync: no div#${bookId}`);
    return;
  }

  await ensureLibraryRecord(bookId);

  const titleNode = editableContainer.querySelector('h1[id="1"]');
  if (!titleNode) {
    console.warn("initTitleSync: no <h1 id=\"1\"> found");
    return;
  }
  console.log("initTitleSync: found titleNode", titleNode);

  // Debounced writer, with logging
  const writeTitle = debounce(async () => {
    const newTitle = titleNode.innerText.trim();
    console.log("🖉 [title-sync] writeTitle firing, newTitle=", newTitle);
    try {
      await updateLibraryTitle(bookId, newTitle);
      console.log("✔ [title-sync] updated library.title=", newTitle);
    } catch (err) {
      console.error("✖ [title-sync] failed to update:", err);
    }
  }, 500);

  // direct listener on the h1
  titleNode.addEventListener("input", (e) => {
    console.log("🖉 [title-sync] input event on H1", e);
    writeTitle();
  });

  // fallback: capture any input in the container and see if it's the H1
  editableContainer.addEventListener("input", (e) => {
    if (e.target === titleNode || titleNode.contains(e.target)) {
      console.log("🖉 [title-sync] container catch of input on H1", e);
      writeTitle();
    }
  });

  // also observe mutations just in case execCommand or paste bypasses input
    new MutationObserver((muts) => {
    muts.forEach((m) => {
      if (m.type === "characterData") {
        // m.target could be a Text node
        const parent = m.target.parentNode;
        if (
          parent &&
          parent.nodeType === Node.ELEMENT_NODE &&
          parent.closest('h1[id="1"]')
        ) {
          console.log("🖉 [title-sync] mutation detect", m);
          writeTitle();
        }
      }
    });
  }).observe(titleNode, { characterData: true, subtree: true });


  console.log("🛠 Title‑sync initialized for book:", bookId);
}










// ----------------------------------------------------------------
// Debounce function for delayed operations
// ----------------------------------------------------------------
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
}

// Debounced normalization function for editable div, including saving cues
const debouncedNormalize = debounce((container) => {
  if (!documentChanged) return;
  console.log("User stopped typing; normalizing and saving…");
  // this wrapper will increment before running, and decrement when done
  withPending(async () => {
    const changes = await normalizeNodeIds(container);
    if (changes) {
      console.log("Normalization made changes");
    } else {
      console.log("Normalization complete—no changes needed");
    }
    documentChanged = false;
  }).catch(console.error);
}, 500);

// ----------------------------------------------------------------
// Utility: Get the chunk element where the cursor is currently located.
function getCurrentChunk() {
  const selection = document.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node = node.parentElement;
    }
    return node.closest(".chunk");
  }
  return null;
}

// Replace original ensureNodeHasValidId with enhanced version using decimal logic.
function ensureNodeHasValidId(node, options = {}) {
  const { referenceNode, insertAfter } = options;
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  
  if (window.__enterKeyInfo && Date.now() - window.__enterKeyInfo.timestamp < 500) {
    const { nodeId, cursorPosition } = window.__enterKeyInfo;
    const referenceNode = document.getElementById(nodeId);
    if (referenceNode) {
      if (cursorPosition === "start") {
        const parent = referenceNode.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const refIndex = siblings.indexOf(referenceNode);
          if (refIndex > 0) {
            const nodeAbove = siblings[refIndex - 1];
            if (nodeAbove.id) {
              const baseMatch = nodeAbove.id.match(/^(\d+)/);
              if (baseMatch) {
                const baseId = baseMatch[1];
                node.id = getNextDecimalForBase(baseId);
                console.log(`Cursor at start: New node gets ID ${node.id} based on node above (${nodeAbove.id})`);
                window.__enterKeyInfo = null;
                return;
              }
            }
          } else {
            const baseMatch = referenceNode.id.match(/^(\d+)/);
            if (baseMatch) {
              const baseId = parseInt(baseMatch[1], 10);
              const newBaseId = Math.max(1, baseId - 1).toString();
              node.id = newBaseId;
              console.log(`No node above; new node gets ID ${node.id} (one less than reference ${referenceNode.id})`);
              window.__enterKeyInfo = null;
              return;
            }
          }
        }
      } else {
        const baseMatch = referenceNode.id.match(/^(\d+)/);
        if (baseMatch) {
          const baseId = baseMatch[1];
          node.id = getNextDecimalForBase(baseId);
          console.log(`Cursor at ${cursorPosition}: New node gets ${node.id}, reference node stays ${referenceNode.id}`);
          window.__enterKeyInfo = null;
          return;
        }
      }
    }
    window.__enterKeyInfo = null;
  }
  
  // If node already has an id, check for duplicates:
  if (node.id) {
    if (isDuplicateId(node.id)) {
      const match = node.id.match(/^(\d+)(\.\d+)?$/);
      if (match) {
        const baseId = match[1];
        const newId = getNextDecimalForBase(baseId);
        console.log(`ID conflict detected. Changing node id from ${node.id} to ${newId}`);
        node.id = newId;
      } else {
        const oldId = node.id;
        node.id = generateUniqueId();
        console.log(`ID conflict detected (non-numeric). Changing node id from ${oldId} to ${node.id}`);
      }
    }
  } else {
    if (referenceNode && typeof insertAfter === "boolean") {
      node.id = generateInsertedNodeId(referenceNode, insertAfter);
      console.log(`Assigned new id ${node.id} based on reference insertion direction.`);
    } else {
      node.id = generateUniqueId();
      console.log(`Assigned new unique id ${node.id} to node <${node.tagName.toLowerCase()}>`);
    }
  }
  
  documentChanged = true;
}

// Add this to your existing code
document.addEventListener("keydown", function(event) {
  if (event.key === "Enter" && window.isEditing) {
    // Prevent the default behavior
    event.preventDefault();
    
    // Get the current selection
    const selection = document.getSelection();
    if (selection.rangeCount === 0) return;
    
    const range = selection.getRangeAt(0);
    
    // Find the current block element
    let currentNode = range.startContainer;
    if (currentNode.nodeType !== Node.ELEMENT_NODE) {
      currentNode = currentNode.parentElement;
    }
    
    // Find the parent block element
    let blockElement = currentNode;
    while (blockElement && 
           !['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI'].includes(blockElement.tagName)) {
      blockElement = blockElement.parentElement;
    }
    
    if (!blockElement) return;
    
    // Split the content at cursor position
    const cursorOffset = range.startOffset;
    const isAtEnd = (range.startContainer.nodeType === Node.TEXT_NODE && 
                     cursorOffset === range.startContainer.length);
    
    // Create a new paragraph with plain text
    const newParagraph = document.createElement('p');
    
    if (isAtEnd) {
      // If cursor is at the end, just create an empty paragraph
      newParagraph.innerHTML = '<br>'; // Empty paragraph needs <br> to be visible
    } else {
      // Extract content after cursor
      const rangeToExtract = document.createRange();
      rangeToExtract.setStart(range.startContainer, cursorOffset);
      rangeToExtract.setEndAfter(blockElement);
      
      // Extract the content as plain text
      const extractedText = rangeToExtract.toString();
      
      // Delete the extracted content
      rangeToExtract.deleteContents();
      
      // Set the extracted text as plain text
      newParagraph.textContent = extractedText || '';
      if (!extractedText) {
        newParagraph.innerHTML = '<br>';
      }
    }
    
    // Insert the new paragraph after the current one
    blockElement.parentNode.insertBefore(newParagraph, blockElement.nextSibling);
    
    // Move cursor to the beginning of the new paragraph
    const newRange = document.createRange();
    newRange.setStart(newParagraph, 0);
    newRange.collapse(true);
    
    selection.removeAllRanges();
    selection.addRange(newRange);
    
    // Your existing code will handle ID assignment via MutationObserver
  }
});



