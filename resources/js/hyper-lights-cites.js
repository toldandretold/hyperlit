/* LOGIC of highlighting: 

1. on highlighting a range of text, a unique highlight_id is generated. it is added as a 
id= and class= on the first mark tag and only as a class= on any others. this ensures mark tags
are added to multiple html nodes, without id being duplicated.

 */


import {
    mainContentDiv,
    book
} from './app.js';

import { fetchLatestUpdateInfo, handleTimestampComparison } from "./updateCheck.js";


import { createLazyLoader,
         loadNextChunkFixed,
         loadPreviousChunkFixed
       } from "./lazyLoaderFactory.js";

import { ContainerManager } from "./container-manager.js";

import { navigateToInternalId } from "./scrolling.js";  // or the correct path

import {
  openDatabase,
  // Other IndexedDB helper functions as needed.
} from "./cache-indexedDB.js";

 
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

/*async function fetchHighlightChunksOnDemand(book) {
  const updateInfo = await fetchLatestUpdateInfo(book);
  // Read the cached timestamp from localStorage
  const cachedTimestamp =
    localStorage.getItem("highlightChunksLastModified") || "null";

  // Assume latest_update.json now includes a property “highlightChunksLastModified”
  const serverTimestamp =
    updateInfo && updateInfo.highlightChunksLastModified
      ? updateInfo.highlightChunksLastModified.toString()
      : "null";

  console.log(
    "✅ Server reported highlightChunksLastModified:",
    serverTimestamp
  );

  if (serverTimestamp !== cachedTimestamp) {
    console.log("Highlight chunks timestamp is DIFFERENT. Updating cache.");
    localStorage.setItem("highlightChunksLastModified", serverTimestamp);
  } else {
    console.log("Highlight chunks timestamp unchanged.");
  }

  // Now load the highlightChunks.json file
  const resourcePath = `/markdown/${book}/highlightChunks.json`;
  const response = await fetch(resourcePath);
  if (!response.ok) {
    throw new Error(`Failed to load highlightChunks from ${resourcePath}`);
  }
  return response.json();
}*/




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
        <blockquote class="highlight-text">
          "${highlightData.highlightedHTML}"
        </blockquote>
        <div class="annotation">
          <p class="temp-text" data-placeholder="Annotate at will...">${highlightData.annotation || ""}</p>
        </div>
      `;

      // Open container with content directly
      openHighlightContainer(containerContent);

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


/**
 * Recursively determine the offsetTop of an element relative to a
 * container element.
 *
 * @param {HTMLElement} element The target element.
 * @param {HTMLElement} container The container element.
 * @returns {number} Distance in pixels from the top of the container.
 */
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
        let selectedText = window.getSelection().toString().trim();
        const highlights = document.querySelectorAll('mark');
        let isOverlapping = false;

        // Check if the highlighted text overlaps with any existing highlight
        highlights.forEach(function(highlight) {
            if (selectedText.includes(highlight.textContent.trim())) {
                isOverlapping = true;
            }
        });

        if (selectedText.length > 0) {
            console.log('Showing buttons. Selected text:', selectedText);

            // Get the bounding box of the selected text to position buttons near it
            const selection = window.getSelection();
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();

            // Position the buttons near the selected text, but far from iOS context menu
            const buttons = document.getElementById('hyperlight-buttons');
            buttons.style.display = 'block';

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
                console.log('Detected overlapping highlight');
                document.getElementById('delete-hyperlight').style.display = 'block';
            } else {
                console.log('No overlapping highlight detected');
                document.getElementById('delete-hyperlight').style.display = 'none';
            }
        } else {
            console.log('No text selected. Hiding buttons.');
            document.getElementById('hyperlight-buttons').style.display = 'none';
            document.getElementById('delete-hyperlight').style.display = 'none';
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
  element.addEventListener("click", function (event) {
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

    // Function to handle creating a highlight
// Functions to handle creating a highlight



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
      url: window.location.href, // current page URL
      container: highlightData.container,
      book: book, // or however you determine the book
      hyperlight_id: highlightData.highlightId,
      highlightedText: highlightData.text, // Keep the plain text for searching
      highlightedHTML: highlightedHTML, // Store the HTML structure without mark tags
      annotation: "", // initial empty annotation
      startChar: highlightData.startChar,
      endChar: highlightData.endChar,
      startLine: highlightData.startLine
    };

    const addRequest = store.add(highlightEntry);

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


//4a. NEW function: Updates the container node in indexedDB:
  

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

    // IMPORTANT: Ensure we update the start container first
    console.log("Updating start container:", startContainer.id);
    if (startContainer === endContainer) {
      // Single node case
      await updateNodeHighlight(startContainer, trueStartOffset, trueEndOffset);
      console.log(`Updated single node ${startContainer.id} with offsets:`, { start: trueStartOffset, end: trueEndOffset });
    } else {
      // Multi-node case - handle start container
      await updateNodeHighlight(startContainer, trueStartOffset, startContainer.textContent.length);
      console.log(`Updated start node ${startContainer.id} with offsets:`, { start: trueStartOffset, end: startContainer.textContent.length });
      
      // Handle end container
      await updateNodeHighlight(endContainer, 0, trueEndOffset);
      console.log(`Updated end node ${endContainer.id} with offsets:`, { start: 0, end: trueEndOffset });
    }

    // Find all nodes that contain marks with this highlightId
    const affectedMarks = document.querySelectorAll(`mark.${highlightId}`);
    const affectedNodes = new Set();

    // Collect all unique container nodes that have our highlight
    affectedMarks.forEach(mark => {
      // Only look for specific container elements, not any element with an ID
      const container = mark.closest("p, h1, h2, h3, h4, h5, h6, blockquote, table");
      if (container && container.id) {
        affectedNodes.add(container);
      }
    });

    
    console.log("All affected nodes:", Array.from(affectedNodes).map(node => node.id));
    
    // Process middle nodes (excluding start and end containers)
    for (const node of affectedNodes) {
      // Skip start and end containers as we've already processed them
      if (node === startContainer || node === endContainer) continue;
      
      const nodeId = parseInt(node.getAttribute("id"), 10);
      if (isNaN(nodeId)) continue;
      
      // Middle node - highlight the whole thing
      await updateNodeHighlight(node, 0, node.textContent.length);
      console.log(`Updated middle node ${node.id} with offsets:`, { start: 0, end: node.textContent.length });
    }

    try {
      await addToHighlightsTable({
        container: startContainer.id,
        highlightId: highlightId,
        text: selectedText,
        startChar: trueStartOffset,
        endChar: trueEndOffset,
        startLine: parseInt(startContainer.getAttribute("id"), 10)
      });
      console.log("Added to highlights table with data:", {
        container: startContainer.id,
        highlightId: highlightId,
        text: selectedText,
        startChar: trueStartOffset,
        endChar: trueEndOffset
      });
    } catch (error) {
      console.error("❌ Error saving highlight metadata:", error);
    }

    attachMarkListeners();

      async function updateNodeHighlight(
      containerNode,
      highlightStartOffset,
      highlightEndOffset
    ) {
      const db = await openDatabase();

      return new Promise((resolve, reject) => {
        //Encase everything into a Promise Pattern for resolving outside the function
        const tx = db.transaction("nodeChunks", "readwrite");
        const store = tx.objectStore("nodeChunks");
        const startLine = parseInt(containerNode.getAttribute("id"), 10);

        if (isNaN(startLine)) {
          console.error("❌ Invalid node line id on", containerNode);
          reject(null);
          return;
        }

        // Our keyPath is startLine, so we can access the node by id:
        const getRequest = store.get(startLine);

        getRequest.onsuccess = () => {
          const node = getRequest.result;
          if (!node) {
            console.warn("Could not find node in IDB");
            resolve(null);
            return;
          }

          //Add the highlight info to the node
          if (!node.hyperlights) {
            node.hyperlights = [];
          }

          const existingHighlight = node.hyperlights.find(
            highlight => highlight.highlightID === highlightId
          );

          if (!existingHighlight) {
            node.hyperlights.push({
              highlightID: highlightId,
              charStart: highlightStartOffset,
              charEnd: highlightEndOffset
            });
          }

          console.log(
            `Highlight added to IndexedDB for node with id: ${node.startLine}`
          );
          //Update IDB with the updated node:
          const putRequest = store.put(node);

          putRequest.onsuccess = () => {
            console.log(
              `✅ Updated IndexedDB with hyperlight for node with id: ${node.startLine}`
            );
            resolve();
          };
          putRequest.onerror = event => {
            console.error(
              `❌ Error updating IndexedDB with hyperlight for node with id: ${node.startLine}`,
              event.target.error
            );
            reject(event.target.error);
          };
        };
        getRequest.onerror = () => {
          console.error(`Error getting Node from IndexedDB ${startLine}`);
          reject(getRequest.error);
        };

        tx.oncomplete = () => console.log("Transaction Complete");
        tx.onerror = error => console.warn("Transaction Error", error);
      });
    }
  }

);


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
        // Get the unique highlight id from the mark’s classes.
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

//------------------------------------------------------
// IndexedDB helper to remove highlight from the "nodeChunks" table.
// It iterates all nodes and removes any hyperlight objects with a matching highlightID.
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

//------------------------------------------------------
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








   
    // Find the nearest ancestor with a numerical ID
    function findParentWithNumericalId(element) {
      let current = element;
      while (current) {
        if (current.hasAttribute("id") && !isNaN(parseInt(current.id, 10))) {
          return current; // Return the element
        }
        current = current.parentElement;
      }
      return null;
    }

  


    // Helper functions: getXPath, getFullXPath, normalizeXPath
    function getXPath(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            node = node.parentNode;
        }
        if (node.id !== '') {
            return 'id("' + node.id + '")';
        }
        if (node === document.body) {
            return '/html/' + node.tagName.toLowerCase();
        }
        let ix = 0;
        let siblings = node.parentNode.childNodes;
        for (let i = 0; i < siblings.length; i++) {
            let sibling = siblings[i];
            if (sibling === node) {
                return getXPath(node.parentNode) + '/' + node.tagName.toLowerCase() + '[' + (ix + 1) + ']';
            }
            if (sibling.nodeType === 1 && sibling.tagName === node.tagName) {
                ix++;
            }
        }
    }

    function getFullXPath(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            node = node.parentNode;
        }
        let fullXPath = '';
        while (node !== document.body) {
            let tagName = node.tagName.toLowerCase();
            let index = Array.prototype.indexOf.call(node.parentNode.children, node) + 1;
            fullXPath = '/' + tagName + '[' + index + ']' + fullXPath;
            node = node.parentNode;
        }
        return '/html' + fullXPath;
    }

    function normalizeXPath(xpath) {
        const regex = /^id\(".*?"\)\/div\[1\]/;
        return xpath.replace(regex, '');
    }


  

// Function to generate a unique hypercite ID
function generateHyperciteID() {
    return 'hypercite_' + Math.random().toString(36).substring(2, 9); // Unique ID generation
}

// Fallback copy function: Standard copy if HTML format isn't supported
function fallbackCopyText(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy'); // Fallback copy for plain text
    } catch (err) {
        console.error('Fallback: Unable to copy text', err);
    }
    document.body.removeChild(textArea);
}



function collectHyperciteData(hyperciteId, wrapper) {
    console.log("Wrapper outerHTML:", wrapper.outerHTML);

    // Use the iterative method to find a parent with a numerical ID
    let parentElement = findParentWithNumericalId(wrapper);

    if (!parentElement) {
        console.error("No valid parent element with a numerical ID found for the <u> tag:", wrapper.outerHTML);
        return [];
    }

    return [
        {
            id: parentElement.id, // The parent element's ID
            html: parentElement.outerHTML, // Full outer HTML of the parent
            hypercite_id: wrapper.id // The hypercite ID
        }
    ];
}



function wrapSelectedTextInDOM(hyperciteId, book) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        console.error("No valid selection found for hypercite.");
        return;
    }
    const range = selection.getRangeAt(0);
    let parent = range.startContainer.parentElement;
    while (parent && !parent.hasAttribute('id')) {
        parent = parent.parentElement; // Traverse up to find a parent with an ID
    }
    if (!parent || isNaN(parseInt(parent.id, 10))) {
        console.error("No valid parent with numerical ID found.");
        return;
    }
    const wrapper = document.createElement('u');
    wrapper.setAttribute('id', hyperciteId);
    try {
        range.surroundContents(wrapper);
    } catch (e) {
        console.error("Error wrapping selected text:", e);
        return;
    }
    const blocks = collectHyperciteData(hyperciteId, wrapper);
    sendHyperciteBlocksToBackend(book, hyperciteId, blocks);
    attachMarkListeners();
    setTimeout(() => selection.removeAllRanges(), 50);
}   



// Send hypercite blocks to the backend
function sendHyperciteBlocksToBackend(book, hyperciteId, blocks) {
    fetch('/save-hypercite-blocks', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({
            book: book,
            hypercite_id: hyperciteId,
            blocks: blocks // Array of block-level IDs, HTML content, and hypercite IDs
        })
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
            console.log('✅ Hypercite blocks saved and Markdown updated.');

        
        } else {
            console.error('❌ Error from server:', data.message);
        }
    })
    .catch(error => {
        console.error('❌ Error saving hypercite blocks:', error);
    });
}

// Event listener for copying text and creating a hypercite

document.addEventListener("copy", event => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return; // Do nothing if no text is selected
  }

  const hyperciteId = generateHyperciteID();

  if (!book) {
    console.error("Book identifier not found.");
    return;
  }

  // Get the current site URL
  const currentSiteUrl = `${window.location.origin}`; // E.g., "https://thissite.com"
  const citationIdA = book; // Assign 'book' to 'citation_id_a'
  const hypercitedText = selection.toString(); // The actual text being copied
  const hrefA = `${currentSiteUrl}/${citationIdA}#${hyperciteId}`; // Construct href_a dynamically

  // Extract plain text from the selection
  const selectedText = selection.toString().trim(); // Plain text version of selected content

  // Create the HTML and plain text for the clipboard, including the full URL
  const clipboardHtml = `"${selectedText}"<a href="${hrefA}">[:]</a>`;
  const clipboardText = `"${selectedText}" [[:]](${hrefA})`;

  // Set clipboard data
  event.clipboardData.setData("text/html", clipboardHtml);
  event.clipboardData.setData("text/plain", clipboardText);
  event.preventDefault(); // Prevent default copy behavior

  // Wrap the selected text in the DOM and send data to the backend
  wrapSelectedTextInDOM(hyperciteId, citationIdA);
  saveHyperciteData(citationIdA, hyperciteId, hypercitedText, hrefA);
  if (selection) {
    selection.removeAllRanges(); // Clear out the ranges.
    console.log("All highlight ranges removed");
  }
});



// Function to save hypercite metadata to the server
function saveHyperciteData(citation_id_a, hypercite_id, hypercited_text, href_a) {
    fetch(`/save-hypercite`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        },
        body: JSON.stringify({
            citation_id_a: citation_id_a,
            hypercite_id: hypercite_id,
            hypercited_text: hypercited_text,
            href_a: href_a // Use the updated column name
        })
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                console.log('Hypercite data saved successfully');
            } else {
                console.error('Error saving hypercite data:', data.error);
            }
        })
        .catch(error => {
            console.error('Error saving hypercite data:', error);
        });
}




// [edit] button

// Function to get the full DOM path of the element in view
function getDomPath(element) {
    let path = [];
    while (element && element.nodeType === Node.ELEMENT_NODE) {
        let selector = element.nodeName.toLowerCase();
        if (element.id) {
            selector += `#${element.id}`;
            path.unshift(selector);
            break;
        } else {
            let sibling = element;
            let siblingIndex = 1;
            while ((sibling = sibling.previousElementSibling)) {
                if (sibling.nodeName.toLowerCase() === selector) siblingIndex++;
            }
            selector += `:nth-of-type(${siblingIndex})`;
        }
        path.unshift(selector);
        element = element.parentNode;
    }
    return path.join(" > ");
}

// Save position on refresh or navigation away
window.addEventListener('beforeunload', function () {
    const elementInView = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const domPath = getDomPath(elementInView);
    localStorage.setItem('originalReadPath', domPath);
    console.log("Updated originalReadPath on refresh:", domPath);
});

// Save original read position when clicking "edit" button
document.getElementById('editButton').addEventListener('click', function () {
    const elementInView = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const domPath = getDomPath(elementInView);

    // Save and log the original path for returning from edit mode
    localStorage.setItem('originalReadPath', domPath);
    console.log("Saved originalReadPath on edit:", domPath);

    // Redirect to the editable page
    window.location.href = `/${book}/div`; // Adjust URL as needed
});