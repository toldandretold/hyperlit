import { book } from "./app.js";
import { navigateToInternalId } from "./scrolling.js";
import { openDatabase, 
         parseNodeId, 
         createNodeChunksKey, 
         getLibraryObjectFromIndexedDB,
         updateBookTimestamp,
         toPublicChunk,
         queueForSync,
         getNodeChunkFromIndexedDB,
         updateHyperciteInIndexedDB  } from "./cache-indexedDB.js";
import { ContainerManager } from "./container-manager.js";
import { formatBibtexToCitation } from "./bibtexProcessor.js";
import { currentLazyLoader } from './initializePage.js';
import { addTouchAndClickListener } from './hyperLights.js';
import { getCurrentUser, getAuthorId, getAnonymousToken } from "./auth.js";


let lastEventTime = 0;
function handleCopyEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  
  // Prevent double-firing within 300ms
  const now = Date.now();
  if (now - lastEventTime < 300) return;
  lastEventTime = now;
  
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    console.log("No selection found");
    return;
  }

  if (!book) {
    console.error("Book identifier not found.");
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
  const citationIdA = book;
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



// Set up event listeners
const copyButton = document.getElementById("copy-hypercite");

// Just add this one line to prevent the button from clearing selection:
copyButton.addEventListener('mousedown', function(e) {
  e.preventDefault();
});
// Remove existing listeners
copyButton.removeEventListener('click', handleCopyEvent);
copyButton.removeEventListener('touchend', handleCopyEvent);

// Add listeners with proper options
copyButton.addEventListener('click', handleCopyEvent, { passive: false });
copyButton.addEventListener('touchend', handleCopyEvent, { passive: false });

// Ensure button is optimized for mobile
copyButton.style.touchAction = 'manipulation';
copyButton.style.userSelect = 'none';

// Keep your existing wrapSelectedTextInDOM function unchanged
function wrapSelectedTextInDOM(hyperciteId, book) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return console.error("No selection");
  const range = selection.getRangeAt(0);

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

// In hyperCites.js

async function NewHyperciteIndexedDB(book, hyperciteId, blocks) {
  try {
    // =======================================================================
    // PHASE 1: PRE-FETCH & INFO GATHERING
    // We MUST read the existing node chunks first to build a correct payload.
    // =======================================================================
    const db = await openDatabase();
    const readTx = db.transaction(["nodeChunks"], "readonly");
    const nodeChunksStore = readTx.objectStore("nodeChunks");
    
    const existingNodeChunks = new Map();
    const readPromises = blocks.map(block => {
        return new Promise(resolve => {
            const key = createNodeChunksKey(book, block.startLine);
            const getRequest = nodeChunksStore.get(key);
            getRequest.onsuccess = () => {
                if (getRequest.result) {
                    existingNodeChunks.set(block.startLine, getRequest.result);
                }
                resolve();
            };
            getRequest.onerror = () => resolve(); // Continue even if one fails
        });
    });
    await Promise.all(readPromises);


    // =======================================================================
    // PHASE 2: SYNCHRONOUS QUEUING
    // Now that we have all the data, we can build the correct payloads and queue them.
    // =======================================================================
    console.log("✅ Queuing new hypercite immediately to prevent data loss...");

    const uElement = document.getElementById(hyperciteId);
    if (!uElement) throw new Error("Hypercite element not found in DOM for queuing.");

    // A. Construct and queue the main hypercite entry.
    const hypercitedText = uElement.textContent;
    const overallStartChar = blocks.length > 0 ? blocks[0].charStart : 0;
    const overallEndChar = blocks.length > 0 ? blocks[blocks.length - 1].charEnd : 0;

    const hyperciteEntry = {
      book: book,
      hyperciteId: hyperciteId,
      hypercitedText: hypercitedText,
      hypercitedHTML: uElement.outerHTML, // Use outerHTML for a better representation
      startChar: overallStartChar,
      endChar: overallEndChar,
      relationshipStatus: "single",
      citedIN: []
    };
    queueForSync("hypercites", hyperciteId, "update", hyperciteEntry);

    // B. Construct and queue the node chunk updates, using the pre-fetched data.
    for (const block of blocks) {
      const numericStartLine = parseNodeId(block.startLine);
      const existingChunk = existingNodeChunks.get(block.startLine);
      let chunkToQueue;

      if (existingChunk) {
        // It's an update. Start with the existing chunk.
        chunkToQueue = { ...existingChunk };
        chunkToQueue.hypercites = chunkToQueue.hypercites || [];
        chunkToQueue.hypercites.push({
          hyperciteId: hyperciteId,
          charStart: block.charStart,
          charEnd: block.charEnd,
          relationshipStatus: "single",
          citedIN: []
        });
      } else {
        // It's a new chunk. Create it from scratch, like your original logic.
        chunkToQueue = {
          book: book,
          startLine: numericStartLine,
          chunk_id: numericStartLine, // CRITICAL FIX
          content: document.getElementById(block.startLine)?.innerHTML || "",
          hypercites: [{
            hyperciteId: hyperciteId,
            charStart: block.charStart,
            charEnd: block.charEnd,
            relationshipStatus: "single",
            citedIN: []
          }]
        };
      }
      queueForSync("nodeChunks", block.startLine, "update", chunkToQueue);
    }

    // C. Queue the timestamp update.
    updateBookTimestamp(book);


    // =======================================================================
    // PHASE 3: ASYNCHRONOUS INDEXEDDB WRITES
    // Perform the local saves using the same logic.
    // =======================================================================
    const writeTx = db.transaction(["hypercites", "nodeChunks"], "readwrite");
    const writeHypercitesStore = writeTx.objectStore("hypercites");
    const writeNodeChunksStore = writeTx.objectStore("nodeChunks");

    writeHypercitesStore.put(hyperciteEntry);

    for (const block of blocks) {
        const numericStartLine = parseNodeId(block.startLine);
        const existingChunk = existingNodeChunks.get(block.startLine);
        let chunkToWrite;

        if (existingChunk) {
            chunkToWrite = existingChunk; // Use the object we already fetched
            chunkToWrite.hypercites = chunkToWrite.hypercites || [];
            chunkToWrite.hypercites.push({
                hyperciteId: hyperciteId,
                charStart: block.charStart,
                charEnd: block.charEnd,
                relationshipStatus: "single",
                citedIN: []
            });
        } else {
            chunkToWrite = {
                book: book,
                startLine: numericStartLine,
                chunk_id: numericStartLine, // CRITICAL FIX
                content: document.getElementById(block.startLine)?.innerHTML || "",
                hypercites: [{
                    hyperciteId: hyperciteId,
                    charStart: block.charStart,
                    charEnd: block.charEnd,
                    relationshipStatus: "single",
                    citedIN: []
                }]
            };
        }
        writeNodeChunksStore.put(chunkToWrite);
    }

    await new Promise((resolve, reject) => {
      writeTx.oncomplete = resolve;
      writeTx.onerror = (e) => reject(e.target.error);
    });

    console.log("✅ Local IndexedDB operations for new hypercite complete.");

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
          
          // Update URL
          const newPath = `/${currentBook}/${highlightId}` + (internalId ? `#${internalId}` : "");
          window.history.pushState(null, "", newPath);
          
          // Use navigateToInternalId for everything - it handles highlight opening AND scrolling
          if (internalId) {
            // If there's an internal ID, navigate to the highlight first, then to the internal ID
            navigateToInternalId(highlightId, currentLazyLoader);
            // Wait for highlight to open, then navigate to internal ID
            setTimeout(() => {
              navigateToInternalId(internalId, currentLazyLoader);
            }, 1000); // Increased timeout to ensure highlight opens first
          } else {
            // Just navigate to the highlight
            navigateToInternalId(highlightId, currentLazyLoader);
          }
          
          return; // Don't do normal navigation
        }

        if (bookSegment === currentBook) {
          console.log("✅ Same-book internal link detected");
          const internalId = url.hash ? url.hash.slice(1) : null;
          
          if (internalId) {
            // Update URL and navigate to internal ID
            window.history.pushState(null, "", `/${currentBook}#${internalId}`);
            navigateToInternalId(internalId, currentLazyLoader);
            return;
          }
        }
      }
      
      // If not a same-book highlight, do normal navigation
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
  // Check if this is an overlapping hypercite
  if (uElement.id === "hypercite_overlapping") {
    await handleOverlappingHyperciteClick(uElement, event);
    return;
  }

  // Handle non-overlapping hypercites (original logic)
  if (uElement.classList.contains("couple")) {
    await CoupleClick(uElement);
  } else if (uElement.classList.contains("poly")) {
    await PolyClick(event);
  } else {
    console.log("Clicked on an underlined element with no special handling");
  }
}

/**
 * Function to handle clicks on overlapping hypercites
 * @param {HTMLElement} uElement - The overlapping hypercite element
 * @param {Event} event - The click event
 */
async function handleOverlappingHyperciteClick(uElement, event) {
  console.log("Overlapping hypercite clicked:", uElement);

  // Get the overlapping hypercite IDs from data-overlapping attribute
  const overlappingData = uElement.getAttribute("data-overlapping");
  if (!overlappingData) {
    console.error("❌ No data-overlapping attribute found");
    return;
  }

  const hyperciteIds = overlappingData.split(",").map(id => id.trim());
  console.log("Overlapping hypercite IDs:", hyperciteIds);

  const className = uElement.className;
  
  if (className === "couple") {
    await handleOverlappingCouple(hyperciteIds);
  } else if (className === "poly") {
    await handleOverlappingPoly(hyperciteIds, event);
  } else {
    console.log("Overlapping hypercite with single class - no action needed");
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
      
      // Update URL
      const newPath = `/${currentBook}/${highlightId}` + (internalId ? `#${internalId}` : "");
      window.history.pushState(null, "", newPath);
      
      // Use navigateToInternalId for everything - it handles highlight opening AND scrolling
      if (internalId) {
        // If there's an internal ID, navigate to the highlight first, then to the internal ID
        navigateToInternalId(highlightId, currentLazyLoader);
        // Wait for highlight to open, then navigate to internal ID
        setTimeout(() => {
          navigateToInternalId(internalId, currentLazyLoader);
        }, 1000); // Increased timeout to ensure highlight opens first
      } else {
        // Just navigate to the highlight
        navigateToInternalId(highlightId, currentLazyLoader);
      }
      
      return; // Don't do normal navigation
    }

    if (bookSegment === currentBook) {
      console.log("✅ Same-book internal link detected");
      const internalId = url.hash ? url.hash.slice(1) : null;
      
      if (internalId) {
        // Update URL and navigate to internal ID
        window.history.pushState(null, "", `/${currentBook}#${internalId}`);
        navigateToInternalId(internalId, currentLazyLoader);
        return;
      }
    }
  }
  
  // If not a same-book highlight, do normal navigation
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

        // Check if the book exists in the library object store
        const libraryTx = db.transaction("library", "readonly");
        const libraryStore = libraryTx.objectStore("library");
        const libraryRequest = libraryStore.get(bookID);

        return new Promise((resolve) => {
          libraryRequest.onsuccess = () => {
            const libraryData = libraryRequest.result;

            if (libraryData && libraryData.bibtex) {
              // Format the BibTeX data into an academic citation
              const formattedCitation = formatBibtexToCitation(libraryData.bibtex);
              
              // Customize the citation display based on URL type
              const citationText = isHyperlightURL 
                ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}` 
                : formattedCitation;

              // Return the formatted citation with the clickable link
              resolve(
                `<p>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></p>`
              );
            } else {
              // If no record exists, return the default link
              resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
            }
          };

          libraryRequest.onerror = () => {
            console.error(`❌ Error fetching library data for book ID: ${bookID}`);
            resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
          };
        });
      })
    )
  ).join("");

  const containerContent = `
    <div class="scroller">
      <h1>Cited By (Overlapping Hypercites):</h1>
      <p>Found ${validHypercites.length} overlapping hypercites with ${uniqueLinks.length} total citations.</p>
      <div class="citation-links">
        ${linksHTML}
      </div>
    </div>
    <div class="mask-bottom"></div>
    <div class="mask-top"></div>
  `;

  // Open the hypercite container with the generated content
  openHyperciteContainer(containerContent);
}


/**
 * Function to attach click listeners to underlined citations
 */
export function attachUnderlineClickListeners() {
  // Select all underlined elements with either couple or poly class
  const uElements = document.querySelectorAll("u.couple, u.poly");
  console.log(
    `attachUnderlineClickListeners: Found ${uElements.length} underlined elements.`
  );

  uElements.forEach((uElement, index) => {
    console.log(`Processing element ${index + 1}:`, uElement);
    uElement.style.cursor = "pointer";

    uElement.addEventListener("click", async (event) => {
      await handleUnderlineClick(uElement, event);
    });
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
                libraryRequest.onsuccess = () => {
                  const libraryData = libraryRequest.result;

                  if (libraryData && libraryData.bibtex) {
                    // Format the BibTeX data into an academic citation
                    const formattedCitation = formatBibtexToCitation(libraryData.bibtex);
                    
                    // Customize the citation display based on URL type
                    const citationText = isHyperlightURL 
                      ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}` 
                      : formattedCitation;

                    // Return the formatted citation with the clickable link
                    resolve(
                      `<p>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></p>`
                    );
                  } else {
                    // If no record exists, return the default link
                    resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
                  }
                };

                libraryRequest.onerror = () => {
                  console.error(`❌ Error fetching library data for book ID: ${bookID}`);
                  resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
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

// Create a container manager for hypercites using the same overlay if needed
const hyperciteManager = new ContainerManager(
  "hypercite-container",
  "ref-overlay",
  null,
  ["main-content", "nav-buttons"]
);

export function openHyperciteContainer(content) {
  hyperciteManager.openContainer(content);
}

export function closeHyperciteContainer() {
  hyperciteManager.closeContainer();
}



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
// In hyperCites.js

// First, make sure you have the correct import at the top of the file
// It should look like this:
/*
import {
  // ... other imports
  updateHyperciteInIndexedDB // <-- Ensure this is imported
} from "./cache-indexedDB.js";
*/

export async function delinkHypercite(hyperciteElementId, hrefUrl) {
  try {
    console.log("🔗 Starting delink process for:", hyperciteElementId);

    // =======================================================================
    // PHASE 1: ASYNCHRONOUS INFO GATHERING
    // Fetch the target record first to know what to change.
    // =======================================================================
    const targetHyperciteId = extractHyperciteIdFromHref(hrefUrl);
    if (!targetHyperciteId) {
      console.error("❌ Could not extract hypercite ID from href:", hrefUrl);
      return;
    }

    const db = await openDatabase();
    const targetHypercite = await getHyperciteById(db, targetHyperciteId);
    if (!targetHypercite) {
      console.error("❌ Target hypercite not found in database:", targetHyperciteId);
      return;
    }

    // =======================================================================
    // PHASE 2: SYNCHRONOUS CALCULATION & OPTIMISTIC QUEUING
    // =======================================================================
    console.log("✅ Queuing hypercite delink immediately...");

    // A. Calculate the new state
    const updatedCitedIN = removeCitedINEntry(targetHypercite.citedIN, hyperciteElementId);
    const newRelationshipStatus = determineRelationshipStatus(updatedCitedIN.length);

    // B. Construct the full updated object for queuing
    const updatedHyperciteForQueue = {
      ...targetHypercite,
      citedIN: updatedCitedIN,
      relationshipStatus: newRelationshipStatus
    };

    // C. Queue the primary record change and the timestamp update. This is the critical part.
    queueForSync("hypercites", targetHyperciteId, "update", updatedHyperciteForQueue);
    updateBookTimestamp(targetHypercite.book);
    console.log("✅ Queuing complete for primary hypercite record.");


    // =======================================================================
    // PHASE 3: ASYNCHRONOUS LOCAL SAVE & DOM UPDATE
    // =======================================================================
    // Use the imported function from cache-indexedDB.js to update the main hypercites table
    await updateHyperciteInIndexedDB(
      targetHypercite.book,
      targetHyperciteId,
      { // Pass only the fields that changed
        citedIN: updatedCitedIN,
        relationshipStatus: newRelationshipStatus
      }
    );
    console.log("💾 Updated hypercite in local IndexedDB.");

    // We also need to update the nodeChunk that contains this hypercite.
    // This is a secondary operation; the primary data is already queued.
    // We must scan for the nodeChunk that contains the targetHypercite.
    const readTx = db.transaction("nodeChunks", "readwrite");
    const nodeChunksStore = readTx.objectStore("nodeChunks");
    const cursorReq = nodeChunksStore.openCursor();

    cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
            const chunk = cursor.value;
            if (chunk.book === targetHypercite.book && chunk.hypercites) {
                const hcIndex = chunk.hypercites.findIndex(hc => hc.hyperciteId === targetHyperciteId);
                if (hcIndex > -1) {
                    // Found it. Update and save.
                    chunk.hypercites[hcIndex].citedIN = updatedCitedIN;
                    chunk.hypercites[hcIndex].relationshipStatus = newRelationshipStatus;
                    cursor.update(chunk);
                    console.log(`Updated nodeChunk ${chunk.startLine} with delink info.`);
                    // We don't need to queue this again, as the primary hypercite update covers it.
                }
            }
            cursor.continue();
        }
    };

    // Update the DOM element's class if it exists
    updateDOMElementClass(targetHyperciteId, newRelationshipStatus);

    console.log("✅ Delink process completed successfully");

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
// Renamed for clarity to avoid confusion with the one in cache-indexedDB.js
async function updateHyperciteInDB(db, hyperciteData) {
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



