// EditToolbar - Main orchestrator for toolbar functionality
// Delegates to specialized modules for different formatting operations

import {
  updateIndexedDBRecord,
  deleteIndexedDBRecord,
} from "../indexedDB.js";
import { SelectionManager } from "./selectionManager.js";
import { ButtonStateManager } from "./buttonStateManager.js";
import { HistoryHandler } from "./historyHandler.js";
import { HeadingSubmenu } from "./headingSubmenu.js";
import { TextFormatter } from "./textFormatter.js";
import { ListConverter } from "./listConverter.js";
import { BlockFormatter } from "./blockFormatter.js";
import { setCurrentBookId } from "../historyManager.js";

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

    buttons.forEach(({ element, name, action }) => {
      if (element) {
        console.log(`✅ ${name} button found:`, element);

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

            console.log(`📱 ${name} touchend - executing action`);

            // Special check for heading button: don't fire if submenu button was just clicked
            if (name === "heading") {
              const submenuButtonClicked = this.headingSubmenu_handler.wasSubmenuButtonJustClicked();
              console.log("🔍 Checking flag for heading button:", submenuButtonClicked);
              if (submenuButtonClicked) {
                console.log("⏭️ Skipping heading button - submenu button was just clicked");
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
          console.log(`🖱️ ${name} button click handler triggered - isMobile: ${this.isMobile}`, e.target);
          console.log(`🖱️ ${name} button clicked!`, e);
          e.preventDefault();
          e.stopPropagation();
          action();
        });
      } else {
        console.log(`❌ ${name} button NOT found`);
      }
    });
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
   * Helper method to update IndexedDB record (for a single item)
   * This now calls updateIndexedDBRecord (in indexedDB.js) which queues for sync.
   * It no longer directly handles history payload or calls addHistoryBatch.
   */
  async saveToIndexedDB(id, html) {
    // `id` here is the string ID from the DOM
    console.log(`EditToolbar: saveToIndexedDB called for ID: ${id}`);
    if (!this.currentBookId) {
      console.warn(
        "EditToolbar: Cannot save to IndexedDB: currentBookId is not set."
      );
      return;
    }

    // `updateIndexedDBRecord` will handle parsing ID, processing HTML, and calling `queueForSync`.
    // The history payload for this action will be built by `debouncedMasterSync`.
    await updateIndexedDBRecord({
      id: id,
      html: html,
      action: "update", // This action type is used internally by updateIndexedDBRecord
      book: this.currentBookId,
    });

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

    console.log("🧹 EditToolbar: Destroyed and cleaned up");
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
