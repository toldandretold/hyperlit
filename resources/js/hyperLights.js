import { book } from './app.js';
import { fetchLatestUpdateInfo, handleTimestampComparison } from "./updateCheck.js";
import { createLazyLoader, loadNextChunkFixed, loadPreviousChunkFixed } from "./lazyLoaderFactory.js";
import { ContainerManager } from "./container-manager.js";
import { navigateToInternalId } from "./scrolling.js";
import { openDatabase, parseNodeId, createNodeChunksKey } from "./cache-indexedDB.js";
import { attachAnnotationListener } from "./annotation-saver.js";
import { addPasteListener } from "./divEditor.js";
import { addHighlightContainerPasteListener } from "./hyperLightsListener.js";


let highlightId; 
let highlightLazyLoader;

// Create a container manager for highlights using the same overlay if needed
const highlightManager = new ContainerManager(
    "highlight-container", 
    "ref-overlay", 
    null, 
    ["main-content", "nav-buttons"]);

export function openHighlightContainer(content) {
  highlightManager.openContainer(content);
}

export function closeHighlightContainer() {
  highlightManager.closeContainer();
}

// Helper that creates or updates the lazy loader.
function initOrUpdateHighlightLazyLoader(chunks) {
  if (highlightLazyLoader) {
    // Update the nodeChunks if the lazy loader already exists.
    highlightLazyLoader.nodeChunks = chunks;
  } else {
    // Create the lazy loader with the given chunks.
    highlightLazyLoader = createLazyLoader({
      container: document.getElementById("highlight-container"),
      nodeChunks: chunks,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners,
      bookId: book,
    });
  }
  return highlightLazyLoader;
}

// ========= Mark Listeners =========
export function attachMarkListeners() {
    // Get all mark elements (both with ID and with just class)
    const markTags = document.querySelectorAll("mark");
    console.log(`Attempting to attach listeners to ${markTags.length} mark elements`);
    
    markTags.forEach(function(mark) {
        // Remove existing listeners
        mark.removeEventListener("click", handleMarkClick);
        mark.removeEventListener("mouseover", handleMarkHover);
        mark.removeEventListener("mouseout", handleMarkHoverOut);
        
        // Add new listeners
        mark.addEventListener("click", handleMarkClick);
        mark.addEventListener("mouseover", handleMarkHover);
        mark.addEventListener("mouseout", handleMarkHoverOut);
        
        mark.dataset.listenerAttached = true;
        console.log(`Listener attached to mark with ID or class: ${mark.id || '[class only]'}`);
    });
    
    console.log(`Mark listeners refreshed for ${markTags.length} <mark> tags`);
}

export async function handleMarkClick(event) {
  event.preventDefault();

  const highlightId = event.target.className;
  
  if (!highlightId) {
    console.error("❌ Could not determine highlight ID.");
    return;
  }

  console.log(`Mark clicked: ${highlightId}`);

  try {
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const index = store.index("hyperlight_id");
    
    const getRequest = index.get(highlightId);

    getRequest.onsuccess = () => {
      const highlightData = getRequest.result;
      console.log("Found highlight data:", highlightData);
      
      if (!highlightData) {
        console.error("❌ No highlight data found for ID:", highlightId);
        return;
      }

      const containerContent = `
        <div class="scroller">
        <blockquote class="highlight-text">
          "${highlightData.highlightedHTML}"
        </blockquote>
        <div class="annotation" contenteditable="true">
          <p class="temp-text" data-placeholder="Annotate at will...">${highlightData.annotation || ""}</p>
        </div>
        </div>
         <div class="mask-bottom"></div>
        <div class="mask-top"></div>
      `;

      // Open container with content directly
      openHighlightContainer(containerContent);

      // After the container is open/unhidden, attach the annotation listener:
      attachAnnotationListener(highlightId);

      // Find the annotation div and add the paste listener to it
      addHighlightContainerPasteListener(highlightId);

      // Double check that the container exists and has content
      const highlightContainer = document.getElementById("highlight-container");
      if (!highlightContainer) {
        console.error("❌ Highlight container element not found in DOM");
        return;
      }
      
      console.log("Container state:", {
        exists: !!highlightContainer,
        content: highlightContainer.innerHTML,
        isVisible: highlightContainer.classList.contains("open")
      });
    };

    getRequest.onerror = (event) => {
      console.error("❌ Error fetching highlight data:", event.target.error);
    };

  } catch (error) {
    console.error("❌ Error accessing IndexedDB:", error);
  }
}

function getRelativeOffsetTop(element, container) {
  let offsetTop = 0;
  while (element && element !== container) {
    offsetTop += element.offsetTop;
    element = element.offsetParent;
  }
  return offsetTop;
}

export function handleMarkHover(event) {
    const highlightId = event.target.id;
    event.target.style.textDecoration = "underline";
    console.log(`Mark over: ${highlightId}`);
}

export function handleMarkHoverOut(event) {
    event.target.style.textDecoration = "none";
}

rangy.init();

// Initialize the highlighter
var highlighter = rangy.createHighlighter();

// Custom class applier with an element tag name of "mark"
var classApplier = rangy.createClassApplier("highlight", {
    elementTagName: "mark",
    applyToAnyTagName: true
});

highlighter.addClassApplier(classApplier);

// Cross-platform selection detection: desktop and mobile
function handleSelection() {
  // If the source container is open, don't do anything here.
  if (window.activeContainer === "source-container") {
    console.log("Source container is active; skipping hyperlight button toggling.");
    console.log("Current active container:", window.activeContainer);

    // If this function is triggered by an event, make sure to prevent further actions:
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }

  let selectedText = window.getSelection().toString().trim();
  const highlights = document.querySelectorAll('mark');
  let isOverlapping = false;

  // Check if the highlighted text overlaps with any existing highlight
  highlights.forEach(function (highlight) {
    if (selectedText.includes(highlight.textContent.trim())) {
      isOverlapping = true;
    }
  });

  if (selectedText.length > 0) {
    console.log("Showing buttons. Selected text:", selectedText);

    // Get the bounding box of the selected text to position buttons near it
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // Position the buttons near the selected text, but far from iOS context menu
    const buttons = document.getElementById("hyperlight-buttons");
    buttons.style.display = "flex";

    // Position the buttons below the selection (or above if there's no room below)
    let offset = 100; // Adjust this value to move the buttons further from iOS context menu
    if (rect.bottom + offset > window.innerHeight) {
      // Position the buttons above the selection if there's no room below
      buttons.style.top = `${rect.top + window.scrollY - offset}px`;
    } else {
      // Default: Position the buttons below the selection
      buttons.style.top = `${rect.bottom + window.scrollY + 10}px`; // 10px padding from selection
    }

    buttons.style.left = `${rect.left + window.scrollX}px`;

    // Show or hide the delete button based on overlap detection
    if (isOverlapping) {
      console.log("Detected overlapping highlight");
      document.getElementById("delete-hyperlight").style.display = "block";
    } else {
      console.log("No overlapping highlight detected");
      document.getElementById("delete-hyperlight").style.display = "none";
    }
  } else {
    console.log("No text selected. Hiding buttons.");
    document.getElementById("hyperlight-buttons").style.display = "none";
    document.getElementById("delete-hyperlight").style.display = "none";
  }
}


// Event listener for desktop (mouseup)
document.addEventListener('mouseup', handleSelection);

// Event listeners for mobile (touchend)
document.addEventListener('touchend', function() {
    setTimeout(handleSelection, 100);  // Small delay to ensure touch selection happens
});

// Prevent iOS from cancelling the selection when interacting with buttons
document.getElementById('hyperlight-buttons').addEventListener('touchstart', function(event) {
    event.preventDefault(); // Prevents native iOS behavior like cancelling the selection
    event.stopPropagation(); // Prevent touch events from bubbling and cancelling selection
});

// Allow interaction with buttons on touch
document.getElementById('hyperlight-buttons').addEventListener('click', function(event) {
    event.preventDefault(); // Ensure the button click doesn't cancel the selection
    event.stopPropagation(); // Stop the event from bubbling
});

// Helper function to bind click and touchstart events
function addTouchAndClickListener(element, handler) {
  element.addEventListener("mousedown", function (event) {
    event.preventDefault();
    event.stopPropagation();
    handler(event);
  });
  element.addEventListener("touchstart", function (event) {
    event.preventDefault();
    event.stopPropagation();
    handler(event);
  });
}


function generateHighlightID() {
    let userName = document.getElementById('user-name')?.textContent || 'unknown-user';
    let timestamp = Date.now();
    return `${userName}_${timestamp}`;
}

function modifyNewMarks(highlightId) {
    const newMarks = document.querySelectorAll('mark.highlight');
    newMarks.forEach((mark, index) => {
        if (index === 0) mark.setAttribute('id', highlightId);
        mark.classList.add(highlightId);
        mark.classList.remove('highlight');
    });
    console.log("✅ New highlight mark created with ID:", highlightId);
}

async function addToHighlightsTable(highlightData) {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    
    // Create a document fragment to hold the highlighted content
    const fragment = document.createDocumentFragment();
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    
    // Clone the range contents to preserve HTML structure
    const clonedContents = range.cloneContents();
    fragment.appendChild(clonedContents);
    
    // Get the HTML content as a string, but remove any mark tags
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(fragment.cloneNode(true));
    
    // Remove all mark tags from the temp div, preserving their content
    const markTags = tempDiv.querySelectorAll('mark');
    markTags.forEach(mark => {
      // Create a text node with the mark's content
      const textNode = document.createTextNode(mark.textContent);
      // Replace the mark with its text content
      mark.parentNode.replaceChild(textNode, mark);
    });
    
    const highlightedHTML = tempDiv.innerHTML;
    
    const highlightEntry = { 
      book: book, // Current book ID
      hyperlight_id: highlightData.highlightId,
      highlightedText: highlightData.text, // Keep the plain text for searching
      highlightedHTML: highlightedHTML, // Store the HTML structure without mark tags
      annotation: "", // initial empty annotation
      startChar: highlightData.startChar,
      endChar: highlightData.endChar,
      startLine: highlightData.startLine
    };

    const addRequest = store.put(highlightEntry);

    addRequest.onsuccess = () => {
      console.log("✅ Successfully added highlight to hyperlights table");
      resolve();
    };

    addRequest.onerror = (event) => {
      console.error("❌ Error adding highlight to hyperlights table:", event.target.error);
      reject(event.target.error);
    };
  });
}

function calculateTrueCharacterOffset(container, textNode, offset) {
  // First, create a clone of the container to work with
  const containerClone = container.cloneNode(true);
  
  // Remove all mark tags from the clone, preserving their text content
  const marks = containerClone.getElementsByTagName('mark');
  while (marks.length > 0) {
    const mark = marks[0];
    const text = mark.textContent;
    mark.parentNode.replaceChild(document.createTextNode(text), mark);
  }
  
  // Get the raw text content
  const rawText = containerClone.textContent;
  console.log("Raw text content:", rawText);
  
  // Now find the corresponding position in the raw text
  const walker = document.createTreeWalker(
    container, // Use original container
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let currentNode;
  let rawOffset = 0;
  
  while ((currentNode = walker.nextNode()) !== null) {
    if (currentNode === textNode) {
      // Found our target node
      let adjustedOffset = rawOffset + offset;
      console.log("Found target node, adjusted offset:", adjustedOffset);
      return adjustedOffset;
    }
    
    // For nodes inside marks, get their contribution to the raw text
    if (currentNode.parentElement.tagName === 'MARK') {
      rawOffset += currentNode.textContent.length;
    } else {
      rawOffset += currentNode.textContent.length;
    }
  }
  
  return rawOffset;
}

addTouchAndClickListener(
  document.getElementById("copy-hyperlight"),
  async function() {
    // Existing code for selection and range checking
    let selection = window.getSelection();
    let range;
    try {
      range = selection.getRangeAt(0);
      console.log("📌 Full selected text:", selection.toString());
    } catch (error) {
      console.error("❌ Error getting range:", error);
      return;
    }

    let selectedText = selection.toString().trim();
    if (!selectedText) {
      console.error("⚠️ No valid text selected.");
      return;
    }

    // Get containers before any modifications
    let startContainer = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement.closest("p, blockquote, table, [id]")
      : range.startContainer.closest("p, blockquote, table, [id]");
    
    let endContainer = range.endContainer.nodeType === 3
      ? range.endContainer.parentElement.closest("p, blockquote, table, [id]")
      : range.endContainer.closest("p, blockquote, table, [id]");

    if (!startContainer || !endContainer) {
      console.error("❌ Could not determine start or end block.");
      return;
    }
    
    console.log("Start container:", startContainer);
    console.log("End container:", endContainer);
    
    // Calculate true character offsets before adding new marks
    const trueStartOffset = calculateTrueCharacterOffset(
      startContainer, 
      range.startContainer, 
      range.startOffset
    );
    
    const trueEndOffset = calculateTrueCharacterOffset(
      endContainer,
      range.endContainer,
      range.endOffset
    );

    console.log("True offsets:", { start: trueStartOffset, end: trueEndOffset });

    // Generate unique highlight ID
    const highlightId = generateHighlightID();

    // Apply the highlight
    highlighter.highlightSelection("highlight");
    modifyNewMarks(highlightId);

    // Find all nodes that contain marks with this highlightId
    const affectedMarks = document.querySelectorAll(`mark.${highlightId}`);
    const affectedIds = new Set();
    affectedMarks.forEach(mark => {
      const container = mark.closest(
        "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id]"
      );
      if (container && container.id) {
        affectedIds.add(container.id);    // keep "1.1" intact
      }
    });
    console.log("Will update chunks:", Array.from(affectedIds));
    
    // Update all affected nodes in IndexedDB
    // 2) call updateNodeHighlight by ID string
    for (const chunkId of affectedIds) {
      const isStart = chunkId === startContainer.id;
      const isEnd   = chunkId === endContainer.id;
      const textElem = document.getElementById(chunkId);
      const len = textElem ? textElem.textContent.length : 0;
      const startOffset = isStart ? trueStartOffset : 0;
      const endOffset   = isEnd   ? trueEndOffset   : len;

      await updateNodeHighlight(
        chunkId,       // PASS the string "1.1"
        startOffset,
        endOffset,
        highlightId
      );
      console.log(`Updated chunk ${chunkId}`);
    }

     try {
      // 3) in the hyperlights table, also keep startLine as string
      await addToHighlightsTable({
        highlightId,
        text: selectedText,
        startChar: trueStartOffset,
        endChar: trueEndOffset,
        startLine: startContainer.id   // keep "1.1"
      });
      console.log("Added to highlights table");
    } catch (error) {
      console.error("❌ Error saving highlight metadata:", error);
    }

    attachMarkListeners();
  }
);

// new signature — takes chunkId as a string (e.g. "1.1")
async function updateNodeHighlight(
  chunkId,
  highlightStartOffset,
  highlightEndOffset,
  highlightId
) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");

    // Use the helper to create a consistent key
    const key = createNodeChunksKey(book, chunkId);
    console.log("Looking up with key:", key);
    
    const getRequest = store.get(key);

    getRequest.onsuccess = () => {
      const node = getRequest.result;
      if (!node) {
        console.warn(`No nodeChunks record for key [${book}, ${chunkId}]`);
        
        // Create a new node if it doesn't exist
        const newNode = {
          book: book,
          startLine: parseNodeId(chunkId),  // Store as number
          chunk_id: parseNodeId(chunkId),
          content: document.getElementById(chunkId)?.innerHTML || "",
          hyperlights: [{
            highlightID: highlightId,
            charStart: highlightStartOffset,
            charEnd: highlightEndOffset
          }]
        };
        
        const putReq = store.put(newNode);
        putReq.onsuccess = () => {
          console.log(`Created new node for [${book}, ${chunkId}]`);
          resolve();
        };
        putReq.onerror = e => reject(e.target.error);
        return;
      }
      
      node.hyperlights = node.hyperlights || [];
      // Add your highlight if missing
      if (!node.hyperlights.find(h => h.highlightID === highlightId)) {
        node.hyperlights.push({
          highlightID: highlightId,
          charStart: highlightStartOffset,
          charEnd: highlightEndOffset
        });
      }
      
      const putReq = store.put(node);
      putReq.onsuccess = () => {
        console.log(`Updated node [${book}, ${chunkId}] with highlight`);
        resolve();
      };
      putReq.onerror = e => reject(e.target.error);
    };

    getRequest.onerror = e => reject(e.target.error);
  });
}




// Simplified delete highlight function
addTouchAndClickListener(document.getElementById("delete-hyperlight"),
  async function (event) {
    event.preventDefault();
    console.log("Delete button clicked.");

    // Get the current text selection as plain text.
    let selection = window.getSelection();
    let selectedText = selection.toString().trim();

    if (!selectedText) {
      console.error("No text selected to delete.");
      return;
    }

    // Find all <mark> tags in the document.
    const marks = document.querySelectorAll("mark");
    let highlightIdsToRemove = [];

    marks.forEach((mark) => {
      // If the text content of the mark is part of the selected text …
      if (selectedText.indexOf(mark.textContent.trim()) !== -1) {
        // Get the unique highlight id from the mark's classes.
        // (Assumes that one class is the generated highlightID while 
        //  the default "highlight" is omitted.)
        let highlightId = Array.from(mark.classList).find(
          (cls) => cls !== "highlight"
        );

        if (highlightId) {
          highlightIdsToRemove.push(highlightId);
          console.log("Removing highlight for:", highlightId);
        }

        // Remove the mark element and replace it with plain text.
        let parent = mark.parentNode;
        parent.replaceChild(
          document.createTextNode(mark.textContent),
          mark
        );
      }
    });

    // Now remove the corresponding records from IndexedDB (if any)
    for (const highlightId of highlightIdsToRemove) {
      try {
        await removeHighlightFromNodeChunks(highlightId);
        await removeHighlightFromHyperlights(highlightId);
      } catch (error) {
        console.error(
          `Error removing highlight ${highlightId} from IndexedDB:`,
          error
        );
      }
    }

    console.log("Removed highlight IDs:", highlightIdsToRemove);
  }
);

// IndexedDB helper to remove highlight from the "nodeChunks" table.
async function removeHighlightFromNodeChunks(highlightId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");

    // Iterate over all nodes using a cursor.
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        let node = cursor.value;
        if (node.hyperlights && Array.isArray(node.hyperlights)) {
          const originalCount = node.hyperlights.length;
          // Filter out any entry that has the highlightID we want to remove.
          node.hyperlights = node.hyperlights.filter(
            (hl) => hl.highlightID !== highlightId
          );
          if (node.hyperlights.length !== originalCount) {
            // Update record in IndexedDB if a change was made.
            cursor.update(node);
          }
        }
        cursor.continue();
      } else {
        resolve();
      }
    };

    request.onerror = (error) => {
      console.error("Error iterating nodeChunks:", error);
      reject(error);
    };

    // Also catch transactional errors.
    tx.onerror = (error) => {
      console.error("Transaction error in nodeChunks:", error);
      reject(error);
    };
  });
}

// IndexedDB helper to remove highlight directly from the "hyperlights" table.
async function removeHighlightFromHyperlights(highlightId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    // Use the index to get the primary key from the hyperlight_id field.
    const index = store.index("hyperlight_id");
    const getKeyRequest = index.getKey(highlightId);

    getKeyRequest.onsuccess = (e) => {
      const primaryKey = e.target.result;
      if (primaryKey === undefined) {
        console.warn(`No record found for highlight ${highlightId}`);
        resolve();
        return;
      }

      // Now delete the record using its primary key.
      const deleteRequest = store.delete(primaryKey);
      deleteRequest.onsuccess = () => {
        console.log(`Highlight ${highlightId} removed from hyperlights store.`);
        resolve();
      };

      deleteRequest.onerror = (error) => {
        console.error("Error deleting record from hyperlights:", error);
        reject(error);
      };
    };

    getKeyRequest.onerror = (error) => {
      console.error(
        `Error looking up primary key for highlight ${highlightId}:`,
        error
      );
      reject(error);
    };

    tx.oncomplete = () =>
      console.log("Hyperlights removal transaction complete");
    tx.onerror = (error) =>
      console.error("Transaction error in hyperlights removal:", error);
  });
}













