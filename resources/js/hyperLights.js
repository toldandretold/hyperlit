import { book } from './app.js';
import { fetchLatestUpdateInfo, handleTimestampComparison } from "./updateCheck.js";
import { createLazyLoader, loadNextChunkFixed, loadPreviousChunkFixed } from "./lazyLoaderFactory.js";
import { ContainerManager } from "./container-manager.js";
import { navigateToInternalId } from "./scrolling.js";
import { openDatabase, 
         parseNodeId, 
         createNodeChunksKey, 
         updateBookTimestamp,
         getLibraryObjectFromIndexedDB } from "./cache-indexedDB.js";
import { attachAnnotationListener } from "./annotation-saver.js";
import { addPasteListener } from "./paste.js";
import { addHighlightContainerPasteListener } from "./hyperLightsListener.js";
import { syncIndexedDBtoPostgreSQL } from "./postgreSQL.js";
import { getCurrentUser, getAuthorId, getCurrentUserId } from "./auth.js";
import { getUserHighlightCache } from './userCache.js';

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

// First, refactor handleMarkClick to use a shared function
// ========= Mark Click Handler =========
export async function handleMarkClick(event) {
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
  
  const hasUserHighlight = event.target.classList.contains("user-highlight");
  
  console.log(`Mark has user-highlight class: ${hasUserHighlight}`);
  console.log(`New highlight IDs: ${newIds.join(", ")}`);
  console.log(`Opening highlights: ${highlightIds.join(", ")}`);
  
  // Pass the new highlight IDs
  await openHighlightById(highlightIds, hasUserHighlight, newIds);
}

// ========= Single/Multi-ID Opener =========
// Accepts either a single string or an array of strings.
// ========= Single/Multi-ID Opener =========
// Accepts either a single string or an array of strings, plus user highlight status
// Helper function to format relative time
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

export async function openHighlightById(
  rawIds,
  hasUserHighlight = false,
  newHighlightIds = []
) {
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
          annotationDiv.focus();
          // Place cursor at end of content
          const range = document.createRange();
          const selection = window.getSelection();
          range.selectNodeContents(annotationDiv);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }, 100);
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
        attachAnnotationListener(highlightId);
        addHighlightContainerPasteListener(highlightId);

        // Place cursor in annotation div
        setTimeout(() => {
          const annotationDiv = document.querySelector(
            `.annotation[data-highlight-id="${highlightId}"]`
          );
          if (annotationDiv) {
            annotationDiv.focus();
            // Place cursor at end of content
            const range = document.createRange();
            const selection = window.getSelection();
            range.selectNodeContents(annotationDiv);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }, 100);
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
export function addTouchAndClickListener(element, handler) {
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
      startLine: highlightData.startLine,
      creator: highlightData.creator || null,
      creator_token: highlightData.creator_token || null,
      time_since: Math.floor(Date.now() / 1000)
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

/*
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
} */

addTouchAndClickListener(
  document.getElementById("copy-hyperlight"),
  async function() {
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

    // Get containers - TARGET NUMERICAL IDS ONLY
    let startContainer = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement.closest("p, blockquote, table, h1, h2, h3, h4, h5, h6")
      : range.startContainer.closest("p, blockquote, table, h1, h2, h3, h4, h5, h6");

    // Then verify they have numerical IDs
    if (startContainer && !isNumericalId(startContainer.id)) {
      startContainer = startContainer.closest("p, blockquote, table, h1, h2, h3, h4, h5, h6");
    }

    let endContainer = range.endContainer.nodeType === 3
      ? range.endContainer.parentElement.closest("p, blockquote, table, h1, h2, h3, h4, h5, h6")
      : range.endContainer.closest("p, blockquote, table, h1, h2, h3, h4, h5, h6");

    if (endContainer && !isNumericalId(endContainer.id)) {
      endContainer = endContainer.closest("p, blockquote, table, h1, h2, h3, h4, h5, h6");
    }

    // Helper function to check if an ID is numerical (including decimals)
    function isNumericalId(id) {
      if (!id) return false;
      return /^\d+(\.\d+)?$/.test(id);
    }

    console.log("=== CONTAINER DEBUG ===");
    console.log("range.startContainer:", range.startContainer);
    console.log("range.startContainer.nodeType:", range.startContainer.nodeType);
    console.log("range.startContainer.parentElement:", range.startContainer.parentElement);
    console.log("startContainer:", startContainer);
    console.log("startContainer.id:", startContainer?.id);

    console.log("range.endContainer:", range.endContainer);
    console.log("range.endContainer.nodeType:", range.endContainer.nodeType);
    console.log("range.endContainer.parentElement:", range.endContainer.parentElement);
    console.log("endContainer:", endContainer);
    console.log("endContainer.id:", endContainer?.id);

    console.log("startContainer === endContainer:", startContainer === endContainer);

    if (!startContainer || !endContainer) {
      console.error("❌ Could not determine start or end block.");
      return;
    }
    
    // Calculate offsets based on CLEAN text (without existing marks)
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

    console.log("Clean text offsets:", { start: cleanStartOffset, end: cleanEndOffset });

    // CALCULATE CLEAN LENGTHS BEFORE APPLYING HIGHLIGHTS
    const startContainerCleanLength = (() => {
      const cleanElem = startContainer.cloneNode(true);
      const marks = cleanElem.querySelectorAll('mark');
      marks.forEach(mark => {
        mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
      });
      return cleanElem.textContent.length;
    })();

    const endContainerCleanLength = (() => {
      const cleanElem = endContainer.cloneNode(true);
      const marks = cleanElem.querySelectorAll('mark');
      marks.forEach(mark => {
        mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
      });
      return cleanElem.textContent.length;
    })();

    // VERIFICATION CODE
    console.log("=== VERIFICATION ===");
    const startCleanContainer = startContainer.cloneNode(true);
    const startMarks = startCleanContainer.querySelectorAll('mark');
    startMarks.forEach(mark => {
      mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
    });
    const startCleanText = startCleanContainer.textContent;

    const endCleanContainer = endContainer.cloneNode(true);
    const endMarks = endCleanContainer.querySelectorAll('mark');
    endMarks.forEach(mark => {
      mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
    });
    const endCleanText = endCleanContainer.textContent;

    console.log("Selected text:", `"${selectedText}"`);
    console.log("Start container clean text:", `"${startCleanText}"`);
    console.log("End container clean text:", `"${endCleanText}"`);
    console.log("Calculated offsets:", { start: cleanStartOffset, end: cleanEndOffset });
    console.log("Clean lengths:", { start: startContainerCleanLength, end: endContainerCleanLength });

    if (startContainer === endContainer) {
      const extractedText = startCleanText.substring(cleanStartOffset, cleanEndOffset);
      console.log("Extracted text from offsets:", `"${extractedText}"`);
      console.log("Matches selected text?", extractedText === selectedText);
    }

    // Generate unique highlight ID
    const highlightId = generateHighlightID();

    // Apply the highlight
    highlighter.highlightSelection("highlight");
    modifyNewMarks(highlightId);

    // Find all affected nodes
    const affectedMarks = document.querySelectorAll(`mark.${highlightId}`);
    const affectedIds = new Set();
    const updatedNodeChunks = [];

    affectedMarks.forEach(mark => {
      const container = mark.closest(
        "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id]"
      );
      if (container && container.id) {
        affectedIds.add(container.id);
      }
    });
    console.log("Will update chunks:", Array.from(affectedIds));
    
    // Update all affected nodes in IndexedDB
    for (const chunkId of affectedIds) {
      const isStart = chunkId === startContainer.id;
      const isEnd   = chunkId === endContainer.id;
      
      const cleanLength = isStart ? startContainerCleanLength : 
                         (isEnd ? endContainerCleanLength : 
                          (() => {
                            const textElem = document.getElementById(chunkId);
                            const cleanElem = textElem.cloneNode(true);
                            const marks = cleanElem.querySelectorAll('mark');
                            marks.forEach(mark => {
                              mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
                            });
                            return cleanElem.textContent.length;
                          })()
                         );
      
      const startOffset = isStart ? cleanStartOffset : 0;
      const endOffset   = isEnd   ? cleanEndOffset   : cleanLength;

      console.log(`=== BEFORE updateNodeHighlight ===`);
      console.log(`Chunk ${chunkId}: isStart=${isStart}, isEnd=${isEnd}`);
      console.log(`cleanStartOffset=${cleanStartOffset}, cleanEndOffset=${cleanEndOffset}`);
      console.log(`startOffset=${startOffset}, endOffset=${endOffset}, cleanLength=${cleanLength}`);
      console.log(`About to call updateNodeHighlight with: chunkId=${chunkId}, startOffset=${startOffset}, endOffset=${endOffset}, highlightId=${highlightId}`);

      const updatedNodeChunk = await updateNodeHighlight(
        chunkId,
        startOffset,
        endOffset,
        highlightId
      );
      
      console.log(`=== AFTER updateNodeHighlight ===`);
      console.log(`Returned node chunk:`, updatedNodeChunk);
      if (updatedNodeChunk && updatedNodeChunk.hyperlights) {
        const thisHighlight = updatedNodeChunk.hyperlights.find(h => h.highlightID === highlightId);
        console.log(`Saved highlight data:`, thisHighlight);
      }
      
      if (updatedNodeChunk) {
        updatedNodeChunks.push(updatedNodeChunk);
      }
      
      console.log(`Updated node ${chunkId}`);
    }

    try {
      // 1) Determine creator info (same pattern as createNewBook)
      const user = await getCurrentUser();
      const creator = user
        ? (user.name || user.username || user.email)
        : null;
      const creator_token = user ? null : getAuthorId();

      console.log("Creating hyperlight with", {
        creator,
        creator_token
      });

      // Create hyperlight entry for the main hyperlights table
      const hyperlightEntry = {
        book: book,
        hyperlight_id: highlightId,
        highlightedText: selectedText,
        highlightedHTML: selectedText,
        startChar: cleanStartOffset,
        endChar: cleanEndOffset,
        startLine: startContainer.id,
        annotation: null,
        creator,           // Add creator field
        creator_token      // Add creator_token field
      };

      // Add to IndexedDB hyperlights table (update this function to accept creator info)
      await addToHighlightsTable({
        highlightId,
        text: selectedText,
        startChar: cleanStartOffset,
        endChar: cleanEndOffset,
        startLine: startContainer.id,
        creator,           // Add creator field
        creator_token      // Add creator_token field
      });
      
      console.log("Added to highlights table");
      await updateBookTimestamp(book);
      
      // Sync with PostgreSQL
      await syncHyperlightWithPostgreSQL(hyperlightEntry, updatedNodeChunks);
      
    } catch (error) {
      console.error("❌ Error saving highlight metadata:", error);
    }

    attachMarkListeners();

    // 👈 ADD: Clear selection and hide buttons
    window.getSelection().removeAllRanges();
    document.getElementById("hyperlight-buttons").style.display = "none";

    // 👈 ADD: Open the newly created highlight in the container
    console.log("🎯 Opening newly created highlight:", highlightId);
    await openHighlightById(highlightId, true, [highlightId]);
  }
);

// Helper function to sync hyperlight data with PostgreSQL
async function syncHyperlightWithPostgreSQL(hyperlightEntry, nodeChunks) {
  try { 
    console.log("🔄 Starting Hyperlight PostgreSQL sync...");

    // Get the library object from IndexedDB for the book
    const libraryObject = await getLibraryObjectFromIndexedDB(hyperlightEntry.book);
    
    if (!libraryObject) {
      console.warn("⚠️ No library object found for book:", hyperlightEntry.book);
    }

    // Sync hyperlight using your existing endpoint
    const hyperlightResponse = await fetch("/api/db/hyperlights/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document
          .querySelector('meta[name="csrf-token"]')
          ?.getAttribute("content"),
      },
      body: JSON.stringify({
        data: [hyperlightEntry]
      }),
    });

    if (!hyperlightResponse.ok) {
      throw new Error(`Hyperlight sync failed: ${hyperlightResponse.statusText}`);
    }

    console.log("✅ Hyperlight synced with PostgreSQL");

    // Sync node chunks using your targeted endpoint
    const nodeChunkResponse = await fetch("/api/db/node-chunks/targeted-upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document
          .querySelector('meta[name="csrf-token"]')
          ?.getAttribute("content"),
      },
      body: JSON.stringify({
        data: nodeChunks
      }),
    });

    if (!nodeChunkResponse.ok) {
      throw new Error(
        `NodeChunk sync failed: ${nodeChunkResponse.statusText}`
      );
    }

    console.log("✅ NodeChunks synced with PostgreSQL (targeted)");

    // Sync library object if it exists
    if (libraryObject) {
      const libraryResponse = await fetch("/api/db/library/upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: libraryObject
        }),
      });

      if (!libraryResponse.ok) {
        throw new Error(
          `Library sync failed: ${libraryResponse.statusText}`
        );
      }

      console.log("✅ Library object synced with PostgreSQL");
    }

    console.log("🎉 All hyperlight data successfully synced with PostgreSQL");
  } catch (error) {
    console.error("❌ Error syncing hyperlight with PostgreSQL:", error);
  }
}

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
    const affectedNodeChunks = new Set(); // 👈 ADD: Track affected node chunks

    marks.forEach((mark) => {
      // If the text content of the mark is part of the selected text …
      if (selectedText.indexOf(mark.textContent.trim()) !== -1) {
        // Get the unique highlight id from the mark's classes.
        let highlightId = Array.from(mark.classList).find(
          (cls) => cls !== "highlight"
        );

        if (highlightId) {
          highlightIdsToRemove.push(highlightId);
          console.log("Removing highlight for:", highlightId);
          
          // 👈 ADD: Track which node chunk this mark belongs to
          const container = mark.closest(
            "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id]"
          );
          if (container && container.id) {
            affectedNodeChunks.add(container.id);
          }
        }

        // Remove the mark element and replace it with plain text.
        let parent = mark.parentNode;
        parent.replaceChild(
          document.createTextNode(mark.textContent),
          mark
        );
      }
    });

    // 👈 ADD: Collect updated node chunks and deleted hyperlights
    const updatedNodeChunks = [];
    const deletedHyperlights = [];

    // Now remove the corresponding records from IndexedDB (if any)
    for (const highlightId of highlightIdsToRemove) {
      try {
        // 👈 MODIFY: Capture updated node chunks from removal
        const affectedNodes = await removeHighlightFromNodeChunks(highlightId);
        if (affectedNodes && affectedNodes.length > 0) {
          updatedNodeChunks.push(...affectedNodes);
        }
        
        // 👈 MODIFY: Capture the deleted hyperlight info
        const deletedHyperlight = await removeHighlightFromHyperlights(highlightId);
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
      await updateBookTimestamp(book);
      
      // 👈 ADD: Sync deletions with PostgreSQL
      await syncHyperlightDeletionsWithPostgreSQL(
        deletedHyperlights, 
        updatedNodeChunks
      );
    }

    console.log("Removed highlight IDs:", highlightIdsToRemove);
  }
);

// Helper function to sync hyperlight deletions with PostgreSQL
async function syncHyperlightDeletionsWithPostgreSQL(deletedHyperlights, updatedNodeChunks) {
  try {
    console.log("🔄 Starting Hyperlight deletion PostgreSQL sync...");

    // Get the library object from IndexedDB for the book
    const libraryObject = await getLibraryObjectFromIndexedDB(book);
    
    if (!libraryObject) {
      console.warn("⚠️ No library object found for book:", book);
    }

    // Sync deleted hyperlights (they'll be removed from PostgreSQL)
    if (deletedHyperlights.length > 0) {
      const hyperlightResponse = await fetch("/api/db/hyperlights/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: deletedHyperlights
        }),
      });

      if (!hyperlightResponse.ok) {
        throw new Error(`Hyperlight deletion sync failed: ${hyperlightResponse.statusText}`);
      }

      console.log("✅ Hyperlights deleted from PostgreSQL");
    }

    // Sync updated node chunks (with hyperlights removed)
    if (updatedNodeChunks.length > 0) {
      const nodeChunkResponse = await fetch("/api/db/node-chunks/targeted-upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: updatedNodeChunks
        }),
      });

      if (!nodeChunkResponse.ok) {
        throw new Error(
          `NodeChunk sync failed: ${nodeChunkResponse.statusText}`
        );
      }

      console.log("✅ NodeChunks synced with PostgreSQL (targeted)");
    }

    // Sync library object if it exists
    if (libraryObject) {
      const libraryResponse = await fetch("/api/db/library/upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        body: JSON.stringify({
          data: libraryObject
        }),
      });

      if (!libraryResponse.ok) {
        throw new Error(
          `Library sync failed: ${libraryResponse.statusText}`
        );
      }

      console.log("✅ Library object synced with PostgreSQL");
    }

    console.log("🎉 All hyperlight deletion data successfully synced with PostgreSQL");
  } catch (error) {
    console.error("❌ Error syncing hyperlight deletions with PostgreSQL:", error);
  }
}

// IndexedDB helper to remove highlight from the "nodeChunks" table.
async function removeHighlightFromNodeChunks(highlightId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodeChunks", "readwrite");
    const store = tx.objectStore("nodeChunks");
    const updatedNodes = []; // 👈 ADD: Track updated nodes

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










