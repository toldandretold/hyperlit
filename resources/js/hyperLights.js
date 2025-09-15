import { book } from './app.js';
import { fetchLatestUpdateInfo, handleTimestampComparison } from "./updateCheck.js";
import { createLazyLoader, loadNextChunkFixed, loadPreviousChunkFixed } from "./lazyLoaderFactory.js";
import { ContainerManager } from "./container-manager.js";
import { navigateToInternalId } from "./scrolling.js";
import { openDatabase, 
         parseNodeId, 
         createNodeChunksKey, 
         updateBookTimestamp,
         getLibraryObjectFromIndexedDB,
         toPublicChunk,
         queueForSync } from "./cache-indexedDB.js";
import { attachAnnotationListener } from "./annotation-saver.js";
import { addPasteListener } from "./paste.js";
import { addHighlightContainerPasteListener } from "./hyperLightsListener.js";
import { getCurrentUser, getCurrentUserId } from "./auth.js";
import { getUserHighlightCache } from './userCache.js';
import { handleUnifiedContentClick, initializeHyperlitManager, openHyperlitContainer, closeHyperlitContainer } from './unified-container.js';

let highlightId; 
let highlightLazyLoader;


// Track whether document listeners are attached
let documentListenersAttached = false;


// Legacy container manager - now using unified system
let highlightManager = null;

export function initializeHighlightManager() {
  console.log("🔄 Initializing Highlight Container Manager (now using unified system)...");
  initializeHyperlitManager();
}

export function openHighlightContainer(content) {
  // Redirect to unified container
  openHyperlitContainer(content);
}

export function closeHighlightContainer() {
  // Redirect to unified container
  closeHyperlitContainer();
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

// First, refactor handleMarkClick to use a shared function
// ========= Mark Click Handler =========
export async function handleMarkClick(event) {
  // Check if the click target is actually a nested element (like <u>, <a>, etc.)
  // If so, let the unified system handle it instead of processing as a highlight
  if (event.target.tagName !== 'MARK') {
    console.log(`🎯 Click on ${event.target.tagName} inside mark - letting unified system handle`);
    return; // Let the event bubble up and be handled by unified system
  }
  
  event.preventDefault();
  
  // Grab all classes that look like HL_*
  const highlightIds = Array.from(event.target.classList).filter((cls) =>
    cls.startsWith("HL_")
  );
  if (highlightIds.length === 0) {
    console.error("❌ No highlight IDs found on mark");
    return;
  }
  
  // Check which highlights are newly created
  const newHighlightIds = event.target.getAttribute('data-new-hl');
  const newIds = newHighlightIds ? newHighlightIds.split(',') : [];
  
  console.log(`New highlight IDs: ${newIds.join(", ")}`);
  console.log(`Opening highlights: ${highlightIds.join(", ")}`);
  
  // Use unified container system
  await handleUnifiedContentClick(event.target, highlightIds, newIds);
}

// Helper function to format relative time
function formatRelativeTime(timeSince) {
  if (!timeSince) return 'prehistoric'; // Changed from '' to 'prehistoric'
  
  const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
  const diffSeconds = now - timeSince;
  
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffSeconds / 3600);
  const diffDays = Math.floor(diffSeconds / 86400);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);
  
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}min`;
  if (diffHours < 24) return `${diffHours}hr`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffWeeks < 4) return `${diffWeeks}w`;
  if (diffMonths < 12) return `${diffMonths}m`;
  return `${diffYears}y`;
}

// Legacy function - now handled by unified container system
export async function openHighlightById(
  rawIds,
  hasUserHighlight = false,
  newHighlightIds = []
) {
  // Redirect to unified system
  const highlightIds = Array.isArray(rawIds) ? rawIds : [rawIds];
  const element = document.querySelector(`mark.${highlightIds[0]}`);
  if (element) {
    await handleUnifiedContentClick(element, highlightIds, newHighlightIds);
  }
  return;
  
  // Old implementation commented out - keeping for reference
  /*
  const highlightIds = Array.isArray(rawIds) ? rawIds : [rawIds];
  const newIds = Array.isArray(newHighlightIds) ? newHighlightIds : [];
  if (highlightIds.length === 0) {
    console.error("❌ openHighlightById called with no IDs");
    return;
  }

  // Multi-ID path
  if (highlightIds.length > 1) {
    console.log(`Opening multiple highlights: ${highlightIds.join(", ")}`);
    
    // Get current user ID first
    const currentUserId = await getCurrentUserId();
    console.log("Current user ID:", currentUserId);
    
    let db;
    try {
      db = await openDatabase();
    } catch (err) {
      console.error("❌ Error opening DB:", err);
      return;
    }
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");

    // Fetch all highlights in parallel
    const reads = highlightIds.map((id) =>
      new Promise((res, rej) => {
        const req = idx.get(id);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      })
    );

    let results;
    try {
      results = await Promise.all(reads);
    } catch (err) {
      console.error("❌ Error fetching highlights:", err);
      return;
    }

    // Filter out any missing entries
    results = results.filter((r) => r);
    if (results.length === 0) {
      console.error("❌ No highlight data found for any ID");
      return;
    }

    // Build container HTML with conditional contenteditable
    let html = `<div class="scroller">\n`;
    let firstUserAnnotation = null; // Track first user annotation for cursor placement

    results.forEach((h) => {
      // Check both creator and creator_token for anonymous users
      const isUserHighlight = h.creator === currentUserId || h.creator_token === currentUserId;
      const isNewlyCreated = newIds.includes(h.hyperlight_id);
      const isEditable = isUserHighlight || isNewlyCreated;
      const authorName = h.creator || "Anon";
      const relativeTime = formatRelativeTime(h.time_since);

      console.log(
        `Highlight ${h.hyperlight_id}: creator=${h.creator}, creator_token=${h.creator_token}, currentUserId=${currentUserId}, isUserHighlight=${isUserHighlight}, isNewlyCreated=${isNewlyCreated}, isEditable=${isEditable}`
      );

      html +=
        `  <div class="author" id="${h.hyperlight_id}">\n` +
        `    <b>${authorName}</b><i class="time">・${relativeTime}</i>\n` +
        `  </div>\n`;
      html +=
        `  <blockquote class="highlight-text" contenteditable="${isEditable}" ` +
        `data-highlight-id="${h.hyperlight_id}">\n` +
        `    "${h.highlightedText}"\n` +
        `  </blockquote>\n`;
      html +=
        `  <div class="annotation" contenteditable="${isEditable}" ` +
        `data-highlight-id="${h.hyperlight_id}">\n` +
        `    ${h.annotation || ""}\n` +
        `  </div>\n` +
        `  <hr>\n`;

      // Track first user annotation for cursor placement
      if (isEditable && !firstUserAnnotation) {
        firstUserAnnotation = h.hyperlight_id;
      }
    });
    html += `</div>\n<div class="mask-bottom"></div>\n<div class="mask-top"></div>\n<div class="container-controls">\n<div class="resize-handle resize-left" title="Resize width"></div>\n<div class="drag-handle" title="Drag to move container"></div>\n<div class="resize-handle resize-right" title="Resize width"></div>\n</div>`;

    openHighlightContainer(html);

    // Attach listeners for editable highlights
    highlightIds.forEach((id) => {
      const highlight = results.find((h) => h.hyperlight_id === id);
      if (highlight) {
        const isUserHighlight = highlight.creator === currentUserId || highlight.creator_token === currentUserId;
        const isNewlyCreated = newIds.includes(id);
        const isEditable = isUserHighlight || isNewlyCreated;

        if (isEditable) {
          attachAnnotationListener(id);
          addHighlightContainerPasteListener(id);
          attachPlaceholderBehavior(id);
        }
      }
    });

    // Place cursor in first user annotation if available
    if (firstUserAnnotation) {
      setTimeout(() => {
        const annotationDiv = document.querySelector(
          `.annotation[data-highlight-id="${firstUserAnnotation}"]`
        );
        if (annotationDiv) {
          const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
          
          if (isMobile) {
            // Mobile: No auto-focus, let user manually tap to show cursor and hide placeholder
          } else {
            // Desktop approach (original)
            annotationDiv.focus();
            setTimeout(() => {
              try {
                const range = document.createRange();
                const selection = window.getSelection();
                range.selectNodeContents(annotationDiv);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
              } catch (e) {
                console.log('Range selection not supported');
              }
            }, 50);
          }
        }
      }, 150);
    }

    return;
  }

  // Single-ID path
  const highlightId = highlightIds[0];
  const isNewlyCreated = newIds.includes(highlightId);

  console.log(`Opening single highlight: ${highlightId}`);
  console.log(`Is newly created: ${isNewlyCreated}`);

  try {
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const index = store.index("hyperlight_id");

    const getRequest = index.get(highlightId);
    getRequest.onsuccess = async () => {
      const highlightData = getRequest.result;
      console.log("Found highlight data:", highlightData);
      if (!highlightData) {
        console.error("❌ No highlight data found for ID:", highlightId);
        return;
      }

      // Get current user ID inside the callback
      const currentUserId = await getCurrentUserId();
      console.log("Current user ID:", currentUserId);

      // Check both creator and creator_token for anonymous users
      const isUserHighlight = highlightData.creator === currentUserId || highlightData.creator_token === currentUserId;
      const isEditable = isUserHighlight || isNewlyCreated;

      console.log("Highlight creator:", highlightData.creator);
      console.log("Highlight creator_token:", highlightData.creator_token);
      console.log("Current user ID:", currentUserId);
      console.log("Is user highlight:", isUserHighlight);
      console.log("Is editable:", isEditable);

      const authorName = highlightData.creator || "Anon";
      const relativeTime = formatRelativeTime(highlightData.time_since);

      const containerContent = `
      <div class="scroller">
      <div class="author" id="${highlightData.hyperlight_id}">
        <b>${authorName}</b><i class="time">・${relativeTime}</i>
      </div>
      <blockquote class="highlight-text" contenteditable="${isEditable}" data-highlight-id="${highlightData.hyperlight_id}">
        "${highlightData.highlightedText}"
      </blockquote>
      <div class="annotation" contenteditable="${isEditable}" data-highlight-id="${highlightData.hyperlight_id}">
        ${highlightData.annotation || ""}
      </div>
      </div>
       <div class="mask-bottom"></div>
      <div class="mask-top"></div>
      <div class="container-controls">
        <div class="resize-handle resize-left" title="Resize width"></div>
        <div class="drag-handle" title="Drag to move container"></div>
        <div class="resize-handle resize-right" title="Resize width"></div>
      </div>
    `;

      openHighlightContainer(containerContent);

      // Only attach listeners for editable highlights
      if (isEditable) {
        console.log('🎯 Starting cursor placement for editable highlight:', highlightId);
        attachAnnotationListener(highlightId);
        addHighlightContainerPasteListener(highlightId);
        attachPlaceholderBehavior(highlightId);

        // Place cursor in annotation div
        setTimeout(() => {
          console.log('🎯 Inside setTimeout, looking for annotation div...');
          const annotationDiv = document.querySelector(
            `.annotation[data-highlight-id="${highlightId}"]`
          );
          console.log('📍 Found annotation div:', !!annotationDiv);
          if (annotationDiv) {
            const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
            console.log('📱 Is mobile device:', isMobile);
            
            if (isMobile) {
              console.log('📱 Mobile: No auto-focus, let user manually tap to show cursor and hide placeholder');
              // Don't focus on mobile - let the placeholder show and disappear when user manually taps
            } else {
              console.log('🖥️ Executing desktop branch...');
              // Desktop approach (original)
              annotationDiv.focus();
              setTimeout(() => {
                try {
                  const range = document.createRange();
                  const selection = window.getSelection();
                  range.selectNodeContents(annotationDiv);
                  range.collapse(false);
                  selection.removeAllRanges();
                  selection.addRange(range);
                } catch (e) {
                  console.log('Range selection not supported');
                }
              }, 50);
            }
          }
        }, 150);
      }

      // Rest of the existing URL hash handling code...
      const highlightContainer = document.getElementById("highlight-container");
      if (!highlightContainer) {
        console.error("❌ Highlight container element not found in DOM");
        return;
      }

      console.log("Container state:", {
        exists: !!highlightContainer,
        content: highlightContainer.innerHTML,
        isVisible: highlightContainer.classList.contains("open"),
      });

      const urlHash = window.location.hash.substring(1);
      if (urlHash && urlHash !== highlightId) {
        console.log(
          `Found URL hash: ${urlHash}, checking if it's an internal ID`
        );
        setTimeout(() => {
          const internalElement = highlightContainer.querySelector(
            `#${CSS.escape(urlHash)}`
          );
          if (internalElement) {
            console.log(`Found internal element with ID ${urlHash}`);
            const scroller = highlightContainer.querySelector(".scroller");
            if (scroller) {
              const elementRect = internalElement.getBoundingClientRect();
              const scrollerRect = scroller.getBoundingClientRect();
              const relativeTop =
                elementRect.top - scrollerRect.top + scroller.scrollTop;
              scroller.scrollTo({
                top: relativeTop - 50,
                behavior: "smooth",
              });
              internalElement.classList.add("highlight-target");
              setTimeout(() => {
                internalElement.classList.remove("highlight-target");
              }, 3000);
            }
          } else {
            console.log(
              `No element with ID ${urlHash} found inside the container`
            );
          }
        }, 300);
      }
    };
    getRequest.onerror = (event) => {
      console.error("❌ Error fetching highlight data:", event.target.error);
    };
  } catch (error) {
    console.error("❌ Error accessing IndexedDB:", error);
  }
  */
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

  let selectedText = window.getSelection().toString();
  const highlights = document.querySelectorAll('mark');
  let isOverlapping = false;

  // Check if the highlighted text overlaps with any existing highlight
  highlights.forEach(function (highlight) {
    if (
      highlight.classList.contains("user-highlight") &&
      selectedText.includes(highlight.textContent.trim())
    ) {
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

export function initializeHighlightingControls(currentBookId) {
  console.log(`💡 Initializing highlighting controls for book: ${currentBookId}`);

  // Find the UI elements within the newly loaded reader view
  const copyButton = document.getElementById("copy-hyperlight");
  const deleteButton = document.getElementById("delete-hyperlight");
  const buttonsContainer = document.getElementById("hyperlight-buttons");

  if (!copyButton || !deleteButton || !buttonsContainer) {
    console.error(
      "Highlighting UI controls not found in the DOM. Aborting initialization."
    );
    return;
  }

  // --- Attach Listeners for Showing/Hiding the Buttons ---
  // Check if document listeners are already attached
  if (!documentListenersAttached) {
    document.addEventListener("mouseup", handleSelection);
    document.addEventListener("touchend", () => setTimeout(handleSelection, 100));
    documentListenersAttached = true;
    console.log("✅ Document-level highlighting listeners attached");
  } else {
    console.log("🚫 Document-level highlighting listeners already attached, skipping");
  }

  // --- Attach Listeners for the Action Buttons ---
  // We pass the currentBookId into the handlers to avoid stale state.
  addTouchAndClickListener(copyButton, (event) =>
    createHighlightHandler(event, currentBookId)
  );
  addTouchAndClickListener(deleteButton, (event) =>
    deleteHighlightHandler(event, currentBookId)
  );

  // Prevent iOS from cancelling selection
  buttonsContainer.addEventListener("touchstart", function (event) {
    event.preventDefault();
    event.stopPropagation();
  });
  buttonsContainer.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
  });

  console.log("✅ Highlighting controls are live.");
}


async function createHighlightHandler(event, bookId) {
  let selection = window.getSelection();
  let range;
  try {
    range = selection.getRangeAt(0);
    console.log("📌 Full selected text:", selection.toString());
  } catch (error) {
    console.error("❌ Error getting range:", error);
    return;
  }

  let selectedText = selection.toString();
  if (!selectedText) {
    console.error("⚠️ No valid text selected.");
    return;
  }

  // Get containers - TARGET NUMERICAL IDS ONLY
  let startContainer =
    range.startContainer.nodeType === 3
      ? range.startContainer.parentElement.closest(
          "p, blockquote, table, h1, h2, h3, h4, h5, h6"
        )
      : range.startContainer.closest(
          "p, blockquote, table, h1, h2, h3, h4, h5, h6"
        );

  // Then verify they have numerical IDs
  if (startContainer && !isNumericalId(startContainer.id)) {
    startContainer = startContainer.closest(
      "p, blockquote, table, h1, h2, h3, h4, h5, h6"
    );
  }

  let endContainer =
    range.endContainer.nodeType === 3
      ? range.endContainer.parentElement.closest(
          "p, blockquote, table, h1, h2, h3, h4, h5, h6"
        )
      : range.endContainer.closest(
          "p, blockquote, table, h1, h2, h3, h4, h5, h6"
        );

  if (endContainer && !isNumericalId(endContainer.id)) {
    endContainer = endContainer.closest(
      "p, blockquote, table, h1, h2, h3, h4, h5, h6"
    );
  }

  // Helper function to check if an ID is numerical (including decimals)
  function isNumericalId(id) {
    if (!id) return false;
    return /^\d+(\.\d+)?$/.test(id);
  }

  if (!startContainer || !endContainer) {
    console.error("❌ Could not determine start or end block.");
    return;
  }

  const cleanStartOffset = calculateCleanTextOffset(
    startContainer,
    range.startContainer,
    range.startOffset
  );

  const cleanEndOffset = calculateCleanTextOffset(
    endContainer,
    range.endContainer,
    range.endOffset
  );

  // Generate unique highlight ID
  const highlightId = generateHighlightID();

  // Apply the highlight
  highlighter.highlightSelection("highlight");
  modifyNewMarks(highlightId);

  // Find all affected nodes
  const affectedMarks = document.querySelectorAll(`mark.${highlightId}`);
  const affectedIds = new Set();
  const updatedNodeChunks = [];

  affectedMarks.forEach((mark) => {
    const container = mark.closest(
      "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id]"
    );
    if (container && container.id) {
      affectedIds.add(container.id);
    }
  });

  // Update all affected nodes in IndexedDB
  for (const chunkId of affectedIds) {
    const isStart = chunkId === startContainer.id;
    const isEnd = chunkId === endContainer.id;

    const cleanLength = (() => {
      const textElem = document.getElementById(chunkId);
      const cleanElem = textElem.cloneNode(true);
      const marks = cleanElem.querySelectorAll("mark");
      marks.forEach((mark) => {
        mark.parentNode.replaceChild(
          document.createTextNode(mark.textContent),
          mark
        );
      });
      return cleanElem.textContent.length;
    })();

    const startOffset = isStart ? cleanStartOffset : 0;
    const endOffset = isEnd ? cleanEndOffset : cleanLength;

    const updatedNodeChunk = await updateNodeHighlight(
      bookId, // <-- MODIFIED: Pass the correct bookId
      chunkId,
      startOffset,
      endOffset,
      highlightId
    );

    if (updatedNodeChunk) {
      updatedNodeChunks.push(updatedNodeChunk);
    }
  }

  try {
    const savedHighlightEntry = await addToHighlightsTable(
      bookId, // <-- MODIFIED: Pass the correct bookId
      {
        highlightId,
        text: selectedText,
        startChar: cleanStartOffset,
        endChar: cleanEndOffset,
        startLine: startContainer.id,
      }
    );

    await updateBookTimestamp(bookId); // <-- MODIFIED: Use the correct bookId

    queueForSync("hyperlights", highlightId, "update", savedHighlightEntry);

    updatedNodeChunks.forEach((chunk) => {
      if (chunk && chunk.startLine) {
        queueForSync("nodeChunks", chunk.startLine, "update", chunk);
      }
    });

    console.log(
      `✅ Queued for sync: 1 hyperlight and ${updatedNodeChunks.length} node chunks.`
    );
  } catch (error) {
    console.error("❌ Error saving highlight metadata:", error);
  }

  attachMarkListeners();
  window.getSelection().removeAllRanges();
  document.getElementById("hyperlight-buttons").style.display = "none";
  await openHighlightById(highlightId, true, [highlightId]);
}



// In hyperLights.js

async function deleteHighlightHandler(event, bookId) {
  event.preventDefault();
  console.log("Delete button clicked.");

  let selection = window.getSelection();
  let selectedText = selection.toString();

  if (!selectedText) {
    console.error("No text selected to delete.");
    return;
  }

  const marks = document.querySelectorAll("mark");
  let highlightIdsToRemove = [];
  const affectedNodeChunks = new Set();

  marks.forEach((mark) => {
    if (selectedText.indexOf(mark.textContent.trim()) !== -1) {
      let highlightId = Array.from(mark.classList).find(
        (cls) => cls !== "highlight"
      );

      if (highlightId) {
        highlightIdsToRemove.push(highlightId);
        console.log("Removing highlight for:", highlightId);

        const container = mark.closest(
          "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id]"
        );
        if (container && container.id) {
          affectedNodeChunks.add(container.id);
        }
      }

      let parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
    }
  });

  const updatedNodeChunks = [];
  const deletedHyperlights = [];

  for (const highlightId of highlightIdsToRemove) {
    try {
      const affectedNodes = await removeHighlightFromNodeChunks(
        bookId, // <-- MODIFIED: Pass the correct bookId
        highlightId
      );
      if (affectedNodes && affectedNodes.length > 0) {
        updatedNodeChunks.push(...affectedNodes);
      }

      const deletedHyperlight = await removeHighlightFromHyperlights(
        highlightId
      );
      if (deletedHyperlight) {
        deletedHyperlights.push(deletedHyperlight);
      }
    } catch (error) {
      console.error(
        `Error removing highlight ${highlightId} from IndexedDB:`,
        error
      );
    }
  }

  if (highlightIdsToRemove.length > 0) {
    await updateBookTimestamp(bookId); // <-- MODIFIED: Use the correct bookId

    deletedHyperlights.forEach((hl) => {
      if (hl && hl.hyperlight_id) {
        queueForSync("hyperlights", hl.hyperlight_id, "delete");
      }
    });

    updatedNodeChunks.forEach((chunk) => {
      if (chunk && chunk.startLine) {
        queueForSync("nodeChunks", chunk.startLine, "update", chunk);
      }
    });

    console.log(
      `✅ Queued for sync: ${deletedHyperlights.length} deletions and ${updatedNodeChunks.length} node chunk updates.`
    );
  }
}


// Helper function to handle placeholder behavior for annotation divs
export function attachPlaceholderBehavior(highlightId) {
  const annotationDiv = document.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  );
  if (!annotationDiv) return;

  // Function to check if div is effectively empty
  const isEffectivelyEmpty = (div) => {
    return !div.textContent.trim();
  };

  // Function to update placeholder visibility
  const updatePlaceholder = () => {
    if (isEffectivelyEmpty(annotationDiv)) {
      annotationDiv.classList.add('empty-annotation');
    } else {
      annotationDiv.classList.remove('empty-annotation');
    }
  };

  // Initial check
  updatePlaceholder();

  // Update on input
  annotationDiv.addEventListener('input', updatePlaceholder);
  
  // Update on focus/blur for better UX
  annotationDiv.addEventListener('focus', updatePlaceholder);
  annotationDiv.addEventListener('blur', updatePlaceholder);
}

// Helper function to bind click and touchstart events
export function addTouchAndClickListener(element, handler) {
  // Check if we've already attached listeners to prevent duplicates
  if (element._listenersAttached) {
    console.log("🚫 Listeners already attached to element, skipping");
    return;
  }
  
  // Add a flag to prevent duplicate processing within a short time window
  let isProcessing = false;
  
  const wrappedHandler = function(event) {
    if (isProcessing) {
      console.log("🚫 Handler already processing, ignoring duplicate event");
      return;
    }
    
    isProcessing = true;
    event.preventDefault();
    event.stopPropagation();
    
    try {
      handler(event);
    } finally {
      // Reset the flag after a short delay
      setTimeout(() => {
        isProcessing = false;
      }, 1000); // 1 second cooldown
    }
  };
  
  // Add the listeners
  element.addEventListener("mousedown", wrappedHandler);
  element.addEventListener("touchstart", wrappedHandler);
  
  // Mark that we've attached listeners using a custom property
  element._listenersAttached = true;
}


function generateHighlightID() {
    let hyperLightFlag = 'HL';
    let timestamp = Date.now();
    return `${hyperLightFlag}_${timestamp}`;
}

function modifyNewMarks(highlightId) {
    const newMarks = document.querySelectorAll('mark.highlight');
    newMarks.forEach((mark, index) => {
        if (index === 0) mark.setAttribute('id', highlightId);
        
        // Add classes separately - this is the fix!
        mark.classList.add(highlightId);
        mark.classList.add('user-highlight'); // Add user-highlight class for new highlights
        mark.classList.remove('highlight');
        
        // Add data-new-hl attribute to identify this as a newly created highlight
        mark.setAttribute('data-new-hl', highlightId);
        
        // Add data-highlight-count (default to 1 for new highlights)
        const highlightCount = 1;
        mark.setAttribute('data-highlight-count', highlightCount);
        
        // Add highlight intensity (same calculation as in applyHighlights)
        const intensity = Math.min(highlightCount / 5, 1);
        mark.style.setProperty('--highlight-intensity', intensity);
    });
    console.log("✅ New highlight mark created with ID:", highlightId);
}

async function addToHighlightsTable(bookId, highlightData) {
  const db = await openDatabase();
  
  return new Promise(async (resolve, reject) => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    
    // ✅ FIXED: Get current user info for IndexedDB storage
    const user = await getCurrentUser();
    const currentUserId = await getCurrentUserId();
    
    const creator = user ? (user.name || user.username || user.email) : null;
    const creator_token = user ? null : currentUserId; // For anon users, currentUserId IS the token
    
    console.log("💾 Saving to IndexedDB with auth:", { creator, creator_token, currentUserId });
    
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
      book: bookId, // Current book ID
      hyperlight_id: highlightData.highlightId,
      highlightedText: highlightData.text, // Keep the plain text for searching
      highlightedHTML: highlightedHTML, // Store the HTML structure without mark tags
      annotation: "", // initial empty annotation
      startChar: highlightData.startChar,
      endChar: highlightData.endChar,
      startLine: highlightData.startLine,
      creator: creator,        // ✅ FIXED: Set proper creator
      creator_token: creator_token, // ✅ FIXED: Set proper creator_token
      time_since: Math.floor(Date.now() / 1000)
    };

    console.log("💾 Final highlight entry for IndexedDB:", highlightEntry);

    const addRequest = store.put(highlightEntry);

    addRequest.onsuccess = () => {
      console.log("✅ Successfully added highlight to hyperlights table"); 
      // MODIFIED: Resolve with the entry that was just saved.
      resolve(highlightEntry);
    };

    addRequest.onerror = (event) => {
      console.error("❌ Error adding highlight to hyperlights table:", event.target.error);
      reject(event.target.error);
    };
  });
}

function calculateCleanTextOffset(container, textNode, offset) {
  console.log("=== calculateCleanTextOffset Debug ===");
  console.log("Target textNode:", textNode);
  console.log("Target offset:", offset);
  console.log("Target textNode content:", `"${textNode.textContent}"`);
  
  // Create a range from the start of container to the target position
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(textNode, offset);
  
  // Get the text content of this range - this automatically strips HTML
  const rangeText = range.toString();
  console.log("Range text:", `"${rangeText}"`);
  
  // The clean offset is simply the length of the range text
  const cleanOffset = rangeText.length;
  
  console.log(`Clean offset calculated: ${cleanOffset}`);
  
  // Verification: create clean container to double-check
  const cleanContainer = container.cloneNode(true);
  const marks = cleanContainer.querySelectorAll('mark');
  marks.forEach(mark => {
    mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
  });
  const cleanText = cleanContainer.textContent;
  console.log(`Verification - clean text at offset: "${cleanText.substring(0, cleanOffset)}"`);
  
  return cleanOffset;
}




// new signature — takes chunkId as a string (e.g. "1.1")
async function updateNodeHighlight(
  bookId,
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
    const key = createNodeChunksKey(bookId, chunkId);
    console.log("Looking up with key:", key);
    
    const getRequest = store.get(key);

    getRequest.onsuccess = () => {
      const node = getRequest.result;
      let updatedNode; // 👈 ADD: Variable to track the updated node
      
      if (!node) {
        console.warn(`No nodeChunks record for key [${book}, ${chunkId}]`);
        
        // Create a new node if it doesn't exist
        updatedNode = {
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
        
        const putReq = store.put(updatedNode);
        putReq.onsuccess = () => {
          console.log(`Created new node for [${book}, ${chunkId}]`);
          resolve(updatedNode); // 👈 RETURN the new node
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
      
      updatedNode = node; // 👈 SET: The updated node
      
      const putReq = store.put(updatedNode);
      putReq.onsuccess = () => {
        console.log(`Updated node [${book}, ${chunkId}] with highlight`);
        resolve(updatedNode); // 👈 RETURN the updated node
      };
      putReq.onerror = e => reject(e.target.error);
    };

    getRequest.onerror = e => reject(e.target.error);
  });
}


// IndexedDB helper to remove highlight from the "nodeChunks" table.
async function removeHighlightFromNodeChunks(bookId, highlightId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    const updatedNodes = []; 
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        let node = cursor.value;
        if (node.book === bookId && node.hyperlights && Array.isArray(node.hyperlights)) {
          const originalCount = node.hyperlights.length;
          // Filter out any entry that has the highlightID we want to remove.
          node.hyperlights = node.hyperlights.filter(
            (hl) => hl.highlightID !== highlightId
          );
          if (node.hyperlights.length !== originalCount) {
            // Update record in IndexedDB if a change was made.
            cursor.update(node);
            // 👈 ADD: Store the updated node for API sync
            updatedNodes.push(node);
            console.log(`Removed highlight ${highlightId} from node [${node.book}, ${node.startLine}]`);
          }
        }
        cursor.continue();

      } else {
        // 👈 CHANGE: Resolve with the updated nodes array
        console.log(`Highlight ${highlightId} removal complete. Updated ${updatedNodes.length} nodes.`);
        resolve(updatedNodes);
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
    let deletedHyperlight = null; // 👈 ADD: Track deleted hyperlight
    
    // Use the index to get the primary key from the hyperlight_id field.
    const index = store.index("hyperlight_id");
    const getKeyRequest = index.getKey(highlightId);

    getKeyRequest.onsuccess = (e) => {
      const primaryKey = e.target.result;
      if (primaryKey === undefined) {
        console.warn(`No record found for highlight ${highlightId}`);
        resolve(null); // 👈 CHANGE: Return null instead of undefined
        return;
      }

      // 👈 ADD: Get the full record before deleting it
      const getRecordRequest = store.get(primaryKey);
      getRecordRequest.onsuccess = (event) => {
        deletedHyperlight = event.target.result;
        
        // Now delete the record using its primary key.
        const deleteRequest = store.delete(primaryKey);
        deleteRequest.onsuccess = () => {
          console.log(`Highlight ${highlightId} removed from hyperlights store.`);
          // 👈 CHANGE: Resolve with the deleted hyperlight data
          resolve(deletedHyperlight);
        };

        deleteRequest.onerror = (error) => {
          console.error("Error deleting record from hyperlights:", error);
          reject(error);
        };
      };

      getRecordRequest.onerror = (error) => {
        console.error("Error getting record before deletion:", error);
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

/**
 * Delete a highlight by ID (for use by delete button)
 */
export async function deleteHighlightById(highlightId) {
  try {
    console.log(`🗑️ Deleting highlight by ID: ${highlightId}`);
    
    // Get the highlight data first to determine the book
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");
    
    const getRequest = idx.get(highlightId);
    const highlightData = await new Promise((resolve, reject) => {
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
    });
    
    if (!highlightData) {
      throw new Error(`Highlight not found: ${highlightId}`);
    }
    
    const bookId = highlightData.book;
    console.log(`📚 Found highlight in book: ${bookId}`);
    
    // Remove the highlight class from DOM marks, but preserve other classes
    const markElements = document.querySelectorAll(`mark.${highlightId}`);
    const affectedNodeIds = new Set();
    
    markElements.forEach(mark => {
      // Remove just this highlight's class
      mark.classList.remove(highlightId);
      
      // If this was the main mark (with id), remove the id too
      if (mark.id === highlightId) {
        mark.removeAttribute('id');
      }
      
      // If no more highlight classes remain, remove the mark entirely
      const remainingHighlights = Array.from(mark.classList).filter(cls => cls.startsWith('HL_'));
      
      if (remainingHighlights.length === 0) {
        // No more highlights on this mark - replace with text
        const parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      } else {
        // Still has other highlights - just update the styling
        console.log(`Mark still has highlights: ${remainingHighlights.join(', ')}`);
        // Update highlight count and intensity if needed
        const highlightCount = remainingHighlights.length;
        mark.setAttribute('data-highlight-count', highlightCount);
        const intensity = Math.min(highlightCount / 5, 1);
        mark.style.setProperty('--highlight-intensity', intensity);
      }
      
      // Track which nodes were affected for re-applying highlights
      const container = mark.closest('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id]');
      if (container && container.id) {
        affectedNodeIds.add(container.id);
      }
    });
    
    // Remove from IndexedDB
    const affectedNodes = await removeHighlightFromNodeChunks(bookId, highlightId);
    const deletedHyperlight = await removeHighlightFromHyperlights(highlightId);
    
    // Update book timestamp
    await updateBookTimestamp(bookId);
    
    // Queue for server sync
    if (deletedHyperlight) {
      queueForSync("hyperlights", highlightId, "delete");
    }
    
    affectedNodes.forEach((chunk) => {
      if (chunk && chunk.startLine) {
        queueForSync("nodeChunks", chunk.startLine, "update", chunk);
      }
    });
    
    console.log(`✅ Successfully deleted highlight: ${highlightId}`);
    console.log(`📝 Affected nodes: ${Array.from(affectedNodeIds).join(', ')}`);
    
    return {
      success: true,
      affectedNodes: Array.from(affectedNodeIds),
      deletedHighlight: deletedHyperlight
    };
    
  } catch (error) {
    console.error(`❌ Error deleting highlight ${highlightId}:`, error);
    throw error;
  }
}

/**
 * Hide a highlight by ID - same as delete but syncs as hide operation
 * Removes from IndexedDB and DOM but sets hidden=true in database instead of deleting
 */
export async function hideHighlightById(highlightId) {
  console.log(`🙈 Hiding highlight by ID: ${highlightId}`);
  
  try {
    // Get the highlight data first to determine the book
    const { openDatabase } = await import('./cache-indexedDB.js');
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");
    
    const getRequest = idx.get(highlightId);
    let highlightData = null;
    
    await new Promise((resolve, reject) => {
      getRequest.onsuccess = () => {
        highlightData = getRequest.result;
        resolve();
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
    
    if (!highlightData) {
      throw new Error(`Highlight not found: ${highlightId}`);
    }
    
    const bookId = highlightData.book;
    console.log(`📚 Found highlight in book: ${bookId}`);
    
    // Remove the highlight class from DOM marks, but preserve other classes (same as delete)
    const markElements = document.querySelectorAll(`mark.${highlightId}`);
    const affectedNodeIds = new Set();
    
    markElements.forEach(mark => {
      // Remove just this highlight's class
      mark.classList.remove(highlightId);
      
      // If this was the main mark (with id), remove the id too
      if (mark.id === highlightId) {
        mark.removeAttribute('id');
      }
      
      // If no more highlight classes remain, remove the mark entirely
      const remainingHighlights = Array.from(mark.classList).filter(cls => cls.startsWith('HL_'));
      
      if (remainingHighlights.length === 0) {
        // No more highlights on this mark - replace with text
        const parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      } else {
        // Still has other highlights - just update the styling
        console.log(`Mark still has highlights: ${remainingHighlights.join(', ')}`);
        // Update highlight count and intensity if needed
        const highlightCount = remainingHighlights.length;
        mark.setAttribute('data-highlight-count', highlightCount);
        const intensity = Math.min(highlightCount / 5, 1);
        mark.style.setProperty('--highlight-intensity', intensity);
      }
      
      // Track which nodes were affected for re-applying highlights
      const container = mark.closest('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id]');
      if (container && container.id) {
        affectedNodeIds.add(container.id);
      }
    });
    
    // For hide: Only remove from IndexedDB locally, DON'T touch PostgreSQL nodeChunks
    // Remove from local IndexedDB hyperlights table
    const hiddenHyperlight = await removeHighlightFromHyperlights(highlightId);
    
    // Remove from local IndexedDB nodeChunks (but don't sync this change to PostgreSQL)
    await removeHighlightFromNodeChunks(bookId, highlightId);
    
    // Update book timestamp locally
    const { updateBookTimestamp } = await import('./cache-indexedDB.js');
    await updateBookTimestamp(bookId);
    
    // Queue ONLY the hide operation for sync to PostgreSQL - no nodeChunk updates
    const { queueForSync } = await import('./cache-indexedDB.js');
    if (hiddenHyperlight) {
      // Pass the highlight data for the sync to work
      queueForSync("hyperlights", highlightId, "hide", hiddenHyperlight);
    }
    
    // DON'T queue nodeChunk updates - PostgreSQL nodeChunks should keep the highlight data
    
    console.log(`✅ Successfully hidden highlight: ${highlightId}`);
    console.log(`📝 Affected nodes: ${Array.from(affectedNodeIds).join(', ')}`);
    
    return {
      success: true,
      affectedNodes: Array.from(affectedNodeIds),
      hiddenHighlight: hiddenHyperlight
    };
    
  } catch (error) {
    console.error(`❌ Error hiding highlight ${highlightId}:`, error);
    throw error;
  }
}

/**
 * Re-processes highlights for specific affected nodes after highlight deletion
 * This ensures overlapping highlights are correctly recalculated and displayed
 */
export async function reprocessHighlightsForNodes(bookId, affectedNodeIds) {
  console.log(`🔄 Reprocessing highlights for nodes:`, affectedNodeIds);
  
  try {
    const { getNodeChunksFromIndexedDB } = await import('./cache-indexedDB.js');
    const { applyHighlights } = await import('./lazyLoaderFactory.js');
    
    // Get the updated node chunks which should have the correct hyperlights after deletion
    const nodeChunks = await getNodeChunksFromIndexedDB(bookId);
    
    // Process each affected node
    for (const nodeId of affectedNodeIds) {
      const nodeElement = document.getElementById(nodeId);
      if (!nodeElement) {
        console.warn(`Node ${nodeId} not found in DOM`);
        continue;
      }
      
      // Find the node data with its current highlights
      const nodeData = nodeChunks.find(chunk => chunk.startLine == nodeId);
      if (!nodeData) {
        console.warn(`Node data not found for ${nodeId}`);
        continue;
      }
      
      // Get highlights that apply to this node from the node data
      const nodeHighlights = nodeData.hyperlights || [];
      
      console.log(`Node ${nodeId} has ${nodeHighlights.length} remaining highlights after deletion`);
      
      if (nodeHighlights.length === 0) {
        // No highlights left - just remove all marks
        const existingMarks = nodeElement.querySelectorAll('mark[class*="HL_"]');
        existingMarks.forEach(mark => {
          const parent = mark.parentNode;
          parent.replaceChild(document.createTextNode(mark.textContent), mark);
          parent.normalize();
        });
        console.log(`No highlights remaining for node ${nodeId} - removed all marks`);
        continue;
      }
      
      // Get the plain text content by removing existing marks
      let plainText = nodeElement.textContent || '';
      
      // Remove all existing marks from this node
      const existingMarks = nodeElement.querySelectorAll('mark[class*="HL_"]');
      existingMarks.forEach(mark => {
        const parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      });
      
      // Get the clean HTML and re-apply highlights with correct segmentation
      const cleanHtml = nodeElement.innerHTML;
      console.log(`Applying highlights to clean HTML for node ${nodeId}:`, nodeHighlights.map(h => h.highlightID));
      const newHtml = applyHighlights(cleanHtml, nodeHighlights, bookId);
      
      console.log(`Original HTML length: ${cleanHtml.length}, New HTML length: ${newHtml.length}`);
      console.log(`Clean HTML: ${cleanHtml.substring(0, 100)}...`);
      console.log(`New HTML: ${newHtml.substring(0, 100)}...`);
      
      nodeElement.innerHTML = newHtml;
      
      // Verify the highlights were applied
      const appliedMarks = nodeElement.querySelectorAll('mark[class*="HL_"]');
      console.log(`✅ Reprocessed highlights for node ${nodeId}: ${nodeHighlights.length} highlights, ${appliedMarks.length} marks applied`);
    }
    
    // Re-attach mark listeners to the new elements
    attachMarkListeners();
    
    console.log(`✅ Completed reprocessing highlights for ${affectedNodeIds.length} nodes`);
    
  } catch (error) {
    console.error(`❌ Error reprocessing highlights:`, error);
    throw error;
  }
}










