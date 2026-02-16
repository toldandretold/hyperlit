// EditToolbar - Main orchestrator for toolbar functionality
// Delegates to specialized modules for different formatting operations

import { log } from "../utilities/logger.js";
import {
  updateSingleIndexedDBRecord,
  deleteIndexedDBRecord,
} from "../indexedDB/index.js";
import { SelectionManager } from "./selectionManager.js";
import { ButtonStateManager } from "./buttonStateManager.js";
import { HistoryHandler } from "./historyHandler.js";
import { HeadingSubmenu } from "./headingSubmenu.js";
import { CitationMode } from "./citationMode.js";
import { TextFormatter } from "./textFormatter.js";
import { ListConverter } from "./listConverter.js";
import { BlockFormatter } from "./blockFormatter.js";
import { setCurrentBookId } from "../historyManager.js";
import { initTapAreaExtender } from "./tapAreaExtender.js";

// Private module-level variable to hold the toolbar instance
let editToolbarInstance = null;

/**
 * EditToolbar class for handling formatting controls in editable content
 * Acts as the main orchestrator, delegating to specialized module managers
 */
class EditToolbar {
  constructor(options = {}) {
    this.toolbarId = options.toolbarId || "edit-toolbar";
    this.editableSelector =
      options.editableSelector || ".main-content[contenteditable='true']";
    this.currentBookId = options.currentBookId || null;

    this.toolbar = document.getElementById(this.toolbarId);
    if (!this.toolbar) {
      console.log(`ℹ️ EditToolbar: Element with id "${this.toolbarId}" not found. Skipping toolbar initialization.`);
      this.isDisabled = true;
      return;
    }

    this.boldButton = document.getElementById("boldButton");
    this.italicButton = document.getElementById("italicButton");
    this.headingButton = document.getElementById("headingButton");
    this.headingSubmenu = document.getElementById("heading-submenu");
    this.blockquoteButton = document.getElementById("blockquoteButton");
    this.codeButton = document.getElementById("codeButton");
    this.footnoteButton = document.getElementById("footnoteButton");
    this.citationButton = document.getElementById("citationButton");
    this.undoButton = document.getElementById("undoButton");
    this.redoButton = document.getElementById("redoButton");

    this.isMobile = window.innerWidth <= 768;

    // Initialize SelectionManager
    this.selectionManager = new SelectionManager({
      editableSelector: this.editableSelector,
      isMobile: this.isMobile,
      isVisible: false
    });

    // Initialize ButtonStateManager
    this.buttonStateManager = new ButtonStateManager({
      boldButton: this.boldButton,
      italicButton: this.italicButton,
      headingButton: this.headingButton,
      blockquoteButton: this.blockquoteButton,
      codeButton: this.codeButton,
      citationButton: this.citationButton,
      headingSubmenu: this.headingSubmenu,
      selectionManager: this.selectionManager
    });

    // Initialize HistoryHandler
    this.historyHandler = new HistoryHandler({
      undoButton: this.undoButton,
      redoButton: this.redoButton,
      isDisabled: this.isDisabled
    });

    // Initialize HeadingSubmenu
    this.headingSubmenu_handler = new HeadingSubmenu({
      headingSubmenu: this.headingSubmenu,
      headingButton: this.headingButton,
      selectionManager: this.selectionManager,
      buttonStateManager: this.buttonStateManager,
      currentBookId: this.currentBookId,
      formatBlockCallback: (type, level) => this.formatBlock(type, level),
      saveToIndexedDBCallback: (id, html) => this.saveToIndexedDB(id, html)
    });

    // Get all buttons except citation button for hiding during citation mode
    this.allFormattingButtons = [
      this.boldButton,
      this.italicButton,
      this.headingButton,
      this.blockquoteButton,
      this.codeButton,
      this.footnoteButton,
      this.undoButton,
      this.redoButton
    ].filter(btn => btn); // Filter out any null buttons

    // Initialize CitationMode
    this.citationMode = new CitationMode({
      toolbar: this.toolbar,
      citationButton: this.citationButton,
      citationContainer: document.getElementById('citation-mode-container'),
      citationInput: document.getElementById('citation-search-input'),
      citationResults: document.getElementById('citation-toolbar-results'),
      allButtons: this.allFormattingButtons,
      closeHeadingSubmenuCallback: () => this.closeHeadingSubmenu()
    });

    // Initialize TextFormatter
    this.textFormatter = new TextFormatter({
      editableSelector: this.editableSelector,
      selectionManager: this.selectionManager,
      buttonStateManager: this.buttonStateManager,
      saveToIndexedDBCallback: (id, html) => this.saveToIndexedDB(id, html)
    });

    // Initialize ListConverter
    this.listConverter = new ListConverter({
      currentBookId: this.currentBookId,
      saveToIndexedDBCallback: (id, html) => this.saveToIndexedDB(id, html)
    });

    // Initialize BlockFormatter
    this.blockFormatter = new BlockFormatter({
      editableSelector: this.editableSelector,
      currentBookId: this.currentBookId,
      selectionManager: this.selectionManager,
      buttonStateManager: this.buttonStateManager,
      saveToIndexedDBCallback: (id, html) => this.saveToIndexedDB(id, html),
      deleteFromIndexedDBCallback: (id) => this.deleteFromIndexedDB(id),
      convertListItemToBlockCallback: (listItem, type) => this.convertListItemToBlock(listItem, type)
    });

    // Bind event handlers
    this.attachButtonHandlers = this.attachButtonHandlers.bind(this);

    this.isVisible = false;
    this.isFormatting = false;
  }

  init() {
    if (this.isDisabled) {
      console.log('ℹ️ EditToolbar: Skipping init() - toolbar is disabled due to missing elements');
      return;
    }
    this.attachButtonHandlers();
    this.hide();

    // Initialize tap area extender for mobile (captures taps in gaps below/around buttons)
    initTapAreaExtender(this.toolbar);

    // Prevent toolbar gap taps from closing keyboard on mobile
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile && this.toolbar) {
      this.toolbar.addEventListener('touchstart', (e) => {
        // If touch hit a button, let it through
        if (e.target.closest('button')) return;

        // Touch hit toolbar background/gap - prevent keyboard close
        console.log('🛡️ Toolbar gap tap - preventing keyboard close');
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });

      // Also prevent touches on keyboard gap blocker
      const gapBlocker = document.getElementById('keyboard-gap-blocker');
      if (gapBlocker) {
        gapBlocker.addEventListener('touchstart', (e) => {
          console.log('🛡️ Gap blocker: preventing keyboard close');
          e.preventDefault();
          e.stopPropagation();
        }, { passive: false });
      }
    }

    // Set the initial book ID in historyManager
    if (this.currentBookId) {
      setCurrentBookId(this.currentBookId);
    }
    this.historyHandler.updateHistoryButtonStates(); // Set initial state of undo/redo buttons
  }

  /**
   * Sets the current book ID and updates history button states.
   * Call this when your main application loads a new book.
   * @param {string} bookId The ID of the currently loaded book.
   */
  setBookId(bookId) {
    if (this.isDisabled) return;
    this.currentBookId = bookId;
    setCurrentBookId(bookId); // Update the history manager
    this.historyHandler.updateHistoryButtonStates(); // Refresh button states
    this.headingSubmenu_handler.setBookId(bookId); // Update heading submenu bookId
    this.listConverter.setBookId(bookId); // Update list converter bookId
    this.blockFormatter.setBookId(bookId); // Update block formatter bookId
  }

  /**
   * Attach click handlers to formatting buttons
   */
  attachButtonHandlers() {
    const buttons = [
      {
        element: this.boldButton,
        name: "bold",
        action: () => this.formatText("bold"),
      },
      {
        element: this.italicButton,
        name: "italic",
        action: () => this.formatText("italic"),
      },
      {
        element: this.headingButton,
        name: "heading",
        action: () => {
          // Don't toggle if submenu is already open (prevents double-firing on mobile)
          if (this.headingSubmenu && !this.headingSubmenu.classList.contains("hidden")) {
            return;
          }
          this.headingSubmenu_handler.toggleHeadingSubmenu();
        },
      },
      {
        element: this.blockquoteButton,
        name: "blockquote",
        action: () => this.formatBlock("blockquote"),
      },
      {
        element: this.codeButton,
        name: "code",
        action: () => this.formatBlock("code"),
      },
      {
        element: this.footnoteButton,
        name: "footnote",
        action: () => this.insertFootnote(),
      },
      {
        element: this.citationButton,
        name: "citation",
        action: () => this.openCitationSearch(),
      },
      {
        element: this.undoButton,
        name: "undo",
        action: () => this.historyHandler.handleUndo(),
      },
      {
        element: this.redoButton,
        name: "redo",
        action: () => this.historyHandler.handleRedo(),
      },
    ];

    // Count found buttons for single log
    const foundButtons = buttons.filter(({ element }) => element);

    buttons.forEach(({ element, name, action }) => {
      if (element) {

        // Prevent default behavior that clears selection
        element.addEventListener(
          "touchstart",
          (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Store the current selection using SelectionManager
            this.selectionManager.storeSelectionForTouch(name);
          },
          {
            passive: false,
          }
        );

        element.addEventListener(
          "touchend",
          (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Special check for heading button: don't fire if submenu button was just clicked
            if (name === "heading") {
              const submenuButtonClicked = this.headingSubmenu_handler.wasSubmenuButtonJustClicked();
              if (submenuButtonClicked) {
                return;
              }
            }

            // Small delay to ensure selection is stored
            setTimeout(() => {
              action();
            }, 10);
          },
          {
            passive: false,
          }
        );

        // Keep desktop click handler
        element.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          action();
        });
      }
    });

    // Single consolidated log after initialization
    log.init(`Edit toolbar buttons initialized (${foundButtons.length}/${buttons.length} found)`, '/editToolbar/index.js');
  }

  // Undo/Redo methods delegated to HistoryHandler
  async handleUndo() {
    return this.historyHandler.handleUndo();
  }

  async handleRedo() {
    return this.historyHandler.handleRedo();
  }

  /**
   * Close the heading level submenu
   * Delegated to HeadingSubmenu
   */
  closeHeadingSubmenu() {
    this.headingSubmenu_handler.closeHeadingSubmenu();
  }

  /**
   * Update the active/disabled states of undo/redo buttons.
   */
  // History button states delegated to HistoryHandler
  async updateHistoryButtonStates() {
    return this.historyHandler.updateHistoryButtonStates();
  }

  /**
   * Handle selection changes within the document (only for button states and positioning)
   * Delegates to SelectionManager
   */
  handleSelectionChange() {
    // Delegate selection tracking to SelectionManager
    this.selectionManager.handleSelectionChange(() => {
      this.buttonStateManager.updateButtonStates();
    });
  }

  /**
   * Set edit mode and control toolbar visibility
   * @param {boolean} isEditMode - Whether edit mode is active
   */
  setEditMode(isEditMode) {
    if (isEditMode) {
      this.show();
      // Attach selection change listener via SelectionManager
      this.selectionManager.attachListener(() => this.buttonStateManager.updateButtonStates());
      // Initial button state update
      this.handleSelectionChange();
      this.historyHandler.updateHistoryButtonStates(); // Ensure history buttons are up to date on mode change
    } else {
      this.hide();
      // Close heading submenu if open
      this.closeHeadingSubmenu();
      // Close citation mode if open
      if (this.citationMode.isOpen) {
        this.citationMode.close();
      }
      // Detach selection change listener via SelectionManager
      this.selectionManager.detachListener();
    }
  }

  /**
   * Update the active states of formatting buttons based on current selection
   * Delegates to ButtonStateManager
   */
  updateButtonStates() {
    this.buttonStateManager.updateButtonStates();
  }


  /**
   * Format the selected text with the specified style
   * Delegated to TextFormatter
   */
  async formatText(type) {
    return this.textFormatter.formatText(type);
  }

  /**
   * Format a block element (heading, blockquote, or code)
   * Delegated to BlockFormatter
   */
  async formatBlock(type, headingLevel = "h2") {
    return this.blockFormatter.formatBlock(type, headingLevel);
  }

  /**
   * Toggle the citation search interface (integrated into toolbar)
   * If open, closes it. If closed, opens it.
   */
  async openCitationSearch() {
    // If citation mode is already open, close it
    if (this.citationMode.isOpen) {
      this.citationMode.close();
      return;
    }

    // Get book ID from DOM at insertion time
    const bookId = document.querySelector('.main-content')?.id || this.currentBookId;

    if (!bookId) {
      console.warn("EditToolbar: Cannot open citation search: no book ID found.");
      return;
    }

    // Get current selection using SelectionManager
    const { selection, range } = this.selectionManager.getWorkingSelection();

    if (!range) {
      console.warn("EditToolbar: Cannot insert citation: no cursor position.");
      return;
    }

    // Open citation mode with context
    this.citationMode.open({
      bookId,
      range: range.cloneRange(),
      saveCallback: (id, html, options) => this.saveToIndexedDB(id, html, options)
    });
  }

  /**
   * Insert a footnote at the current cursor position
   */
  async insertFootnote() {
    // Get book ID from DOM at insertion time (more reliable than cached value)
    const bookId = document.querySelector('.main-content')?.id || this.currentBookId;

    if (!bookId) {
      console.warn("EditToolbar: Cannot insert footnote: no book ID found.");
      return;
    }

    // Get current selection using SelectionManager
    const { selection, range } = this.selectionManager.getWorkingSelection();

    if (!range) {
      console.warn("EditToolbar: Cannot insert footnote: no cursor position.");
      return;
    }

    try {
      // Dynamic import to avoid circular dependencies
      const { insertFootnoteAtCursor, openFootnoteForEditing } = await import('../footnotes/footnoteInserter.js');

      // Insert the footnote
      const { footnoteId, supElement } = await insertFootnoteAtCursor(
        range,
        bookId,
        (id, html, options) => this.saveToIndexedDB(id, html, options)
      );

      console.log(`Footnote inserted: ${footnoteId}`);

      // Open the hyperlit container with the footnote
      await openFootnoteForEditing(footnoteId, supElement);

    } catch (error) {
      console.error("Error inserting footnote:", error);
    }
  }

  /**
   * Helper method to update IndexedDB record (for a single item)
   * This now calls updateSingleIndexedDBRecord (in indexedDB.js) which queues for sync.
   * It no longer directly handles history payload or calls addHistoryBatch.
   */
  async saveToIndexedDB(id, html, options = {}) {
    // `id` here is the string ID from the DOM
    console.log(`EditToolbar: saveToIndexedDB called for ID: ${id}`);
    if (!this.currentBookId) {
      console.warn(
        "EditToolbar: Cannot save to IndexedDB: currentBookId is not set."
      );
      return;
    }

    // `updateSingleIndexedDBRecord` will handle parsing ID, processing HTML, and calling `queueForSync`.
    // The history payload for this action will be built by `debouncedMasterSync`.
    await updateSingleIndexedDBRecord({
      id: id,
      html: html,
      action: "update", // This action type is used internally by updateSingleIndexedDBRecord
      book: this.currentBookId,
    }, options);

    console.log(
      `EditToolbar: Queued update for ID: ${id}. History handled by debounced sync.`
    );
    // No direct updateHistoryButtonStates here, as clearRedoHistory (from queueForSync) will trigger it.
  }

  /**
   * Helper method to delete a record from IndexedDB (for a single item).
   * This now calls deleteIndexedDBRecord (in indexedDB.js) which queues for sync.
   * It no longer directly handles history payload or calls addHistoryBatch.
   */
  async deleteFromIndexedDB(id) {
    console.log(`EditToolbar: deleteFromIndexedDB called for ID: ${id}`);
    if (!this.currentBookId) {
      console.warn(
        "EditToolbar: Cannot delete from IndexedDB: currentBookId is not set."
      );
      return;
    }

    // `deleteIndexedDBRecord` will handle parsing ID and calling `queueForSync`.
    // The history payload for this action will be built by `debouncedMasterSync`.
    await deleteIndexedDBRecord(id);

    console.log(
      `EditToolbar: Queued deletion for ID: ${id}. History handled by debounced sync.`
    );
  }

  /**
   * Unwrap selected text from any heading tag (H1-H6)
   * Delegated to BlockFormatter
   */
  async unwrapSelectedTextFromHeading() {
    return this.blockFormatter.unwrapSelectedTextFromHeading();
  }

  /**
   * Show the toolbar
   */
  show() {
    if (this.isDisabled) return;
    if (this.isVisible) return;

    console.log("👁️ EditToolbar: Showing toolbar");

    this.toolbar.classList.add("visible");
    this.isVisible = true;
    this.selectionManager.setVisible(true);
  }

  /**
   * Hide the toolbar
   */
  hide() {
    if (this.isDisabled) return;
    if (!this.isVisible) return;

    this.toolbar.classList.remove("visible");
    this.isVisible = false;
    this.selectionManager.setVisible(false);
  }

  /**
   * Clean up event listeners
   */
  destroy() {
    this.selectionManager.detachListener();
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("click", this.handleClickOutsideSubmenu);
  }

  /**
   * Convert a list item to a block element (blockquote or code)
   * Delegated to ListConverter
   */
  async convertListItemToBlock(listItem, blockType) {
    return this.listConverter.convertListItemToBlock(listItem, blockType);
  }
}

/**
 * Initialize the edit toolbar if it doesn't exist yet
 * @param {object} options - Options for the toolbar, including currentBookId
 */
export function initEditToolbar(options = {}) {
  if (!editToolbarInstance) {
    editToolbarInstance = new EditToolbar(options);
    editToolbarInstance.init();
  } else {
    // If instance exists, but a new book is loaded, update the book ID
    if (
      options.currentBookId &&
      options.currentBookId !== editToolbarInstance.currentBookId
    ) {
      editToolbarInstance.setBookId(options.currentBookId);
    }
  }
  return editToolbarInstance;
}

/**
 * Get the current EditToolbar instance
 */
export function getEditToolbar() {
  return editToolbarInstance;
}

/**
 * Destroy the current EditToolbar instance and clean up resources
 */
export function destroyEditToolbar() {
  if (editToolbarInstance) {
    editToolbarInstance.destroy();
    editToolbarInstance = null;
  }
}
