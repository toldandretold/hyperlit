import { book } from "./app.js";
import { navigateToInternalId, showNavigationLoading } from "./scrolling.js";
import { waitForElementReady, waitForMultipleElementsReady } from "./domReadiness.js";
import { getLocalStorageKey } from "./indexedDB.js";
import { openDatabase, 
         parseNodeId, 
         createNodeChunksKey, 
         getLibraryObjectFromIndexedDB,
         updateBookTimestamp,
         toPublicChunk,
         queueForSync,
         getNodeChunkFromIndexedDB,
         debouncedMasterSync  } from "./indexedDB.js";
import { ContainerManager } from "./containerManager.js";
import { formatBibtexToCitation } from "./bibtexProcessor.js";
import { currentLazyLoader } from './initializePage.js';
import { addTouchAndClickListener } from './hyperLights.js';
import { getCurrentUser, getAuthorId, getAnonymousToken, canUserEditBook } from "./auth.js";
import { handleUnifiedContentClick, initializeHyperlitManager, openHyperlitContainer, closeHyperlitContainer } from './unifiedContainer.js';


/**
 * Fetch library record from server as fallback
 */
async function fetchLibraryFromServer(bookId) {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content'),
      },
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Server request failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // The API returns {success: true, library: {...}, book_id: ...}
    if (data && data.success && data.library) {
      if (data.library.bibtex) {
        return data.library;
      } else if (data.library.title || data.library.author) {
        // Create basic bibtex from available fields
        const basicBibtex = `@misc{${bookId},
  author = {${data.library.author || 'Unknown'}},
  title = {${data.library.title || 'Untitled'}},
  year = {${new Date().getFullYear()}},
}`;
        return {
          ...data.library,
          bibtex: basicBibtex
        };
      }
    }
    
    return null;
  } catch (error) {
    console.error('Failed to fetch library record from server:', error);
    return null;
  }
}

let lastEventTime = 0;

function handleCopyEvent(event, bookId) {
  event.preventDefault();
  event.stopPropagation();
  
  const now = Date.now();
  if (now - lastEventTime < 300) return;
  lastEventTime = now;
  
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  // This check now uses the passed-in bookId
  if (!bookId) {
    console.error("Book identifier (bookId) was not passed to handleCopyEvent.");
    return;
  }

  const hyperciteId = generateHyperciteID();

  // Get clean text (your existing logic)
  const range = selection.getRangeAt(0);
  let parent = range.commonAncestorContainer;
  
  if (parent.nodeType === 3) {
    parent = parent.parentElement;
  }
  
  parent = parent.closest("[id]");
  
  let selectedText = "";
  
  if (parent) {
    const parentText = parent.textContent;
    const rangeText = range.toString();
    
    const startIndex = parentText.indexOf(rangeText);
    
    if (startIndex !== -1) {
      selectedText = parentText.substring(startIndex, startIndex + rangeText.length).trim();
      console.log("✅ Clean text from parent context:", selectedText);
    } else {
      selectedText = rangeText.trim();
    }
  } else {
    selectedText = selection.toString().trim();
  }

  const currentSiteUrl = `${window.location.origin}`;
  const citationIdA = bookId;
  const hrefA = `${currentSiteUrl}/${citationIdA}#${hyperciteId}`;

  const clipboardHtml = `'${selectedText}'<a href="${hrefA}" id="${hyperciteId}"><span class="open-icon">↗</span></a>`;
  const clipboardText = `'${selectedText}' [↗](${hrefA})`;

  console.log("Final clipboard HTML:", clipboardHtml);
  console.log("Final clipboard Text:", clipboardText);

  // SAVE the original selection
  const originalRange = selection.getRangeAt(0).cloneRange();

  let success = false;

  // Method 1: HTML via contentEditable div (most reliable for HTML on mobile)
  try {
    const tempDiv = document.createElement('div');
    tempDiv.contentEditable = true;
    tempDiv.innerHTML = clipboardHtml;
    tempDiv.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none;';
    
    document.body.appendChild(tempDiv);
    
    // Focus the div
    tempDiv.focus();
    
    // Select all content in the div
    const range = document.createRange();
    range.selectNodeContents(tempDiv);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    
    // Copy immediately while in user gesture context
    success = document.execCommand('copy');
    
    // Clean up
    document.body.removeChild(tempDiv);
    
    if (success) {
      console.log("✅ HTML copy via contentEditable success");
    }
  } catch (error) {
    console.warn("contentEditable copy failed:", error);
  }

  // Method 2: Modern API fallback (fire and forget)
  if (!success && navigator.clipboard && window.ClipboardItem) {
    try {
      const clipboardItem = new ClipboardItem({
        'text/html': new Blob([clipboardHtml], { type: 'text/html' }),
        'text/plain': new Blob([clipboardText], { type: 'text/plain' })
      });
      
      // Fire and forget - don't await to stay synchronous
      navigator.clipboard.write([clipboardItem]).then(() => {
        console.log("✅ Modern API HTML success");
      }).catch(error => {
        console.warn("Modern API failed:", error);
      });
      
      success = true; // Assume success since we can't wait
    } catch (error) {
      console.warn("Modern API setup failed:", error);
    }
  }

  // Method 3: Plain text fallback
  if (!success) {
    try {
      const tempInput = document.createElement('input');
      tempInput.type = 'text';
      tempInput.value = clipboardText;
      tempInput.style.cssText = 'position:absolute;left:-9999px;top:0;';
      
      document.body.appendChild(tempInput);
      tempInput.focus();
      tempInput.select();
      
      success = document.execCommand('copy');
      document.body.removeChild(tempInput);
      
      if (success) {
        console.log("✅ Plain text fallback success");
      }
    } catch (error) {
      console.warn("Plain text fallback failed:", error);
    }
  }

  if (success) {
    console.log("✅ Clipboard operation completed");
  } else {
    console.error("❌ All clipboard methods failed");
  }

  // RESTORE the original selection
  selection.removeAllRanges();
  selection.addRange(originalRange);

  // Wrap the selected text in the DOM
  try {
    wrapSelectedTextInDOM(hyperciteId, citationIdA);
  } catch (error) {
    console.error("Error wrapping text in DOM:", error);
  }
}






// Keep your existing wrapSelectedTextInDOM function unchanged
function wrapSelectedTextInDOM(hyperciteId, book) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return console.error("No selection");
  const range = selection.getRangeAt(0);

  // Check if selection spans multiple nodes with IDs
  if (selectionSpansMultipleNodes(range)) {
    // Show warning for multi-node selections
    alert("Apologies: for now, you can't hypercite more than one paragraph or node at a time.");
    setTimeout(() => selection.removeAllRanges(), 50);
    return;
  }

  // Find the nearest ancestor that has any ID at all:
  let parent = range.startContainer.nodeType === 3
    ? range.startContainer.parentElement
    : range.startContainer;
  parent = parent.closest("[id]");
  if (!parent) {
    console.error("No parent with an ID found for hypercite wrapping.");
    return;
  }

  // Now parent.id will be "1.2" or "2.1" etc—no parseInt, no drop!
  const wrapper = document.createElement("u");
  wrapper.id = hyperciteId;
  wrapper.className = "single";
  try {
    const fragment = range.extractContents();
    wrapper.appendChild(fragment);
    range.insertNode(wrapper);
  } catch (e) {
    console.error("Error wrapping selected text:", e);
    return;
  }

  const blocks = collectHyperciteData(hyperciteId, wrapper);
  NewHyperciteIndexedDB(book, hyperciteId, blocks);

  setTimeout(() => selection.removeAllRanges(), 50);
}

// Helper function to check if selection spans multiple nodes with IDs
function selectionSpansMultipleNodes(range) {
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: function(node) {
        // Only accept nodes that have a numerical ID and intersect with our range
        if (node.id && /^\d+(?:\.\d+)?$/.test(node.id)) {
          if (range.intersectsNode(node)) {
            return NodeFilter.FILTER_ACCEPT;
          }
        }
        return NodeFilter.FILTER_SKIP;
      }
    }
  );
  
  let nodeCount = 0;
  while (walker.nextNode()) {
    nodeCount++;
    if (nodeCount > 1) {
      return true; // Found more than one node, so it spans multiple
    }
  }
  
  return false; // Single node or no nodes
}

async function NewHyperciteIndexedDB(book, hyperciteId, blocks) {
  // Open the IndexedDB database
  const db = await openDatabase();

  try {
    console.log("Attempting to add NEW hypercite with book:", book);
    console.log("NEW Hypercite ID:", hyperciteId);
    if (!book || !hyperciteId) {
      throw new Error(
        "Missing key properties: book or hyperciteId is undefined.",
      );
    }

    const tx = db.transaction(["hypercites", "nodeChunks"], "readwrite");
    const hypercitesStore = tx.objectStore("hypercites");

    // Locate the created <u> node in the DOM by hyperciteId.
    const uElement = document.getElementById(hyperciteId);
    if (!uElement) {
      throw new Error("Hypercite element not found in DOM.");
    }

    // Remove <u> tag wrappers to get clean inner HTML
    const tempDiv = document.createElement("div");
    const clonedU = uElement.cloneNode(true);
    tempDiv.appendChild(clonedU);
    const uTags = tempDiv.querySelectorAll("u");
    uTags.forEach((uTag) => {
      const textNode = document.createTextNode(uTag.textContent);
      uTag.parentNode.replaceChild(textNode, uTag);
    });

    // --- Define hypercitedHTML and hypercitedText AFTER extracting from DOM ---
    const hypercitedHTML = tempDiv.innerHTML;
    const hypercitedText = uElement.textContent;
    const overallStartChar = blocks.length > 0 ? blocks[0].charStart : 0;
    const overallEndChar =
      blocks.length > 0 ? blocks[blocks.length - 1].charEnd : 0;

    // Build the initial hypercite record for the main hypercites store
    const hyperciteEntry = {
      book: book,
      hyperciteId: hyperciteId,
      hypercitedText: hypercitedText,
      hypercitedHTML: hypercitedHTML,
      startChar: overallStartChar,
      endChar: overallEndChar,
      relationshipStatus: "single",
      citedIN: [],
      time_since: Math.floor(Date.now() / 1000) // Add timestamp like hyperlights
    };

    console.log("Hypercite record to add (main store):", hyperciteEntry);

    const putRequestHypercites = hypercitesStore.put(hyperciteEntry);
    putRequestHypercites.onerror = (event) => {
      console.error(
        "❌ Error upserting hypercite record in main store:",
        event.target.error,
      );
    };
    putRequestHypercites.onsuccess = () => {
      console.log("✅ Successfully upserted hypercite record in main store.");
    };

    // --- Update nodeChunks for each affected block ---
    const nodeChunksStore = tx.objectStore("nodeChunks");
    const updatedNodeChunks = []; // 👈 Array to collect updated node chunks

    for (const block of blocks) {
      // ... (your existing, correct logic for updating nodeChunks)
      // This loop populates the `updatedNodeChunks` array.
      // No changes are needed inside this loop.
      console.log("Processing block for NEW hypercite:", block);
      if (block.startLine === undefined || block.startLine === null) {
        console.error("Block missing startLine:", block);
        continue;
      }

      const numericStartLine = parseNodeId(block.startLine);
      const key = createNodeChunksKey(book, block.startLine);
      console.log("Looking up nodeChunk for NEW hypercite with key:", key);

      const getRequest = nodeChunksStore.get(key);

      const nodeChunkRecord = await new Promise((resolve, reject) => {
        getRequest.onsuccess = (e) => resolve(e.target.result);
        getRequest.onerror = (e) => reject(e.target.error);
      });

      let updatedNodeChunkRecord;

      if (nodeChunkRecord) {
        console.log(
          "Existing nodeChunk record found:",
          JSON.stringify(nodeChunkRecord),
        );

        if (!Array.isArray(nodeChunkRecord.hypercites)) {
          nodeChunkRecord.hypercites = [];
          console.log(
            "⚠️ Created empty hypercites array in existing nodeChunk",
          );
        }

        const existingHyperciteIndex = nodeChunkRecord.hypercites.findIndex(
          (hc) => hc.hyperciteId === hyperciteId,
        );

        if (existingHyperciteIndex !== -1) {
          console.log(
            `Hypercite ${hyperciteId} already exists in nodeChunk, updating position.`,
          );
          nodeChunkRecord.hypercites[existingHyperciteIndex].charStart =
            block.charStart;
          nodeChunkRecord.hypercites[existingHyperciteIndex].charEnd =
            block.charEnd;
        } else {
          console.log(
            `Adding new hypercite ${hyperciteId} to existing nodeChunk.`,
          );
          nodeChunkRecord.hypercites.push({
            hyperciteId: hyperciteId,
            charStart: block.charStart,
            charEnd: block.charEnd,
            relationshipStatus: "single",
            citedIN: [],
            time_since: Math.floor(Date.now() / 1000)
          });
        }

        updatedNodeChunkRecord = nodeChunkRecord;
      } else {
        console.log(
          "No existing nodeChunk record, creating new one with startLine:",
          numericStartLine,
        );

        // ✅ Extract node_id from DOM element if available
        const blockElement = document.getElementById(block.nodeId);
        const nodeIdFromDOM = blockElement?.getAttribute('data-node-id');

        updatedNodeChunkRecord = {
          book: book,
          startLine: numericStartLine,
          chunk_id: numericStartLine,
          node_id: nodeIdFromDOM || null, // ✅ ADD node_id field
          hypercites: [
            {
              hyperciteId: hyperciteId,
              charStart: block.charStart,
              charEnd: block.charEnd,
              relationshipStatus: "single",
              citedIN: [],
              time_since: Math.floor(Date.now() / 1000)
            },
          ],
        };
      }

      console.log(
        "NodeChunk record to put:",
        JSON.stringify(updatedNodeChunkRecord),
      );

      console.log(
        "About to save nodeChunk with hypercites:",
        JSON.stringify(updatedNodeChunkRecord.hypercites, null, 2),
      );
      updatedNodeChunks.push(updatedNodeChunkRecord);

      const putRequestNodeChunk = nodeChunksStore.put(updatedNodeChunkRecord);
      await new Promise((resolve, reject) => {
        putRequestNodeChunk.onsuccess = () => {
          console.log(
            `✅ Updated nodeChunk [${book}, ${block.startLine}] with NEW hypercite info.`,
          );

          const verifyRequest = nodeChunksStore.get(
            createNodeChunksKey(book, block.startLine),
          );
          verifyRequest.onsuccess = () => {
            console.log(
              "🔍 IMMEDIATELY AFTER SAVE - What was actually stored:",
              JSON.stringify(verifyRequest.result.hypercites, null, 2),
            );
          };

          resolve();
        };
        putRequestNodeChunk.onerror = (e) => {
          console.error("❌ Error updating nodeChunk:", e.target.error);
          reject(e.target.error);
        };
      });
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });

    console.log("✅ NEW Hypercite and affected nodeChunks updated.");

    // --- START: SOLUTION ---

    // 1. Queue all necessary updates. The `updateBookTimestamp` function
    //    also uses `queueForSync` internally.
    await updateBookTimestamp(book);
    queueForSync("hypercites", hyperciteId, "update", hyperciteEntry);
    updatedNodeChunks.forEach((chunk) => {
      queueForSync("nodeChunks", chunk.startLine, "update", chunk);
    });

    // 2. Immediately flush the sync queue to the server. This bypasses the
    //    3-second debounce delay, solving the race condition for cross-device pasting.
    console.log("⚡ Flushing sync queue immediately for new hypercite...");
    await debouncedMasterSync.flush();
    console.log("✅ Sync queue flushed.");

    // --- END: SOLUTION ---
  } catch (error) {
    console.error("❌ Error in NewHyperciteIndexedDB:", error);
  }
}



/**
 * Modify collectHyperciteData so that it returns an array of "block" objects.
 * Each block object contains:
 *   - startLine: the parent's numeric id (as a number)
 *   - charStart: the start character offset (computed from parent's innerText)
 *   - charEnd: the ending character offset
 *   - html: the parent's outer HTML
 *   - hypercite_id: the hypercite id (for reference)
 */
function collectHyperciteData(hyperciteId, wrapper) {
  console.log("Wrapper outerHTML:", wrapper.outerHTML);

  // Find nearest parent with a numeric id.
  const parentElement = findParentWithNumericalId(wrapper);
  if (!parentElement) {
    console.error(
      "No valid parent element with a numerical ID found for the <u> tag:",
      wrapper.outerHTML
    );
    return [];
  }

  const parentId = parentElement.id; // Keep as string here
  const parentText = parentElement.innerText;

  // The hypercited text is the text of our <u> element.
  const hyperciteText = wrapper.innerText;
  let charStart = parentText.indexOf(hyperciteText);
  if (charStart === -1) {
    console.warn(
      "Could not determine the start position of hypercited text in the parent.",
      parentText,
      hyperciteText
    );
    charStart = 0;
  }
  const charEnd = charStart + hyperciteText.length;

  // Don't store the entire outerHTML, just the necessary information
  return [
    {
      startLine: parentId,
      charStart: charStart,
      charEnd: charEnd,
      // Don't include the full HTML, just the ID and type
      elementType: parentElement.tagName.toLowerCase(),
      hyperciteId: hyperciteId,
      id: parentElement.id,
    },
  ];
}



// Function to generate a unique hypercite ID
function generateHyperciteID() {
  return "hypercite_" + Math.random().toString(36).substring(2, 9); // Unique ID generation
}

// Fallback copy function: Standard copy if HTML format isn't supported
function fallbackCopyText(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand("copy"); // Fallback copy for plain text
  } catch (err) {
    console.error("Fallback: Unable to copy text", err);
  }
  document.body.removeChild(textArea);
}


// Strictly match only “digits” or “digits.digits”
function findParentWithNumericalId(element) {
  let current = element;
  while (current) {
    const id = current.getAttribute("id");
    if (id && /^\d+(?:\.\d+)?$/.test(id)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}




// Function to get hypercite data from IndexedDB
async function getHyperciteData(book, startLine) {
  try {
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readonly");
    const store = tx.objectStore("nodeChunks");
    
    // Create the proper key for lookup
    const key = createNodeChunksKey(book, startLine);
    console.log("Looking up hypercite data with key:", key);
    
    // Use the composite key [book, numericStartLine]
    const request = store.get(key);
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error("Error retrieving hypercite data"));
      };
    });
  } catch (error) {
    console.error("Error accessing IndexedDB:", error);
    throw error;
  }
}


// Assume getHyperciteData and book are imported from elsewhere, as in the original

/**
 * Function to handle the click on <u class="couple"> tags.
 * @param {HTMLElement} uElement - The <u class="couple"> element that was clicked.
 */
async function CoupleClick(uElement) {
  console.log("u.couple element clicked:", uElement);

  const parent = uElement.parentElement;
  if (!parent || !parent.id) {
    console.error("Parent element not found or missing id.", uElement);
    return;
  }
  console.log("Parent element found:", parent);

  const startLine = parent.id;
  const bookId = book || "latest";

  try {
    const nodeChunk = await getHyperciteData(bookId, startLine);
    if (!nodeChunk) {
      console.error(
        `No nodeChunk found for book: ${bookId}, startLine: ${startLine}`
      );
      return;
    }
    console.log("Retrieved nodeChunk:", nodeChunk);

    const clickedHyperciteId = uElement.id;
    let link = null;

    if (nodeChunk.hypercites && nodeChunk.hypercites.length > 0) {
      const matchingHypercite = nodeChunk.hypercites.find(
        (hyper) => hyper.hyperciteId === clickedHyperciteId
      );

      if (
        matchingHypercite &&
        matchingHypercite.citedIN &&
        matchingHypercite.citedIN.length > 0
      ) {
        link = matchingHypercite.citedIN[0];
      }
    }

    if (link) {
      // If the link is relative, prepend the base URL
      if (link.startsWith("/")) {
        link = window.location.origin + link;
      }
      console.log("Opening link:", link);

      // Check if this is a same-book highlight link
      const url = new URL(link, window.location.origin);
      if (url.origin === window.location.origin) {
        const [bookSegment, hlSegment] = url.pathname.split("/").filter(Boolean);
        const currentBook = window.location.pathname.split("/").filter(Boolean)[0];
        const hlMatch = hlSegment && hlSegment.match(/^HL_(.+)$/);
        
        if (bookSegment === currentBook && hlMatch) {
          console.log("✅ Same-book highlight link detected in hypercite");
          
          const highlightId = hlMatch[0]; // "HL_1749896203081"
          const internalId = url.hash ? url.hash.slice(1) : null;
          
          // URL updates now handled by LinkNavigationHandler - no duplicate pushState calls
          
          // 🚀 NEW: Use proper sequential navigation with DOM readiness
          await navigateToHyperciteTarget(highlightId, internalId, currentLazyLoader);
          
          return; // Don't do normal navigation
        }

        if (bookSegment === currentBook) {
          console.log("✅ Same-book internal link detected");
          const internalId = url.hash ? url.hash.slice(1) : null;
          
          if (internalId) {
            // URL updates now handled by LinkNavigationHandler - no duplicate pushState calls
            navigateToInternalId(internalId, currentLazyLoader, false); // Don't show overlay - internal navigation
            return;
          }
        }
      }
      
      // If not a same-book highlight, do normal navigation
      // Show overlay for external navigation
      showNavigationLoading(clickedHyperciteId);
      window.location.href = link;
      
    } else {
      console.error(
        "No citedIN link found for clicked hyperciteId:",
        clickedHyperciteId,
        nodeChunk
      );
    }
  } catch (error) {
    console.error("Failed to retrieve hypercite data:", error);
  }
}

/**
 * Function to handle clicks on underlined elements based on their class
 * @param {HTMLElement} uElement - The underlined element that was clicked
 * @param {Event} event - The click event
 */
async function handleUnderlineClick(uElement, event) {
  console.log("🔥 handleUnderlineClick called with element:", uElement.id || uElement.tagName);
  
  // Check if this is an overlapping hypercite
  if (uElement.id === "hypercite_overlapping") {
    await handleOverlappingHyperciteClick(uElement, event);
    return;
  }

  // Use unified container system for all hypercite clicks
  console.log("🔄 Calling handleUnifiedContentClick from hyperCites.js");
  await handleUnifiedContentClick(uElement);
}

/**
 * Function to handle clicks on overlapping hypercites
 * @param {HTMLElement} uElement - The overlapping hypercite element
 * @param {Event} event - The click event
 */
async function handleOverlappingHyperciteClick(uElement, event) {
  console.log("Overlapping hypercite clicked:", uElement);

  // Update URL for back button support - use the first hypercite ID
  const overlappingData = uElement.getAttribute("data-overlapping");
  if (!overlappingData) {
    console.error("❌ No data-overlapping attribute found");
    return;
  }

  const hyperciteIds = overlappingData.split(",").map(id => id.trim());
  console.log("Overlapping hypercite IDs:", hyperciteIds);

  // Add URL update for back button functionality
  if (hyperciteIds.length > 0) {
    const firstHyperciteId = hyperciteIds[0].replace('hypercite_', '');
    const newUrl = `${window.location.pathname}${window.location.search}#hypercite_${firstHyperciteId}`;
    console.log(`📍 Updating URL for overlapping hypercite navigation: ${newUrl}`);
    
    try {
      // Preserve existing state when updating URL for overlapping hypercite
      const currentState = history.state || {};
      const newState = { ...currentState, overlapping_hypercite: { hyperciteIds: hyperciteIds } };
      history.pushState(newState, '', newUrl);
      console.log(`📊 Added overlapping hypercite to history - length: ${window.history.length}`);
    } catch (error) {
      console.warn('Failed to update URL for overlapping hypercite:', error);
    }
  }

  // Check for specific classes instead of exact className match
  console.log(`🔍 Checking classes on element:`, {
    className: uElement.className,
    classList: Array.from(uElement.classList),
    hasCouple: uElement.classList.contains("couple"),
    hasPoly: uElement.classList.contains("poly")
  });
  
  if (uElement.classList.contains("couple")) {
    console.log("📝 Handling overlapping couple");
    await handleOverlappingCouple(hyperciteIds);
  } else if (uElement.classList.contains("poly")) {
    console.log("📝 Handling overlapping poly");
    await handleOverlappingPoly(hyperciteIds, event);
  } else {
    console.log("❌ Overlapping hypercite with unrecognized classes - no action taken");
  }
}

/**
 * Handle overlapping hypercites with couple class
 * @param {Array} hyperciteIds - Array of overlapping hypercite IDs
 */
async function handleOverlappingCouple(hyperciteIds) {
  try {
    const db = await openDatabase();
    
    // Look up all hypercites to find which one has couple status
    const hypercitePromises = hyperciteIds.map(id => getHyperciteById(db, id));
    const hypercites = await Promise.all(hypercitePromises);
    
    // Find the hypercite with couple relationship status
    const coupleHypercite = hypercites.find(hc => 
      hc && hc.relationshipStatus === "couple"
    );
    
    if (!coupleHypercite) {
      console.error("❌ No hypercite with couple status found in overlapping set");
      return;
    }
    
    console.log("Found couple hypercite:", coupleHypercite);
    
    // Get the citedIN link (should be exactly one for couple status)
    if (coupleHypercite.citedIN && coupleHypercite.citedIN.length > 0) {
      const link = coupleHypercite.citedIN[0];
      await navigateToHyperciteLink(link);
    } else {
      console.error("❌ No citedIN link found for couple hypercite:", coupleHypercite.hyperciteId);
    }
    
  } catch (error) {
    console.error("❌ Error handling overlapping couple:", error);
  }
}

/**
 * Handle overlapping hypercites with poly class
 * @param {Array} hyperciteIds - Array of overlapping hypercite IDs
 * @param {Event} event - The click event
 */
async function handleOverlappingPoly(hyperciteIds, event) {
  try {
    const db = await openDatabase();
    
    // Look up all hypercites
    const hypercitePromises = hyperciteIds.map(id => getHyperciteById(db, id));
    const hypercites = await Promise.all(hypercitePromises);
    
    // Filter out null results and collect all citedIN links
    const validHypercites = hypercites.filter(hc => hc !== null);
    const allCitedINLinks = [];
    
    validHypercites.forEach(hypercite => {
      if (hypercite.citedIN && Array.isArray(hypercite.citedIN)) {
        allCitedINLinks.push(...hypercite.citedIN);
      }
    });
    
    console.log("All citedIN links from overlapping hypercites:", allCitedINLinks);
    
    if (allCitedINLinks.length === 0) {
      console.error("❌ No citedIN links found in any overlapping hypercites");
      return;
    }
    
    // Create the poly container content with all links
    await createOverlappingPolyContainer(allCitedINLinks, validHypercites);
    
  } catch (error) {
    console.error("❌ Error handling overlapping poly:", error);
  }
}

/**
 * Navigate to hypercite targets with proper sequencing and DOM readiness
 * @param {string} highlightId - The highlight ID to navigate to first
 * @param {string} internalId - Optional internal ID to navigate to after highlight
 * @param {Object} lazyLoader - The lazy loader instance
 */
export async function navigateToHyperciteTarget(highlightId, internalId, lazyLoader, showOverlay = false) {
  try {
    console.log(`🎯 Starting hypercite navigation to highlight: ${highlightId}, internal: ${internalId}`);
    
    // 🚀 FIX: Clear any conflicting saved scroll positions to prevent interference
    const scrollKey = getLocalStorageKey("scrollPosition", lazyLoader.bookId);
    console.log(`🧹 Clearing saved scroll positions to prevent navigation interference`);
    sessionStorage.removeItem(scrollKey);
    // Keep localStorage for when user refreshes page, but clear session storage
    // so it doesn't override our explicit navigation
    
    if (internalId) {
      // Sequential navigation: highlight first, then internal ID
      console.log(`📍 Step 1: Navigating to highlight ${highlightId}`);
      navigateToInternalId(highlightId, lazyLoader, showOverlay);
      
      // Wait for the highlight to be ready before proceeding
      await waitForElementReady(highlightId, {
        maxAttempts: 40, // 2 seconds max wait
        checkInterval: 50,
        container: lazyLoader.container
      });
      
      console.log(`✅ Highlight ${highlightId} ready, now navigating to internal ID ${internalId}`);
      
      // Small delay to let highlight open animation start
      setTimeout(() => {
        // Check if hypercite exists inside the opened hyperlit container
        const hyperciteInContainer = document.querySelector(`#hyperlit-container #${internalId}`);
        if (hyperciteInContainer) {
          console.log(`🎯 Found hypercite ${internalId} inside hyperlit container, scrolling within container`);
          // Scroll within the hyperlit container
          const container = document.getElementById('hyperlit-container');
          const scroller = container.querySelector('.scroller');
          if (scroller) {
            hyperciteInContainer.scrollIntoView({ 
              behavior: 'smooth', 
              block: 'center',
              inline: 'nearest'
            });
            // Highlight the hypercite
            highlightTargetHypercite(internalId, 500);
          }
        } else {
          console.log(`🎯 Hypercite ${internalId} not found in container, using standard navigation`);
          // Fall back to standard navigation (though this shouldn't happen for hypercites in highlights)
          navigateToInternalId(internalId, lazyLoader, showOverlay);
        }
      }, 300);
      
    } else {
      // Just navigate to the highlight
      console.log(`📍 Navigating directly to highlight ${highlightId}`);
      navigateToInternalId(highlightId, lazyLoader, showOverlay);
    }
    
  } catch (error) {
    console.error(`❌ Error in hypercite navigation:`, error);
    // Fallback to original method if our improved method fails
    if (internalId) {
      navigateToInternalId(highlightId, lazyLoader);
      setTimeout(() => {
        navigateToInternalId(internalId, lazyLoader);
      }, 1000);
    } else {
      navigateToInternalId(highlightId, lazyLoader);
    }
  }
}

/**
 * Navigate to a hypercite link (extracted from CoupleClick logic)
 * @param {string} link - The link to navigate to
 */
async function navigateToHyperciteLink(link) {
  // If the link is relative, prepend the base URL
  if (link.startsWith("/")) {
    link = window.location.origin + link;
  }
  console.log("Opening link:", link);

  // Check if this is a same-book highlight link
  const url = new URL(link, window.location.origin);
  if (url.origin === window.location.origin) {
    const [bookSegment, hlSegment] = url.pathname.split("/").filter(Boolean);
    const currentBook = window.location.pathname.split("/").filter(Boolean)[0];
    const hlMatch = hlSegment && hlSegment.match(/^HL_(.+)$/);
    
    if (bookSegment === currentBook && hlMatch) {
      console.log("✅ Same-book highlight link detected in hypercite");
      
      const highlightId = hlMatch[0]; // "HL_1749896203081"
      const internalId = url.hash ? url.hash.slice(1) : null;
      
      // URL updates now handled by LinkNavigationHandler - no duplicate pushState calls
      
      // 🚀 NEW: Use proper sequential navigation with DOM readiness
      await navigateToHyperciteTarget(highlightId, internalId, currentLazyLoader);
      
      return; // Don't do normal navigation
    }

    if (bookSegment === currentBook) {
      console.log("✅ Same-book internal link detected");
      const internalId = url.hash ? url.hash.slice(1) : null;
      
      if (internalId) {
        // URL updates now handled by LinkNavigationHandler - no duplicate pushState calls

        navigateToInternalId(internalId, currentLazyLoader, false); // Don't show overlay - internal navigation
        return;
      }
    }
  }
  
  // If not a same-book highlight, do normal navigation
  // Show overlay for external navigation
  showNavigationLoading("hypercite_link");
  window.location.href = link;
}

/**
 * Create and open the poly container for overlapping hypercites
 * @param {Array} allCitedINLinks - All citedIN links from overlapping hypercites
 * @param {Array} validHypercites - All valid hypercite objects
 */
async function createOverlappingPolyContainer(allCitedINLinks, validHypercites) {
  const db = await openDatabase();

  // Remove duplicates from citedIN links
  const uniqueLinks = [...new Set(allCitedINLinks)];

  // Extract all overlapping hypercite IDs and the source book
  const overlappingHyperciteIds = validHypercites.map(hc => hc.hyperciteId);
  const sourceBook = validHypercites.length > 0 ? validHypercites[0].book : book;

  // Generate HTML for all links (reusing logic from PolyClick)
  const linksHTML = (
    await Promise.all(
      uniqueLinks.map(async (citationID) => {
        // Extract the book/citation ID from the URL with improved handling
        let bookID;
        const citationParts = citationID.split("#");
        const urlPart = citationParts[0];

        // Check if this is a hyperlight URL (contains /HL_)
        const isHyperlightURL = urlPart.includes("/HL_");

        if (isHyperlightURL) {
          // For URLs like "/nicholls2019moment/HL_1747630135510#hypercite_5k2bmvr6"
          // Extract the book ID from the path before the /HL_ part
          const pathParts = urlPart.split("/");
          // Find the part before the HL_ segment
          for (let i = 0; i < pathParts.length; i++) {
            if (pathParts[i].startsWith("HL_") && i > 0) {
              bookID = pathParts[i-1];
              break;
            }
          }

          // If we couldn't find it with the above method, fall back to taking the first non-empty path segment
          if (!bookID) {
            bookID = pathParts.filter(part => part && !part.startsWith("HL_"))[0] || "";
          }
        } else {
          // Original simple case: url.com/book#id
          bookID = urlPart.replace("/", "");
        }

        // Check if this is a simple hypercite and user owns the CITING book
        const isSimpleHypercite = !isHyperlightURL && citationParts.length > 1;
        let managementButtonsHtml = '';

        if (isSimpleHypercite) {
          const hyperciteIdFromUrl = citationParts[1]; // Extract hypercite_xxx

          // Check if user can edit the CITING book (from href/citedIN)
          const canEdit = await canUserEditBook(bookID);

          if (canEdit) {
            // For overlapping hypercites, pass all overlapping IDs (comma-separated)
            managementButtonsHtml = `
      <span class="hypercite-management-buttons">
        <button class="hypercite-health-check-btn"
                data-citing-book="${bookID}"
                data-hypercite-id="${hyperciteIdFromUrl}"
                title="Check if citation exists"
                type="button">
          <svg width="18" height="18" viewBox="0 0 48 48" fill="currentColor">
            <path d="M12 10C13.1046 10 14 9.10457 14 8C14 6.89543 13.1046 6 12 6C11.2597 6 10.6134 6.4022 10.2676 7H10C8.34315 7 7 8.34315 7 10V19C6.44774 19 5.99531 19.4487 6.04543 19.9987C6.27792 22.5499 7.39568 24.952 9.22186 26.7782C10.561 28.1173 12.2098 29.0755 14 29.583V32C14 33.3064 14.835 34.4177 16.0004 34.8294C16.043 38.7969 19.2725 42 23.25 42C27.2541 42 30.5 38.7541 30.5 34.75V30.75C30.5 28.6789 32.1789 27 34.25 27C36.3211 27 38 28.6789 38 30.75V33.1707C36.8348 33.5825 36 34.6938 36 36C36 37.6569 37.3431 39 39 39C40.6569 39 42 37.6569 42 36C42 34.6938 41.1652 33.5825 40 33.1707V30.75C40 27.5744 37.4256 25 34.25 25C31.0744 25 28.5 27.5744 28.5 30.75V34.75C28.5 37.6495 26.1495 40 23.25 40C20.3769 40 18.0429 37.6921 18.0006 34.8291C19.1655 34.4171 20 33.306 20 32V29.583C21.7902 29.0755 23.4391 28.1173 24.7782 26.7782C26.6044 24.952 27.7221 22.5499 27.9546 19.9987C28.0048 19.4487 27.5523 19 27 19L27 10C27 8.34315 25.6569 7 24 7H23.7324C23.3866 6.4022 22.7403 6 22 6C20.8954 6 20 6.89543 20 8C20 9.10457 20.8954 10 22 10C22.7403 10 23.3866 9.5978 23.7324 9H24C24.5523 9 25 9.44772 25 10V19H25.2095C24.6572 19 24.2166 19.4499 24.1403 19.9969C23.9248 21.5406 23.2127 22.983 22.0979 24.0979C20.7458 25.4499 18.9121 26.2095 17 26.2095C15.088 26.2095 13.2542 25.4499 11.9022 24.0979C10.7873 22.983 10.0753 21.5406 9.8598 19.9969C9.78344 19.4499 9.34286 19 8.79057 19L9 19V10C9 9.44772 9.44772 9 10 9H10.2676C10.6134 9.5978 11.2597 10 12 10Z"/>
          </svg>
        </button>
        <button class="hypercite-delete-btn"
                data-source-book="${sourceBook}"
                data-source-hypercite-id="${overlappingHyperciteIds.join(',')}"
                title="Run health check first"
                type="button"
                disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18" stroke-linecap="round" stroke-linejoin="round"></path>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </button>
      </span>
    `;
          }
        }

        // Check if the book exists in the library object store
        const libraryTx = db.transaction("library", "readonly");
        const libraryStore = libraryTx.objectStore("library");
        const libraryRequest = libraryStore.get(bookID);

        return new Promise((resolve) => {
          libraryRequest.onsuccess = async () => {
            const libraryData = libraryRequest.result;

            if (libraryData && libraryData.bibtex) {
              // Format the BibTeX data into an academic citation
              const formattedCitation = await formatBibtexToCitation(libraryData.bibtex);

              // Customize the citation display based on URL type
              const citationText = isHyperlightURL
                ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}`
                : formattedCitation;

              // Return the formatted citation with the clickable link
              resolve(
                `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a>${managementButtonsHtml}</blockquote>`
              );
            } else {
              // Fallback: try to fetch from server
              fetchLibraryFromServer(bookID).then(async (serverLibraryData) => {
                if (serverLibraryData && serverLibraryData.bibtex) {
                  const formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
                  const citationText = isHyperlightURL
                    ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}`
                    : formattedCitation;

                  resolve(
                    `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a>${managementButtonsHtml}</blockquote>`
                  );
                } else {
                  resolve(`<a href="${citationID}" class="citation-link">${citationID}${managementButtonsHtml}</a>`);
                }
              });
            }
          };

          libraryRequest.onerror = () => {
            console.error(`❌ Error fetching library data for book ID: ${bookID}`);
            // Fallback: try to fetch from server
            fetchLibraryFromServer(bookID).then(async (serverLibraryData) => {
              if (serverLibraryData && serverLibraryData.bibtex) {
                const formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
                const citationText = isHyperlightURL
                  ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}`
                  : formattedCitation;

                resolve(
                  `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a>${managementButtonsHtml}</blockquote>`
                );
              } else {
                resolve(`<a href="${citationID}" class="citation-link">${citationID}${managementButtonsHtml}</a>`);
              }
            });
          };
        });
      })
    )
  ).join("");

  const containerContent = `
    <div class="scroller">
      <div class="hypercites-section">
        <h1>Cited By</h1>

        <div class="citation-links">
          ${linksHTML}
        </div>
        <hr>
      </div>
    </div>
    <div class="mask-bottom"></div>
    <div class="mask-top"></div>
  `;

  // Open the hypercite container with the generated content
  openHyperciteContainer(containerContent);

  // Attach event listeners for management buttons after container opens
  setTimeout(async () => {
    const healthCheckButtons = document.querySelectorAll('.hypercite-health-check-btn');
    const hyperciteDeleteButtons = document.querySelectorAll('.hypercite-delete-btn');

    if (healthCheckButtons.length > 0 || hyperciteDeleteButtons.length > 0) {
      // Import handlers from unifiedContainer
      const { handleHyperciteHealthCheck, handleHyperciteDelete } = await import('./unifiedContainer.js');

      healthCheckButtons.forEach(button => {
        button.addEventListener('click', handleHyperciteHealthCheck);
      });

      hyperciteDeleteButtons.forEach(button => {
        button.addEventListener('click', handleHyperciteDelete);
      });

      console.log(`🔗 Attached ${healthCheckButtons.length} health check and ${hyperciteDeleteButtons.length} delete button listeners in overlapping container`);
    }
  }, 200);
}


/**
 * Function to attach click listeners to underlined citations
 */
export function attachUnderlineClickListeners(scope = document) {
  // Select all underlined elements that don't have a listener attached yet
  const uElements = scope.querySelectorAll("u.couple:not([data-hypercite-listener]), u.poly:not([data-hypercite-listener])");
  
  if (uElements.length > 0) {
    console.log(
      `attachUnderlineClickListeners: Found ${uElements.length} new underlined elements to attach listeners to.`
    );

    uElements.forEach((uElement) => {
      uElement.style.cursor = "pointer";
      uElement.dataset.hyperciteListener = "true"; // Mark as processed

      uElement.addEventListener("click", async (event) => {
        await handleUnderlineClick(uElement, event);
      });
    });
  }

  // Only scan for annotation links when doing a full-document scan, not on a per-chunk basis.
  if (scope === document) {
    attachHyperciteLinkListeners();
  }
}

/**
 * Function to attach click listeners to hypercite links in contenteditable areas
 */
function attachHyperciteLinkListeners() {
  // Select all hypercite links with open-icon class within hyperlit-container
  const hyperciteLinks = document.querySelectorAll('#hyperlit-container a[id^="hypercite_"] sup.open-icon, #hyperlit-container a[id^="hypercite_"] span.open-icon');
  
  if (hyperciteLinks.length === 0) return;

  console.log(`Found ${hyperciteLinks.length} hypercite links in hyperlit-container to process.`);

  hyperciteLinks.forEach((linkElement) => {
    const anchorElement = linkElement.parentElement;
    if (!anchorElement || anchorElement.tagName !== 'A') return;

    // Prevent attaching duplicate listeners
    if (anchorElement.dataset.hyperciteLinkListener) {
      return;
    }
    anchorElement.dataset.hyperciteLinkListener = 'true';

    anchorElement.style.cursor = "pointer";
    linkElement.style.cursor = "pointer";

    const clickHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      
      const href = anchorElement.getAttribute('href');
      if (href) {
        console.log(`Hypercite link clicked in annotation: ${href}`);
        window.open(href, '_blank');
      }
    };

    anchorElement.addEventListener('click', clickHandler);
  });
}


export async function PolyClick(event) {
  // Prevent default click action if needed
  event.preventDefault();

  // Get hyperciteId from the clicked element
  const hyperciteId = event.target.id;

  if (!hyperciteId) {
    console.error("❌ Could not determine hypercite ID.");
    return;
  }

  console.log(`u.poly clicked: ${hyperciteId}`);

  try {
    const db = await openDatabase();
    const tx = db.transaction("hypercites", "readonly");
    const store = tx.objectStore("hypercites");
    const index = store.index("hyperciteId");

    const getRequest = index.get(hyperciteId);

    getRequest.onsuccess = async () => {
      const hyperciteData = getRequest.result;
      console.log("Found hypercite data:", hyperciteData);

      if (!hyperciteData) {
        console.error("❌ No hypercite data found for ID:", hyperciteId);
        return;
      }

      // If your hyperciteData contains a citedIN array, we build the container's content based on that.
      let linksHTML = "";
      if (Array.isArray(hyperciteData.citedIN) && hyperciteData.citedIN.length > 0) {
        linksHTML = (
          await Promise.all(
            hyperciteData.citedIN.map(async (citationID) => {
              // Extract the book/citation ID from the URL with improved handling
              let bookID;
              const citationParts = citationID.split("#");
              const urlPart = citationParts[0];
              
              // Check if this is a hyperlight URL (contains /HL_)
              const isHyperlightURL = urlPart.includes("/HL_");
              
              if (isHyperlightURL) {
                // For URLs like "/nicholls2019moment/HL_1747630135510#hypercite_5k2bmvr6"
                // Extract the book ID from the path before the /HL_ part
                const pathParts = urlPart.split("/");
                // Find the part before the HL_ segment
                for (let i = 0; i < pathParts.length; i++) {
                  if (pathParts[i].startsWith("HL_") && i > 0) {
                    bookID = pathParts[i-1];
                    break;
                  }
                }
                
                // If we couldn't find it with the above method, fall back to taking the first non-empty path segment
                if (!bookID) {
                  bookID = pathParts.filter(part => part && !part.startsWith("HL_"))[0] || "";
                }
              } else {
                // Original simple case: url.com/book#id
                bookID = urlPart.replace("/", "");
              }

              // Check if the book exists in the library object store
              const libraryTx = db.transaction("library", "readonly");
              const libraryStore = libraryTx.objectStore("library");
              const libraryRequest = libraryStore.get(bookID);

              return new Promise((resolve) => {
                libraryRequest.onsuccess = async () => {
                  const libraryData = libraryRequest.result;

                  if (libraryData && libraryData.bibtex) {
                    // Format the BibTeX data into an academic citation
                    const formattedCitation = await formatBibtexToCitation(libraryData.bibtex);
                    
                    // Customize the citation display based on URL type
                    const citationText = isHyperlightURL 
                      ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}` 
                      : formattedCitation;

                    // Return the formatted citation with the clickable link
                    resolve(
                      `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></blockquote>`
                    );
                  } else {
                    // Fallback: try to fetch from server
                    fetchLibraryFromServer(bookID).then(async (serverLibraryData) => {
                      if (serverLibraryData && serverLibraryData.bibtex) {
                        const formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
                        const citationText = isHyperlightURL 
                          ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}` 
                          : formattedCitation;

                        resolve(
                          `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></blockquote>`
                        );
                      } else {
                        resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
                      }
                    });
                  }
                };

                libraryRequest.onerror = () => {
                  console.error(`❌ Error fetching library data for book ID: ${bookID}`);
                  // Fallback: try to fetch from server
                  fetchLibraryFromServer(bookID).then(async (serverLibraryData) => {
                    if (serverLibraryData && serverLibraryData.bibtex) {
                      const formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
                      const citationText = isHyperlightURL 
                        ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}` 
                        : formattedCitation;

                      resolve(
                        `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></blockquote>`
                      );
                    } else {
                      resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
                    }
                  });
                };
              });
            })
          )
        ).join("");  // ← join with the empty string
      } else {
        linksHTML = "<p>No citations available.</p>";
      }

      const containerContent = `
        <div class="scroller">
          <h1> Cited By: </h1>
          <p></p>
          <div class="citation-links">
            ${linksHTML}
          </div>
        </div>
        <div class="mask-bottom"></div>
        <div class="mask-top"></div>
      `;

      // Open the hypercite container with the generated content
      openHyperciteContainer(containerContent);

      // Double-check that the container exists and has content
      const hyperciteContainer =
        document.getElementById("hypercite-container");
      if (!hyperciteContainer) {
        console.error("❌ Hypercite container element not found in DOM");
        return;
      }
      console.log("Container state:", {
        exists: !!hyperciteContainer,
        content: hyperciteContainer.innerHTML,
        isVisible: hyperciteContainer.classList.contains("open"),
      });
    };

    getRequest.onerror = (event) => {
      console.error("❌ Error fetching hypercite data:", event.target.error);
    };
    
  } catch (error) {
    console.error("❌ Error accessing IndexedDB:", error);
  }
}




// Assume ContainerManager, openDatabase, and other helper functions are imported


let activeHyperciteListeners = null;

// This new function will be called by viewInitializers.js
export function initializeHypercitingControls(currentBookId) {
  console.log(
    `🔗 Initializing hyperciting controls for book: ${currentBookId}`
  );

  const copyButton = document.getElementById("copy-hypercite");
  if (!copyButton) {
    console.error(
      "Hyperciting UI controls not found. Aborting initialization."
    );
    return;
  }

  // --- START: CRITICAL FIX ---

  // 1. If there are old listeners, remove them first to prevent stacking
  if (activeHyperciteListeners) {
    copyButton.removeEventListener(
      "mousedown",
      activeHyperciteListeners.mousedown
    );
    copyButton.removeEventListener("click", activeHyperciteListeners.click);
    copyButton.removeEventListener(
      "touchend",
      activeHyperciteListeners.touchend
    );
    console.log("🧹 Cleaned up old hypercite listeners.");
  }

  // 2. Define the new set of listeners
  const mousedownListener = (e) => {
    // This is ESSENTIAL to prevent the button from stealing focus and
    // clearing the user's text selection.
    e.preventDefault();
  };

  const eventHandler = (event) => {
    handleCopyEvent(event, currentBookId);
  };

  // 3. Store the new listeners so we can remove them later
  activeHyperciteListeners = {
    mousedown: mousedownListener,
    click: eventHandler,
    touchend: eventHandler,
  };

  // 4. Add the new, robust listeners
  copyButton.addEventListener("mousedown", activeHyperciteListeners.mousedown);
  copyButton.addEventListener("click", activeHyperciteListeners.click, {
    passive: false,
  });
  copyButton.addEventListener("touchend", activeHyperciteListeners.touchend, {
    passive: false,
  });

  // --- END: CRITICAL FIX ---

  // Ensure button is optimized for mobile
  copyButton.style.touchAction = "manipulation";
  copyButton.style.userSelect = "none";

  // Re-initialize the ContainerManager for the pop-up
  // You had this logic separated, but it's good to keep it with the controls
  // that use it.
  initializeHyperciteContainerManager();

  console.log("✅ Hyperciting controls are live and correctly bound.");
}

// Cleanup function to remove hypercite event listeners
export function cleanupHypercitingControls() {
  console.log("🧹 Cleaning up hyperciting controls...");
  
  // Clean up copy button listeners
  const copyButton = document.getElementById("copy-hypercite");
  if (copyButton && activeHyperciteListeners) {
    copyButton.removeEventListener("mousedown", activeHyperciteListeners.mousedown);
    copyButton.removeEventListener("click", activeHyperciteListeners.click);
    copyButton.removeEventListener("touchend", activeHyperciteListeners.touchend);
    activeHyperciteListeners = null;
    console.log("🧹 Removed copy button listeners");
  }
  
  // Clean up underline click listeners
  const hyperciteElements = document.querySelectorAll("u.couple[data-hypercite-listener], u.poly[data-hypercite-listener]");
  hyperciteElements.forEach(element => {
    element.removeAttribute("data-hypercite-listener");
    // Note: We can't remove the specific listener since it's anonymous, but removing the attribute
    // will prevent the "already attached" check from working, allowing fresh listeners
  });
  
  // Clean up hypercite link listeners
  const hyperciteLinks = document.querySelectorAll('#hyperlit-container a[data-hypercite-link-listener]');
  hyperciteLinks.forEach(link => {
    link.removeAttribute("data-hypercite-link-listener");
  });
  
  console.log("✅ Hyperciting controls cleanup completed");
}

// Legacy container functions - redirected to unified system
const initializeHyperciteContainerManager = initializeHyperlitManager;
export const openHyperciteContainer = openHyperlitContainer;
export const closeHyperciteContainer = closeHyperlitContainer;


// Helper: Parse hypercite URL to extract components
export function parseHyperciteHref(href) {
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


// DELETE HYPERCITED QUOTE //

/**
 * Function to delink a hypercite when it's deleted
 * @param {string} hyperciteElementId - The ID of the hypercite element being deleted (e.g., "hypercite_p0pdlbaj")
 * @param {string} hrefUrl - The href URL of the hypercite element
 */
export async function delinkHypercite(hyperciteElementId, hrefUrl) {
  try {
    console.log("🔗 Starting delink process for:", hyperciteElementId);
    console.log("📍 Href URL:", hrefUrl);

    // Step 1: Extract the target hypercite ID from the href
    const targetHyperciteId = extractHyperciteIdFromHref(hrefUrl);
    if (!targetHyperciteId) {
      console.error("❌ Could not extract hypercite ID from href:", hrefUrl);
      return;
    }

    console.log("🎯 Target hypercite ID to delink from:", targetHyperciteId);

    // Step 2: Look up the target hypercite in IndexedDB
    const db = await openDatabase();
    const targetHypercite = await getHyperciteById(db, targetHyperciteId);
    
    if (!targetHypercite) {
      console.error("❌ Target hypercite not found in database:", targetHyperciteId);
      return;
    }

    console.log("📋 Found target hypercite:", targetHypercite);

    // Step 3: Remove the current hypercite from the target's citedIN array
    const originalCitedIN = [...targetHypercite.citedIN];
    const updatedCitedIN = removeCitedINEntry(targetHypercite.citedIN, hyperciteElementId);
    
    if (originalCitedIN.length === updatedCitedIN.length) {
      console.warn("⚠️ No matching citedIN entry found to remove");
      return;
    }

    console.log("✂️ Removed citedIN entry. New array:", updatedCitedIN);

    // Step 4: Update the target hypercite's relationship status
    const newRelationshipStatus = determineRelationshipStatus(updatedCitedIN.length);
    
    // Step 5: Update IndexedDB
    const updatedHypercite = {
      ...targetHypercite,
      citedIN: updatedCitedIN,
      relationshipStatus: newRelationshipStatus
    };

    await updateHyperciteInIndexedDB(db, updatedHypercite);
    console.log("💾 Updated hypercite in IndexedDB");

    // Step 6: Update the DOM element's class if it exists
    updateDOMElementClass(targetHyperciteId, newRelationshipStatus);

    // Step 7: Update the nodeChunk's hypercites array
    // Since hypercite records don't store startLine, we need to search all nodeChunks
    const nodeChunksTx = db.transaction(['nodeChunks'], 'readwrite');
    const nodeChunksStore = nodeChunksTx.objectStore('nodeChunks');
    const bookIndex = nodeChunksStore.index('book');

    // Get all nodeChunks for this book
    const allNodeChunks = await new Promise((resolve, reject) => {
      const request = bookIndex.getAll(targetHypercite.book);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    console.log(`🔍 Searching ${allNodeChunks.length} nodeChunks for hypercite ${targetHyperciteId}`);

    // Find the nodeChunk that contains this hypercite
    let foundNodeChunk = null;
    let foundHyperciteIndex = -1;

    for (const nodeChunk of allNodeChunks) {
      if (nodeChunk.hypercites && Array.isArray(nodeChunk.hypercites)) {
        const index = nodeChunk.hypercites.findIndex(hc => hc.hyperciteId === targetHyperciteId);
        if (index !== -1) {
          foundNodeChunk = nodeChunk;
          foundHyperciteIndex = index;
          console.log(`✅ Found hypercite in nodeChunk at startLine ${nodeChunk.startLine}, index ${index}`);
          break;
        }
      }
    }

    if (foundNodeChunk && foundHyperciteIndex !== -1) {
      // Update the hypercite in the nodeChunk's array
      foundNodeChunk.hypercites[foundHyperciteIndex] = {
        ...foundNodeChunk.hypercites[foundHyperciteIndex],
        citedIN: updatedCitedIN,
        relationshipStatus: newRelationshipStatus
      };

      // Update the nodeChunk in IndexedDB
      const updateRequest = nodeChunksStore.put(foundNodeChunk);
      await new Promise((resolve, reject) => {
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = () => reject(updateRequest.error);
      });

      console.log(`✅ Updated nodeChunk hypercites array for startLine ${foundNodeChunk.startLine}`);

      // Queue the UPDATED nodeChunk for sync to PostgreSQL
      queueForSync(
        "nodeChunks",
        foundNodeChunk.startLine,
        "update",
        foundNodeChunk
      );
    } else {
      console.warn(`⚠️ Hypercite ${targetHyperciteId} not found in any nodeChunk`);
    }

    await new Promise((resolve, reject) => {
      nodeChunksTx.oncomplete = () => resolve();
      nodeChunksTx.onerror = () => reject(nodeChunksTx.error);
    });

    // Step 8: Update book timestamps for BOTH affected books
    const affectedBooks = new Set([targetHypercite.book]); // Book A (where cited text lives)

    // Also update the book where the deletion occurred (Book B)
    const currentBook = book; // From app.js import
    if (currentBook && currentBook !== targetHypercite.book) {
      affectedBooks.add(currentBook);
    }

    console.log(`📝 Updating timestamps for affected books:`, Array.from(affectedBooks));

    for (const bookId of affectedBooks) {
      await updateBookTimestamp(bookId);
    }

    queueForSync(
      "hypercites",
      updatedHypercite.hyperciteId,
      "update",
      updatedHypercite
    );

    // 🔥 CRITICAL FIX: Flush sync queue immediately to persist timestamp updates
    // This ensures changes are saved before user navigates away
    console.log("⚡ Flushing sync queue immediately for hypercite deletion...");
    await debouncedMasterSync.flush();
    console.log("✅ Sync queue flushed.");

    console.log("✅ Delink process completed successfully");

    // 🔥 NEW: Broadcast the update to other tabs so they can refresh the hypercite's appearance
    if (foundNodeChunk) {
      const { broadcastToOpenTabs } = await import('./BroadcastListener.js');
      broadcastToOpenTabs(targetHypercite.book, foundNodeChunk.startLine);
      console.log(`📡 Broadcasted delink update for node ${foundNodeChunk.startLine} to other tabs`);
    }
  } catch (error) {
    console.error("❌ Error in delinkHypercite:", error);
  }
}

/**
 * Extract hypercite ID from href URL
 * @param {string} hrefUrl - The href URL
 * @returns {string|null} - The hypercite ID or null if not found
 */
function extractHyperciteIdFromHref(hrefUrl) {
  try {
    const url = new URL(hrefUrl, window.location.origin);
    const hash = url.hash;
    
    if (hash && hash.startsWith('#hypercite_')) {
      return hash.substring(1); // Remove the # symbol
    }
    
    return null;
  } catch (error) {
    console.error("Error parsing href URL:", hrefUrl, error);
    return null;
  }
}

/**
 * Get hypercite by ID from IndexedDB
 * @param {IDBDatabase} db - The IndexedDB database
 * @param {string} hyperciteId - The hypercite ID to look up
 * @returns {Promise<Object|null>} - The hypercite object or null
 */
async function getHyperciteById(db, hyperciteId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("hypercites", "readonly");
    const store = tx.objectStore("hypercites");
    const index = store.index("hyperciteId");
    const request = index.get(hyperciteId);

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(new Error(`Error retrieving hypercite: ${hyperciteId}`));
    };
  });
}

/**
 * Remove a citedIN entry that matches the given hypercite element ID
 * @param {Array} citedINArray - The current citedIN array
 * @param {string} hyperciteElementId - The ID of the hypercite element to remove
 * @returns {Array} - Updated citedIN array
 */
function removeCitedINEntry(citedINArray, hyperciteElementId) {
  if (!Array.isArray(citedINArray)) {
    return [];
  }

  return citedINArray.filter(citedINUrl => {
    // Extract the hypercite ID from the citedIN URL
    const urlParts = citedINUrl.split('#');
    if (urlParts.length > 1) {
      const citedHyperciteId = urlParts[1];
      return citedHyperciteId !== hyperciteElementId;
    }
    return true; // Keep entries that don't match the expected format
  });
}

/**
 * Determine relationship status based on citedIN array length
 * @param {number} citedINLength - Length of the citedIN array
 * @returns {string} - The relationship status
 */
function determineRelationshipStatus(citedINLength) {
  if (citedINLength === 0) {
    return "single";
  } else if (citedINLength === 1) {
    return "couple";
  } else {
    return "poly";
  }
}

/**
 * Update hypercite in IndexedDB
 * @param {IDBDatabase} db - The IndexedDB database
 * @param {Object} hyperciteData - The updated hypercite data
 */
// Update hypercite in IndexedDB
async function updateHyperciteInIndexedDB(db, hyperciteData) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("hypercites", "readwrite");
    const store = tx.objectStore("hypercites");
    const request = store.put(hyperciteData);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("Error updating hypercite"));
  });
}

/**
 * Update DOM element class based on relationship status
 * @param {string} hyperciteId - The hypercite ID
 * @param {string} relationshipStatus - The new relationship status
 */
function updateDOMElementClass(hyperciteId, relationshipStatus) {
  const element = document.getElementById(hyperciteId);
  if (element && element.tagName.toLowerCase() === 'u') {
    // Remove existing relationship classes
    element.classList.remove('single', 'couple', 'poly');
    // Add new class
    element.classList.add(relationshipStatus);
    console.log(`🎨 Updated DOM element ${hyperciteId} class to: ${relationshipStatus}`);
  }
}

/**
 * Sync delink operation with PostgreSQL
 * @param {Object} updatedHypercite - The updated hypercite data
 */
async function syncDelinkWithPostgreSQL(updatedHypercite) {
  try {
    console.log("🔄 Syncing delink with PostgreSQL...");

    // Sync the hypercite update
    const hyperciteResponse = await fetch("/api/db/hypercites/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document
          .querySelector('meta[name="csrf-token"]')
          ?.getAttribute("content"),
      },
      credentials: "include",
      body: JSON.stringify({
        book: updatedHypercite.book,
        data: [updatedHypercite]
      }),
    });

    if (!hyperciteResponse.ok) {
      throw new Error(`Hypercite sync failed: ${hyperciteResponse.statusText}`);
    }

    console.log("✅ Hypercite delink synced with PostgreSQL");

    // Update library timestamp
    const libraryObj = await getLibraryObjectFromIndexedDB(updatedHypercite.book);
    if (libraryObj && libraryObj.timestamp) {
      const timestampResponse = await fetch("/api/db/library/update-timestamp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        credentials: "include",
        body: JSON.stringify({
          book: libraryObj.book,
          timestamp: libraryObj.timestamp
        }),
      });

      if (!timestampResponse.ok) {
        throw new Error(`Library timestamp update failed: ${timestampResponse.statusText}`);
      }

      console.log("✅ Library timestamp updated for delink");
    }

  } catch (error) {
    console.error("❌ Error syncing delink with PostgreSQL:", error);
  }
}

/**
 * Helper function to handle hypercite deletion from DOM
 * Call this when you detect a hypercite element is being deleted
 * @param {HTMLElement} hyperciteElement - The hypercite element being deleted
 */
export async function handleHyperciteDeletion(hyperciteElement) {
  if (!hyperciteElement || !hyperciteElement.href || !hyperciteElement.id) {
    console.warn("⚠️ Invalid hypercite element for deletion");
    return;
  }

  const hyperciteElementId = hyperciteElement.id;
  const hrefUrl = hyperciteElement.href;

  console.log("🗑️ Handling deletion of hypercite:", hyperciteElementId);
  
  await delinkHypercite(hyperciteElementId, hrefUrl);
}

/**
 * Highlight target hypercite and dim others when navigating to a specific hypercite
 * @param {string} targetHyperciteId - The ID of the hypercite being navigated to
 * @param {number} delay - Delay in milliseconds before highlighting starts (default: 300ms)
 */
export function highlightTargetHypercite(targetHyperciteId, delay = 300) {
  console.log(`🎯 Highlighting target hypercite: ${targetHyperciteId} (with ${delay}ms delay)`);

  // Find all hypercite elements (u tags with couple, poly, or single classes)
  const allHypercites = document.querySelectorAll('u.single, u.couple, u.poly');

  // Find ALL segments for this hypercite (both individual and overlapping)
  let targetElements = [];

  // 1. Check for direct element (individual segment)
  const directElement = document.getElementById(targetHyperciteId);
  if (directElement) {
    console.log(`🎯 Found direct element for ${targetHyperciteId}:`, directElement);
    targetElements.push(directElement);
  }

  // 2. Check ALL overlapping elements for segments containing this hypercite
  const overlappingElements = document.querySelectorAll('u[data-overlapping]');
  for (const element of overlappingElements) {
    const overlappingIds = element.getAttribute('data-overlapping');
    if (overlappingIds && overlappingIds.split(',').map(id => id.trim()).includes(targetHyperciteId)) {
      console.log(`🎯 Found target hypercite ${targetHyperciteId} in overlapping element:`, element);
      targetElements.push(element);
    }
  }

  // Wait for the specified delay, then apply highlighting with smooth transition
  setTimeout(() => {
    console.log(`✨ Starting hypercite highlighting animation for: ${targetHyperciteId}`);

    // 🔥 FIX: Remove any existing highlight classes first to ensure animation restarts
    restoreNormalHyperciteDisplay();

    // Force a reflow to ensure browser recognizes the class removal before re-adding
    void document.body.offsetHeight;

    // Apply target highlighting to ALL elements containing this hypercite
    if (targetElements.length > 0) {
      targetElements.forEach(element => {
        element.classList.add('hypercite-target');

        // 🎯 NEW: Also highlight any arrow icons within this hypercite
        const arrowIcons = element.querySelectorAll('.open-icon, sup.open-icon, span.open-icon');
        arrowIcons.forEach(arrow => {
          arrow.classList.add('arrow-target');
          console.log(`✨ Added arrow highlight to icon in ${targetHyperciteId}`);
        });
      });
      console.log(`✅ Added target highlighting to ${targetElements.length} segments for: ${targetHyperciteId}`);
    } else {
      console.warn(`⚠️ Could not find target hypercite element: ${targetHyperciteId}`);
    }

    // Dim all other hypercites (but not the target elements)
    allHypercites.forEach(element => {
      if (!targetElements.includes(element)) {
        element.classList.add('hypercite-dimmed');
      }
    });

    console.log(`🔅 Dimmed ${allHypercites.length - targetElements.length} non-target hypercites`);

    // Remove highlighting after 5 seconds with smooth transition back
    setTimeout(() => {
      console.log(`🌅 Starting fade-out animation for: ${targetHyperciteId}`);
      restoreNormalHyperciteDisplay();
    }, 5000);

  }, delay);

}

/**
 * Restore normal hypercite display by removing all navigation classes
 */
export function restoreNormalHyperciteDisplay() {
  console.log(`🔄 Restoring normal hypercite display`);

  const allHypercites = document.querySelectorAll('u.hypercite-target, u.hypercite-dimmed');
  allHypercites.forEach(element => {
    element.classList.remove('hypercite-target', 'hypercite-dimmed');
  });

  // 🎯 NEW: Also remove arrow highlighting
  const allArrows = document.querySelectorAll('.arrow-target');
  allArrows.forEach(arrow => {
    arrow.classList.remove('arrow-target');
  });

  console.log(`✅ Restored normal display for ${allHypercites.length} hypercites and ${allArrows.length} arrows`);
}



