// resources/js/selectionHandler.js

import { isContentLink } from '../hyperlights/deletion.js';

let hyperlightButtons = null;
let originalParent = null;

/**
 * Removes the toolbar separator if it exists.
 */
function removeSeparator() {
  const separator = document.getElementById("hyperlight-separator");
  if (separator) {
    separator.remove();
  }
}

function isMobile() {
  return window.innerWidth <= 768;
}

function handleSelection() {
  // Guard clause: If the handler hasn't been initialized, do nothing.
  if (!hyperlightButtons) return;

  if (window.activeContainer === "source-container") {
    return;
  }

  const selection = window.getSelection();
  const selectedText = selection.toString().trim();

  if (selectedText.length > 0) {
    const editToolbar = document.getElementById("edit-toolbar");

    // Hide undo/redo buttons while hyperlight buttons are visible
    if (editToolbar) {
      editToolbar.classList.add("hyperlight-selection-active");
    }

    if (window.innerWidth <= 768) {
      // Mobile logic...
      hyperlightButtons.style.top = "";
      hyperlightButtons.style.left = "";
      hyperlightButtons.style.position = "";

      if (window.isEditing && editToolbar) {
        hyperlightButtons.classList.remove("mobile-fixed-bottom");
        if (hyperlightButtons.parentElement !== editToolbar) {
          const separator = document.createElement("span");
          separator.id = "hyperlight-separator";
          separator.className = "toolbar-separator";
          hyperlightButtons.insertBefore(
            separator,
            hyperlightButtons.firstChild,
          );
          editToolbar.appendChild(hyperlightButtons);
        }
      } else {
        const separator = document.getElementById("hyperlight-separator");
        if (separator) separator.remove();
        hyperlightButtons.classList.add("mobile-fixed-bottom");
        if (hyperlightButtons.parentElement !== originalParent) {
          originalParent.appendChild(hyperlightButtons);
        }
      }
      hyperlightButtons.style.display = "flex";
    } else {
      // Desktop logic...
      const separator = document.getElementById("hyperlight-separator");
      if (separator) separator.remove();
      hyperlightButtons.classList.remove("mobile-fixed-bottom");
      if (hyperlightButtons.parentElement !== originalParent) {
        originalParent.appendChild(hyperlightButtons);
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      hyperlightButtons.style.display = "flex";
      const offset = 100;
      if (rect.bottom + offset > window.innerHeight) {
        hyperlightButtons.style.top = `${rect.top + window.scrollY - offset}px`;
      } else {
        hyperlightButtons.style.top = `${
          rect.bottom + window.scrollY + 10
        }px`;
      }
      hyperlightButtons.style.left = `${rect.left + window.scrollX}px`;
    }

    const highlights = document.querySelectorAll("mark.user-highlight");
    let isOverlapping = false;
    highlights.forEach(function (highlight) {
      if (selectedText.includes(highlight.textContent.trim())) {
        isOverlapping = true;
      }
    });

    // Also check if selection overlaps any user-created content links (edit mode only)
    if (!isOverlapping && window.isEditing) {
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const root = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
      const anchors = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
      for (const a of anchors) {
        if (!isContentLink(a)) continue;
        try {
          const aRange = document.createRange();
          aRange.selectNodeContents(a);
          const intersects = range.compareBoundaryPoints(Range.END_TO_START, aRange) <= 0 &&
                           aRange.compareBoundaryPoints(Range.END_TO_START, range) <= 0;
          if (intersects) { isOverlapping = true; break; }
        } catch (e) { /* ignore */ }
      }
    }

    document.getElementById("delete-hyperlight").style.display = isOverlapping
      ? "block"
      : "none";
  } else {
    const separator = document.getElementById("hyperlight-separator");
    if (separator) separator.remove();
    hyperlightButtons.style.display = "none";
    hyperlightButtons.classList.remove("mobile-fixed-bottom");
    document.getElementById("delete-hyperlight").style.display = "none";

    // Show undo/redo buttons again when selection is cleared
    const editToolbar = document.getElementById("edit-toolbar");
    if (editToolbar) {
      editToolbar.classList.remove("hyperlight-selection-active");
    }
  }
}

export function initializeSelectionHandler() {
  // Re-query the DOM for the elements every time we initialize.
  hyperlightButtons = document.getElementById("hyperlight-buttons");
  if (!hyperlightButtons) {
    console.error("Could not initialize SelectionHandler: #hyperlight-buttons not found.");
    return;
  }
  originalParent = hyperlightButtons.parentElement;

  document.addEventListener("selectionchange", handleSelection);
}

export function destroySelectionHandler() {
  document.removeEventListener("selectionchange", handleSelection);
  hyperlightButtons = null;
  originalParent = null;
}