/**
 * Selection module - Handles text selection, highlighting controls, and highlight creation/deletion
 */

import { book } from '../app.js';
import { updateAnnotationsTimestamp, queueForSync, rebuildNodeArrays, getNodesByUUIDs } from '../indexedDB/index.js';
import { calculateCleanTextOffset, findContainerWithNumericalId } from './calculations.js';
import { modifyNewMarks } from './marks.js';
import { attachMarkListeners, addTouchAndClickListener } from './listeners.js';
import { addToHighlightsTable, removeHighlightFromHyperlights, removeHighlightFromNodeChunksWithDeletion } from './database.js';
import { reprocessHighlightsForNodes, unwrapMark } from './deletion.js';
import { generateHighlightID, openHighlightById } from './utils.js';
import { log, verbose } from '../utilities/logger.js';
import { withPending } from '../utilities/operationState.js';

// Track whether document listeners are attached
let documentListenersAttached = false;

// Initialize the highlighter (using rangy)
rangy.init();
const highlighter = rangy.createHighlighter();
const classApplier = rangy.createClassApplier("highlight", {
    elementTagName: "mark",
    applyToAnyTagName: true
});
highlighter.addClassApplier(classApplier);

/**
 * Handle text selection and show/hide highlight buttons
 */
export function handleSelection() {
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
  let isSelectingHighlight = false;

  // Check if the selection contains or overlaps with any existing highlight
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const selectionRange = selection.getRangeAt(0);

    highlights.forEach(function (highlight) {
      // Check if the selection intersects with this highlight element
      try {
        const highlightRange = document.createRange();
        highlightRange.selectNodeContents(highlight);

        // Check if ranges intersect
        const intersects = selectionRange.compareBoundaryPoints(Range.END_TO_START, highlightRange) <= 0 &&
                         highlightRange.compareBoundaryPoints(Range.END_TO_START, selectionRange) <= 0;

        if (intersects) {
          isSelectingHighlight = true;
        }
      } catch (e) {
        // Fallback to text-based comparison if range comparison fails
        if (selectedText.includes(highlight.textContent.trim()) ||
            highlight.textContent.trim().includes(selectedText)) {
          isSelectingHighlight = true;
        }
      }
    });
  }

  if (selectedText.length > 0) {
    // Only log first 100 chars to avoid massive logs for large selections
    const preview = selectedText.length > 100
      ? selectedText.substring(0, 100) + `... (${selectedText.length} chars total)`
      : selectedText;
    console.log("Showing buttons. Selected text:", preview);

    // Get the bounding box of the selected text to position buttons near it
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // Position the buttons near the selected text, but far from iOS context menu
    const buttons = document.getElementById("hyperlight-buttons");
    buttons.style.display = "flex";

    // Hide undo/redo buttons in edit toolbar when hyperlight buttons are shown
    const editToolbar = document.getElementById("edit-toolbar");
    if (editToolbar) {
      editToolbar.classList.add("hyperlight-selection-active");
    }

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

    // Show delete button if selecting any highlight
    if (isSelectingHighlight) {
      console.log("Detected highlight selection - showing delete button");
      document.getElementById("delete-hyperlight").style.display = "block";
    } else {
      console.log("No highlight selected - hiding delete button");
      document.getElementById("delete-hyperlight").style.display = "none";
    }
  } else {
    verbose.content("No text selected. Hiding buttons.", 'hyperlights/selection.js');
    document.getElementById("hyperlight-buttons").style.display = "none";
    document.getElementById("delete-hyperlight").style.display = "none";

    // Show undo/redo buttons again in edit toolbar
    const editToolbar = document.getElementById("edit-toolbar");
    if (editToolbar) {
      editToolbar.classList.remove("hyperlight-selection-active");
    }
  }
}

/**
 * Initialize highlighting controls for the current book
 * @param {string} currentBookId - The current book ID
 */
export function initializeHighlightingControls(currentBookId) {
  log.init(`Highlighting controls initialized for ${currentBookId}`, '/hyperlights/selection.js');

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
}

/**
 * Cleanup highlighting controls and remove document-level listeners
 */
export function cleanupHighlightingControls() {
  if (documentListenersAttached) {
    document.removeEventListener("mouseup", handleSelection);
    // Note: Cannot remove the touchend listener since it was added as an anonymous function
    documentListenersAttached = false;
  }
}

/**
 * Create a new highlight from selected text
 * @param {Event} event - The triggering event
 * @param {string} bookId - The current book ID
 */
export async function createHighlightHandler(event, bookId) {
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
  let startContainer = range.startContainer.nodeType === 3
    ? findContainerWithNumericalId(range.startContainer.parentElement)
    : findContainerWithNumericalId(range.startContainer);

  let endContainer = range.endContainer.nodeType === 3
    ? findContainerWithNumericalId(range.endContainer.parentElement)
    : findContainerWithNumericalId(range.endContainer);

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

  // Check if selection contains existing marks
  const selectionContainsMarks = range.cloneContents().querySelectorAll('mark').length > 0;

  // Apply the highlight
  console.log("🎨 Before rangy - selection:", selection.toString(), "range:", range);
  console.log("🎨 Range details:", {
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
    containsExistingMarks: selectionContainsMarks
  });

  if (selectionContainsMarks) {
    console.warn("⚠️ Selection contains existing marks - Rangy may not handle boundaries correctly");
    // TODO: Implement manual mark creation for overlapping highlights
    // For now, still use Rangy but log the warning
  }

  highlighter.highlightSelection("highlight");

  const newMarks = document.querySelectorAll('mark.highlight');
  console.log("🎨 After rangy - created marks:", newMarks.length, Array.from(newMarks).map(m => ({
    text: m.textContent,
    parent: m.parentElement.tagName,
    parentId: m.parentElement.id
  })));

  modifyNewMarks(highlightId);

  // Find all affected nodes
  const affectedMarks = document.querySelectorAll(`mark.${highlightId}`);
  const affectedIds = new Set();
  const updatedNodeChunks = [];

  affectedMarks.forEach((mark) => {
    const container = mark.closest(
      "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id]"
    );
    if (container && container.id) {
      affectedIds.add(container.id);
    }
  });

  // ✅ NEW: Collect per-node character position data
  const charDataByNode = {};
  const nodeIdMap = {};

  // Update all affected nodes in IndexedDB
  for (const chunkId of affectedIds) {
    const isStart = chunkId === startContainer.id;
    const isEnd = chunkId === endContainer.id;

    const cleanLength = (() => {
      const textElem = document.getElementById(chunkId);
      const cleanElem = textElem.cloneNode(true);

      // Remove ALL HTML elements to get clean text length (consistent with calculateCleanTextOffset)
      const removeAllHtml = (element) => {
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_ELEMENT,
          null,
          false
        );

        const elementsToReplace = [];
        let node;
        while (node = walker.nextNode()) {
          if (node !== element) {
            elementsToReplace.push(node);
          }
        }

        elementsToReplace.reverse().forEach(el => {
          if (el.parentNode) {
            el.parentNode.replaceChild(document.createTextNode(el.textContent), el);
          }
        });
      };

      removeAllHtml(cleanElem);
      return cleanElem.textContent.length;
    })();

    const startOffset = isStart ? cleanStartOffset : 0;
    const endOffset = isEnd ? cleanEndOffset : cleanLength;

    // ✅ NEW: Store per-node positions for new charData structure
    const element = document.getElementById(chunkId);
    const nodeId = element?.getAttribute('data-node-id') || chunkId;  // Fallback to startLine if no data-node-id

    nodeIdMap[chunkId] = nodeId;
    charDataByNode[nodeId] = {
      charStart: startOffset,
      charEnd: endOffset
    };

    // 🔄 OLD SYSTEM: COMMENTED OUT - Don't update embedded arrays directly
    /*
    const updatedNodeChunk = await updateNodeHighlight(
      bookId,
      chunkId,
      startOffset,
      endOffset,
      highlightId
    );

    if (updatedNodeChunk) {
      updatedNodeChunks.push(updatedNodeChunk);
    }
    */
  }

  try {
    // Wrap database operations with withPending to trigger cloudRef glow
    await withPending(async () => {
      // ✅ NEW SYSTEM: Save to normalized hyperlights table
      const savedHighlightEntry = await addToHighlightsTable(
        bookId,
        {
          highlightId,
          text: selectedText,
          charData: charDataByNode,
          startLine: startContainer.id,
        }
      );

      console.log('✅ NEW SYSTEM: Hyperlight saved to normalized table');

      // ✅ NEW SYSTEM: Rebuild affected node arrays from normalized tables
      const affectedNodeUUIDs = Object.keys(charDataByNode);
      const affectedNodes = await getNodesByUUIDs(affectedNodeUUIDs);
      await rebuildNodeArrays(affectedNodes);

      console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${affectedNodes.length} affected nodes`);

      await updateAnnotationsTimestamp(bookId);

      // Queue hyperlight for PostgreSQL sync
      queueForSync("hyperlights", highlightId, "update", savedHighlightEntry);

      console.log(
        `✅ NEW SYSTEM: Queued 1 hyperlight for sync, rebuilt ${affectedNodes.length} node arrays.`
      );
    });

    // 🎨 Reprocess highlights to render overlapping segments correctly (outside withPending - DOM only)
    const { reprocessHighlightsForNodes } = await import('./deletion.js');
    await reprocessHighlightsForNodes(bookId, Array.from(affectedIds));
    console.log(`✅ Reprocessed highlights for ${affectedIds.size} nodes to render overlaps`);

  } catch (error) {
    console.error("❌ Error saving highlight metadata:", error);
  }

  attachMarkListeners();
  window.getSelection().removeAllRanges();
  document.getElementById("hyperlight-buttons").style.display = "none";

  // Show undo/redo buttons again in edit toolbar
  const editToolbar = document.getElementById("edit-toolbar");
  if (editToolbar) {
    editToolbar.classList.remove("hyperlight-selection-active");
  }

  // Mark highlight as newly created for proper CSS styling in container
  try {
    const { addNewlyCreatedHighlight, removeNewlyCreatedHighlight } = await import('../utilities/operationState.js');

    // Mark this highlight as a newly created user highlight for proper CSS application
    addNewlyCreatedHighlight(highlightId);

    // Clean up the newly created flag after a delay (backend should have processed by then)
    setTimeout(() => {
      removeNewlyCreatedHighlight(highlightId);
    }, 10000); // 10 seconds should be enough for backend processing
  } catch (error) {
    console.warn('⚠️ Failed to mark highlight as newly created:', error);
  }

  await openHighlightById(highlightId, true, [highlightId]);
}

/**
 * Delete highlight(s) that overlap with selected text
 * @param {Event} event - The triggering event
 * @param {string} bookId - The current book ID
 */
export async function deleteHighlightHandler(event, bookId) {
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

  // Check if the selection intersects with existing highlights
  const selectionRange = selection.getRangeAt(0);

  marks.forEach((mark) => {
    // Check if the selection intersects with this mark
    let shouldRemove = false;

    try {
      const markRange = document.createRange();
      markRange.selectNodeContents(mark);

      // Check if ranges intersect
      const intersects = selectionRange.compareBoundaryPoints(Range.END_TO_START, markRange) <= 0 &&
                       markRange.compareBoundaryPoints(Range.END_TO_START, selectionRange) <= 0;

      shouldRemove = intersects;
    } catch (e) {
      // Fallback to text-based comparison if range comparison fails
      shouldRemove = selectedText.indexOf(mark.textContent.trim()) !== -1 ||
                    mark.textContent.trim().indexOf(selectedText) !== -1;
    }

    if (shouldRemove) {
      let highlightId = Array.from(mark.classList).find(
        (cls) => cls !== "highlight" && cls.startsWith("HL_")
      );

      if (highlightId) {
        highlightIdsToRemove.push(highlightId);
        console.log("Removing highlight for:", highlightId);

        const container = mark.closest(
          "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id]"
        );
        if (container && container.id) {
          affectedNodeChunks.add(container.id);
        }
      }

      unwrapMark(mark);
    }
  });

  const updatedNodeChunks = [];
  const deletedHyperlights = [];

  for (const highlightId of highlightIdsToRemove) {
    try {
      // Get the deleted hyperlight data first
      const deletedHyperlight = await removeHighlightFromHyperlights(
        highlightId
      );
      if (deletedHyperlight) {
        deletedHyperlights.push(deletedHyperlight);
      }

      // Update nodes with explicit deletion instructions
      const affectedNodes = await removeHighlightFromNodeChunksWithDeletion(
        bookId,
        highlightId,
        deletedHyperlight
      );
      if (affectedNodes && affectedNodes.length > 0) {
        updatedNodeChunks.push(...affectedNodes);
      }
    } catch (error) {
      console.error(
        `Error removing highlight ${highlightId} from IndexedDB:`,
        error
      );
    }
  }

  if (highlightIdsToRemove.length > 0) {
    await updateBookTimestamp(bookId);

    deletedHyperlights.forEach((hl) => {
      if (hl && hl.hyperlight_id) {
        queueForSync("hyperlights", hl.hyperlight_id, "delete", hl);
      }
    });

    // 🔄 OLD SYSTEM: COMMENTED OUT - Don't queue node updates
    /*
    updatedNodeChunks.forEach((chunk) => {
      if (chunk && chunk.startLine) {
        queueForSync("nodes", chunk.startLine, "update", chunk);
      }
    });
    */

    console.log(
      `✅ Queued for sync: ${deletedHyperlights.length} deletions (no node updates in NEW system).`
    );

    // 🎨 Reprocess highlights to render remaining highlights correctly
    if (affectedNodeChunks.size > 0) {
      const { reprocessHighlightsForNodes } = await import('./deletion.js');
      await reprocessHighlightsForNodes(bookId, Array.from(affectedNodeChunks));
      console.log(`✅ Reprocessed highlights for ${affectedNodeChunks.size} nodes after deletion`);
    }
  }

  // Clear selection and hide buttons
  window.getSelection().removeAllRanges();
  document.getElementById("hyperlight-buttons").style.display = "none";
  document.getElementById("delete-hyperlight").style.display = "none";

  // Show undo/redo buttons again in edit toolbar
  const editToolbar = document.getElementById("edit-toolbar");
  if (editToolbar) {
    editToolbar.classList.remove("hyperlight-selection-active");
  }
}
