import { asBookId, LATEST, type BookId } from "../indexedDB/types";
/**
 * Selection toolbar — the on-select popup controller.
 *
 * Manages the SHARED `#hyperlight-buttons` popup that appears when the user
 * selects text. The popup hosts five buttons; each feature wires its OWN:
 * this module shows/positions/hides the popup, toggles the delete button,
 * dims the brain button, and wires the three HYPERLIGHT buttons
 * (copy → create, delete, brain) plus translate (translateSelection.ts).
 * The `copy-hypercite` button is wired separately in hypercites/listeners.js
 * — not here.
 *
 * Split out of the old selection.js monster (2026-06).
 */

import { isContentLink } from './deletion';
import { addTouchAndClickListener } from './listeners';
import { createHighlightHandler, openBrainFromSelection } from './createHighlight';
import { deleteHighlightHandler } from './deleteHighlight';
import { translateSelection, closeTranslation } from './translateSelection';
import { getActiveBook, setActiveBook, clearActiveBook } from '../hyperlitContainer/utilities/activeContext';
import { isStackPopping } from '../hyperlitContainer/containerActions';
import { log, verbose } from '../utilities/logger';

// Track whether document listeners are attached
let documentListenersAttached = false;

// Debounced selectionchange → handleSelection. iOS extends/shrinks a selection
// by dragging the native handles WITHOUT firing mouseup/touchend, so without
// this the toolbar's state (position, delete visibility, brain dim) froze at
// whatever the initial long-press selected. Trailing debounce: selectionchange
// fires continuously during a handle drag, run once it settles.
let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;
function handleSelectionChangeDebounced(): void {
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(() => {
    // Cheap gate: edit-mode typing fires selectionchange on every caret move
    // with a collapsed selection — don't run the mark-intersection sweep
    // unless there's a selection to show for or a visible toolbar to update.
    const hasSelection = !(window.getSelection()?.isCollapsed ?? true);
    const toolbarVisible = document.getElementById("hyperlight-buttons")?.style.display === "flex";
    if (hasSelection || toolbarVisible) handleSelection();
  }, 200);
}

/**
 * Handle text selection and show/hide highlight buttons
 */
export function handleSelection(): void {
  // Suppress during stack pop — DOM is being torn down, layout reflows freeze the UI
  if (isStackPopping()) return;

  // Suppress while the toolbar's link mode owns the selection (it REQUIRES a
  // text selection, so without this guard the hyperlight popup re-summons on
  // any mouseup while the URL is being typed/pasted). LinkMode.open() hides
  // the popup; this keeps it hidden for the mode's duration.
  if (document.getElementById('edit-toolbar')?.classList.contains('link-mode-active')) {
    return;
  }

  // If the source container is open, don't do anything here.
  if ((window as any).activeContainer === "source-container") {
    // If this function is triggered by an event, make sure to prevent further actions:
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }

  let selectedText = window.getSelection()!.toString();
  const highlights = document.querySelectorAll('mark');
  let isSelectingHighlight = false;
  let isSelectingUserHighlight = false;
  let isSelectingLink = false;

  // Check if the selection contains or overlaps with any existing highlight
  const selection = window.getSelection()!;
  if (selection.rangeCount > 0) {
    const selectionRange = selection.getRangeAt(0);

    // Suppress buttons when selecting inside citation/reference containers,
    // or inside the translation card (selecting its text to copy it).
    const anchor = selectionRange.commonAncestorContainer;
    const anchorEl = (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor) as HTMLElement | null;
    if (anchorEl?.closest('.hypercites-section, .citations-section, .hypercite-citation-section, #translation-popover')) {
      document.getElementById("hyperlight-buttons")!.style.display = "none";
      return;
    }

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
          // Check if this is a user's own highlight (has user-highlight class)
          if (highlight.classList.contains('user-highlight')) {
            isSelectingUserHighlight = true;
          }
        }
      } catch (e) {
        // Fallback to text-based comparison if range comparison fails
        if (selectedText.includes((highlight.textContent || '').trim()) ||
            (highlight.textContent || '').trim().includes(selectedText)) {
          isSelectingHighlight = true;
          if (highlight.classList.contains('user-highlight')) {
            isSelectingUserHighlight = true;
          }
        }
      }
    });

    // Check if the selection intersects with any user-created content links (edit mode only)
    if ((window as any).isEditing) {
    const anchorRoot = (selectionRange.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? selectionRange.commonAncestorContainer.parentElement
      : selectionRange.commonAncestorContainer) as HTMLElement | null;
    const searchRoot = anchorRoot?.closest('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id], .main-content, [data-book-id]') || anchorRoot;
    if (searchRoot && searchRoot.querySelectorAll) {
      const anchors = searchRoot.querySelectorAll('a[href]');
      anchors.forEach(function (anchor) {
        if (!isContentLink(anchor as HTMLAnchorElement)) return;
        try {
          const anchorRange = document.createRange();
          anchorRange.selectNodeContents(anchor);
          const intersects = selectionRange.compareBoundaryPoints(Range.END_TO_START, anchorRange) <= 0 &&
                           anchorRange.compareBoundaryPoints(Range.END_TO_START, selectionRange) <= 0;
          if (intersects) {
            isSelectingLink = true;
          }
        } catch (e) {
          // Fallback to text-based comparison
          if (selectedText.includes((anchor.textContent || '').trim()) ||
              (anchor.textContent || '').trim().includes(selectedText)) {
            isSelectingLink = true;
          }
        }
      });
    }
    } // end window.isEditing
  }

  // Detect whether the selection lives inside a sub-book and update active context
  if (selection.rangeCount > 0) {
    const anchor = selection.getRangeAt(0).commonAncestorContainer;
    const subBookEl = ((anchor.nodeType === Node.TEXT_NODE
      ? anchor.parentElement
      : anchor
    ) as HTMLElement | null)?.closest('[data-book-id]');

    if (subBookEl) {
      setActiveBook(asBookId(subBookEl.getAttribute('data-book-id')!));
    } else {
      clearActiveBook();
    }
  }

  if (selectedText.length > 0) {
    // Get the bounding box of the selected text to position buttons near it
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // Position the buttons near the selected text, but far from iOS context menu
    const buttons = document.getElementById("hyperlight-buttons")!;
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

    // Show delete button if selecting user's own highlight or a content link
    if (isSelectingUserHighlight || isSelectingLink) {
      document.getElementById("delete-hyperlight")!.style.display = "block";
    } else {
      document.getElementById("delete-hyperlight")!.style.display = "none";
    }

    // Dim brain button if selection is too short for AI query. VISUAL only —
    // no pointer-events:none: openBrainFromSelection already refuses <5 chars,
    // and on iOS the dim state can be STALE (extending a selection by dragging
    // the native handles fires selectionchange but no touchend, so this
    // function didn't re-run). A stale pointer-events:none made the first tap
    // on a perfectly valid selection fall through dead — the "greyed out but
    // works when I press it anyway" bug: the dead tap's touchend re-ran
    // handleSelection, un-dimmed the button, and the SECOND tap worked.
    const brainBtn = document.getElementById("brain-hyperlight");
    if (brainBtn) {
      brainBtn.style.pointerEvents = "";
      brainBtn.style.opacity = selectedText.trim().length < 5 ? "0.3" : "";
    }
  } else {
    verbose.content("No text selected. Hiding buttons.", 'hyperlights/selection.js');
    document.getElementById("hyperlight-buttons")!.style.display = "none";
    document.getElementById("delete-hyperlight")!.style.display = "none";

    // Show undo/redo buttons again in edit toolbar
    const editToolbar = document.getElementById("edit-toolbar");
    if (editToolbar) {
      editToolbar.classList.remove("hyperlight-selection-active");
    }
  }
}

/**
 * Initialize highlighting controls for the current book
 */
export function initializeHighlightingControls(currentBookId: string): void {
  verbose.init(`Highlighting controls initialized for ${currentBookId}`, '/hyperlights/selection.js');

  // Find the UI elements within the newly loaded reader view
  const copyButton = document.getElementById("copy-hyperlight");
  const deleteButton = document.getElementById("delete-hyperlight");
  const buttonsContainer = document.getElementById("hyperlight-buttons");

  if (!copyButton || !deleteButton || !buttonsContainer) {
    log.error("Highlighting UI controls not found in the DOM. Aborting initialization.", 'hyperlights/selection.js');
    return;
  }

  // --- Attach Listeners for Showing/Hiding the Buttons ---
  // Check if document listeners are already attached
  if (!documentListenersAttached) {
    document.addEventListener("mouseup", handleSelection);
    document.addEventListener("touchend", () => setTimeout(handleSelection, 100));
    document.addEventListener("selectionchange", handleSelectionChangeDebounced);
    documentListenersAttached = true;
  }

  // --- Attach Listeners for the Action Buttons ---
  // Call getActiveBook() at click time so sub-book context is always current.
  addTouchAndClickListener(copyButton, (event) =>
    createHighlightHandler(event, getActiveBook())
  );
  addTouchAndClickListener(deleteButton, (event) =>
    deleteHighlightHandler(event, getActiveBook())
  );

  // Brain button — opens AI brain mode with current selection
  const brainButton = document.getElementById("brain-hyperlight");
  if (brainButton) {
    addTouchAndClickListener(brainButton, (event) => {
      event.preventDefault();
      openBrainFromSelection(event);
    });
  } else {
    log.error('🧠 Brain button #brain-hyperlight not found in DOM', 'hyperlights/selection.js');
  }

  // Translate button — translates the selection into a card under it.
  // Reader-only, like the brain button, so its absence elsewhere is normal.
  const translateButton = document.getElementById("translate-hyperlight");
  if (translateButton) {
    addTouchAndClickListener(translateButton, (event) => {
      event.preventDefault();
      return translateSelection();
    });
  }

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
export function cleanupHighlightingControls(): void {
  if (documentListenersAttached) {
    document.removeEventListener("mouseup", handleSelection);
    // Note: Cannot remove the touchend listener since it was added as an anonymous function
    document.removeEventListener("selectionchange", handleSelectionChangeDebounced);
    if (selectionChangeTimer) {
      clearTimeout(selectionChangeTimer);
      selectionChangeTimer = null;
    }
    documentListenersAttached = false;
  }
  // Actually remove button listeners, then reset guards so reinit can re-attach
  const copyButton = document.getElementById("copy-hyperlight");
  const deleteButton = document.getElementById("delete-hyperlight");
  const brainBtn = document.getElementById("brain-hyperlight");
  const translateBtn = document.getElementById("translate-hyperlight");
  closeTranslation();
  [copyButton, deleteButton, brainBtn, translateBtn].forEach(btn => {
    if (!btn) return;
    const b = btn as any;
    if (b._wrappedHandler) {
      btn.removeEventListener("mousedown", b._wrappedHandler);
      btn.removeEventListener("touchstart", b._wrappedHandler);
      b._wrappedHandler = null;
    }
    b._listenersAttached = false;
  });
}
