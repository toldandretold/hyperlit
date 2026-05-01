// EditToolbar - Main orchestrator for toolbar functionality
// Delegates to specialized modules for different formatting operations

import { log } from "../utilities/logger.js";
import {
  updateSingleIndexedDBRecord,
  deleteIndexedDBRecord,
} from "../indexedDB/index.js";
import { SelectionManager } from "./selectionManager.js";
import { ButtonStateManager } from "./buttonStateManager.js";
import { HeadingSubmenu } from "./headingSubmenu.js";
import { CitationMode } from "./citationMode.js";
import { TextFormatter } from "./textFormatter.js";
import { ListConverter } from "./listConverter.js";
import { BlockFormatter } from "./blockFormatter.js";
import { UndoManager, resolveBookId, findBlockFromTarget } from "./undoManager.js";
import { getTextOffsetInElement } from "./toolbarDOMUtils.js";
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
      footnoteButton: this.footnoteButton,
      headingSubmenu: this.headingSubmenu,
      selectionManager: this.selectionManager
    });

    // Initialize UndoManager (unified undo system for all changes)
    this.undoManager = new UndoManager();

    // Initialize HeadingSubmenu
    this.headingSubmenu_handler = new HeadingSubmenu({
      headingSubmenu: this.headingSubmenu,
      headingButton: this.headingButton,
      selectionManager: this.selectionManager,
      buttonStateManager: this.buttonStateManager,
      currentBookId: this.currentBookId,
      formatBlockCallback: (type, level) => this.formatBlock(type, level),
      saveToIndexedDBCallback: (id, html) => this.saveToIndexedDB(id, html),
      undoManager: this.undoManager
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
      convertListItemToBlockCallback: (listItem, type) => this.convertListItemToBlock(listItem, type),
      undoManager: this.undoManager,
    });

    // Bind event handlers
    this.attachButtonHandlers = this.attachButtonHandlers.bind(this);

    this.isVisible = false;
  }

  get isFormatting() {
    return this.blockFormatter?.isCurrentlyFormatting() || false;
  }

  init() {
    if (this.isDisabled) {
      console.log('ℹ️ EditToolbar: Skipping init() - toolbar is disabled due to missing elements');
      return;
    }
    this.attachButtonHandlers();
    this.hide();

    // Initialize tap area extender for mobile (captures taps in gaps below/around buttons)
    // Starts disabled — enabled only while in edit mode
    this.tapExtender = initTapAreaExtender(this.toolbar);

    // NUCLEAR OPTION: Prevent ALL touches below a certain Y threshold when keyboard is open
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      const globalTouchHandler = (e) => {
        // Only intercept when keyboard is open
        const keyboardManager = window.activeKeyboardManager;
        if (!keyboardManager || !keyboardManager.isKeyboardOpen) {
          return;
        }

        const touch = e.touches?.[0] || e.changedTouches?.[0];
        if (!touch) return;

        const touchY = touch.clientY;
        const viewportHeight = window.visualViewport?.height || window.innerHeight;

        // Calculate toolbar area (bottom 15% of visible viewport)
        const toolbarZoneStart = viewportHeight * 0.85;

        // If touch is in the toolbar zone
        if (touchY >= toolbarZoneStart) {
          const target = e.target;

          // Allow touches on buttons and inputs
          if (target.closest('button') || target.closest('input') || target.closest('textarea')) {
            return;
          }

          // Block everything else in the toolbar zone
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      };

      // Attach to DOCUMENT with capture:true to catch as early as possible
      document.addEventListener('touchstart', globalTouchHandler, { capture: true, passive: false });
      document.addEventListener('touchend', globalTouchHandler, { capture: true, passive: false });
      document.addEventListener('touchmove', globalTouchHandler, { capture: true, passive: false });

      console.log('🛡️ Global touch interceptor installed');

      // Also prevent touches on keyboard gap blocker
      const gapBlocker = document.getElementById('keyboard-gap-blocker');
      if (gapBlocker) {
        gapBlocker.addEventListener('touchstart', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }, { capture: true, passive: false });

        gapBlocker.addEventListener('touchend', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }, { capture: true, passive: false });

        gapBlocker.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }, { capture: true, passive: false });

        console.log('🛡️ Gap blocker listeners attached');
      } else {
        console.warn('❌ Gap blocker element NOT found - cannot attach listeners');
      }
    }

    // ── Helper: get the focused block element from the current selection ──
    // e.target on contenteditable is the container itself, NOT the block being
    // edited.  We must walk from the selection's focusNode to the real block.
    const getFocusedBlock = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const node = sel.focusNode;
      if (!node) return null;
      return findBlockFromTarget(node);
    };

    // Same for bookId — resolve from the selection, not from e.target
    const getBookIdFromSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const node = sel.focusNode;
      if (!node) return null;
      return resolveBookId(node);
    };

    // ── Structural inputTypes that need snapshot-before / finalize-after ──
    // Note: Enter is mostly handled by enterKeyHandler.js (which calls
    // preventDefault at keydown level), so insertParagraph rarely reaches here.
    // deleteContentBackward/Forward are treated as typing — block merging
    // from backspace at boundaries is a future enhancement.
    const STRUCTURAL_INPUT_TYPES = new Set([
      'insertParagraph',        // Enter key (fallback if enterKeyHandler doesn't catch it)
    ]);

    // ── beforeinput listener (capture phase) ──
    // Intercepts native undo/redo and captures state for our custom system
    this._beforeInputHandler = (e) => {
      const target = e.target;
      if (!target?.closest?.('[contenteditable="true"]')) return;

      const inputType = e.inputType;

      // Block native undo/redo entirely — we handle it ourselves
      if (inputType === 'historyUndo' || inputType === 'historyRedo') {
        e.preventDefault();
        const bookId = getBookIdFromSelection() || resolveBookId(target);
        if (!bookId) return;

        console.log(`[UndoManager] beforeinput ${inputType}, bookId=${bookId}`);
        if (inputType === 'historyUndo') {
          this.undoManager.undo(
            bookId,
            (id, html, opts) => this.saveToIndexedDB(id, html, opts),
            (flag) => { this.blockFormatter.isFormatting = flag; }
          );
        } else {
          this.undoManager.redo(
            bookId,
            (id, html, opts) => this.saveToIndexedDB(id, html, opts),
            (flag) => { this.blockFormatter.isFormatting = flag; }
          );
        }
        this._updateUndoRedoButtons(bookId);
        return;
      }

      // For structural changes, snapshot before the browser modifies the DOM
      if (STRUCTURAL_INPUT_TYPES.has(inputType)) {
        const blockEl = getFocusedBlock();
        const bookId = getBookIdFromSelection() || resolveBookId(target);
        if (blockEl && bookId) {
          this.undoManager.snapshotForStructural(bookId, blockEl);
        }
        return;
      }

      // For typing-class events, start capturing
      const blockEl = getFocusedBlock();
      const bookId = getBookIdFromSelection() || resolveBookId(target);
      if (blockEl && bookId) {
        this.undoManager.startCapture(blockEl, bookId);
      }
    };
    document.addEventListener('beforeinput', this._beforeInputHandler, true);

    // ── input listener (capture phase) ──
    // Finalizes captures after the browser has modified the DOM
    this._inputHandler = (e) => {
      const target = e.target;
      if (!target?.closest?.('[contenteditable="true"]')) return;

      const inputType = e.inputType;
      const bookId = getBookIdFromSelection() || resolveBookId(target);
      if (!bookId) return;

      // Structural changes: finalize the snapshot comparison
      if (STRUCTURAL_INPUT_TYPES.has(inputType)) {
        this.undoManager.finalizeStructural(bookId);
        this._updateUndoRedoButtons(bookId);
        return;
      }

      // Typing-class events: finalize the capture
      const blockEl = getFocusedBlock();
      if (blockEl) {
        this.undoManager.finalizeCapture(blockEl, bookId, inputType);
        this._updateUndoRedoButtons(bookId);
      }
    };
    document.addEventListener('input', this._inputHandler, true);

    // ── Keydown handler (capture phase — safety net) ──
    // Catches Cmd/Ctrl+Z in edge cases where beforeinput doesn't fire.
    // Also the primary handler since keydown fires BEFORE beforeinput —
    // when we preventDefault here, beforeinput for historyUndo won't fire.
    this._undoKeydownHandler = (e) => {
      const active = document.activeElement;
      if (!active || !active.closest('[contenteditable="true"]')) return;

      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta || e.key.toLowerCase() !== 'z') return;

      const bookId = getBookIdFromSelection() || resolveBookId(active);
      if (!bookId) return;

      if (e.shiftKey) {
        if (this.undoManager.hasRedo(bookId)) {
          e.preventDefault();
          e.stopPropagation();
          console.log(`[UndoManager] Cmd+Shift+Z → redo, bookId=${bookId}`);
          this.undoManager.redo(
            bookId,
            (id, html, opts) => this.saveToIndexedDB(id, html, opts),
            (flag) => { this.blockFormatter.isFormatting = flag; }
          );
          this._updateUndoRedoButtons(bookId);
        }
      } else {
        if (this.undoManager.hasUndo(bookId) || this.undoManager.hasAnyUndo()) {
          e.preventDefault();
          e.stopPropagation();
          console.log(`[UndoManager] Cmd+Z → undo, bookId=${bookId}, stackSize=${this.undoManager._getStacks(bookId).undoStack.length}, hasGroup=${!!this.undoManager._currentGroup}`);
          this.undoManager.undo(
            bookId,
            (id, html, opts) => this.saveToIndexedDB(id, html, opts),
            (flag) => { this.blockFormatter.isFormatting = flag; }
          );
          this._updateUndoRedoButtons(bookId);
        }
      }
    };
    document.addEventListener('keydown', this._undoKeydownHandler, true);

    this._updateUndoRedoButtons(this.currentBookId); // Set initial state of undo/redo buttons
  }

  /**
   * Sets the current book ID and updates history button states.
   * Call this when your main application loads a new book.
   * @param {string} bookId The ID of the currently loaded book.
   */
  setBookId(bookId) {
    if (this.isDisabled) return;
    this.currentBookId = bookId;
    this._updateUndoRedoButtons(bookId); // Refresh button states
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
        action: () => this._handleUndoButton(),
      },
      {
        element: this.redoButton,
        name: "redo",
        action: () => this._handleRedoButton(),
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

        // Desktop: prevent focus moving to button on mousedown (preserves selection)
        element.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });

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

  /**
   * Handle undo button tap/click — routes through the new UndoManager
   */
  _handleUndoButton() {
    const bookId = resolveBookId(document.activeElement) || this.currentBookId;
    if (!bookId) return;
    this.undoManager.undo(
      bookId,
      (id, html, opts) => this.saveToIndexedDB(id, html, opts),
      (flag) => { this.blockFormatter.isFormatting = flag; }
    );
    this._updateUndoRedoButtons(bookId);
  }

  /**
   * Handle redo button tap/click — routes through the new UndoManager
   */
  _handleRedoButton() {
    const bookId = resolveBookId(document.activeElement) || this.currentBookId;
    if (!bookId) return;
    this.undoManager.redo(
      bookId,
      (id, html, opts) => this.saveToIndexedDB(id, html, opts),
      (flag) => { this.blockFormatter.isFormatting = flag; }
    );
    this._updateUndoRedoButtons(bookId);
  }

  /**
   * Synchronously toggle disabled state on undo/redo buttons
   * based on current UndoManager stack state.
   */
  _updateUndoRedoButtons(bookId) {
    if (this.undoButton) {
      const can = this.undoManager.hasUndo(bookId) || this.undoManager.hasAnyUndo();
      this.undoButton.classList.toggle('disabled', !can);
      this.undoButton.disabled = !can;
    }
    if (this.redoButton) {
      const can = this.undoManager.hasRedo(bookId);
      this.redoButton.classList.toggle('disabled', !can);
      this.redoButton.disabled = !can;
    }
  }

  /**
   * Close the heading level submenu
   * Delegated to HeadingSubmenu
   */
  closeHeadingSubmenu() {
    this.headingSubmenu_handler.closeHeadingSubmenu();
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
      this.tapExtender?.enable();
      // Attach selection change listener via SelectionManager
      this.selectionManager.attachListener(() => this.buttonStateManager.updateButtonStates());
      // Initial button state update
      this.handleSelectionChange();
      this._updateUndoRedoButtons(this.currentBookId); // Ensure undo/redo buttons are up to date on mode change
    } else {
      this.hide();
      this.tapExtender?.disable();
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

    // Get current selection using SelectionManager
    const { selection, range } = this.selectionManager.getWorkingSelection();

    // Resolve bookId from the selection's DOM position (sub-book aware)
    const rangeEl = range?.commonAncestorContainer;
    const containerEl = rangeEl?.nodeType === Node.TEXT_NODE ? rangeEl.parentElement : rangeEl;
    const subBookEl = containerEl?.closest('[data-book-id]');
    const bookId = subBookEl?.dataset?.bookId
      || this.currentBookId
      || document.querySelector('.main-content')?.id;

    if (!bookId) {
      console.warn("EditToolbar: Cannot open citation search: no book ID found.");
      return;
    }

    if (!range) {
      console.warn("EditToolbar: Cannot insert citation: no cursor position.");
      return;
    }

    // Snapshot the block before citation insertion for undo tracking
    const blockEl = findBlockFromTarget(range.startContainer);
    let undoSnapshot = null;
    if (blockEl && blockEl.id) {
      this.undoManager.sealGroup();
      let cursorBefore = 0;
      try {
        cursorBefore = getTextOffsetInElement(blockEl, range.startContainer, range.startOffset);
      } catch (e) { /* ignore */ }
      undoSnapshot = { elementId: blockEl.id, oldHTML: blockEl.innerHTML, cursorBefore };
    }

    // Open citation mode with context (includes undo info)
    this.citationMode.open({
      bookId,
      range: range.cloneRange(),
      saveCallback: (id, html, options) => this.saveToIndexedDB(id, html, options),
      undoSnapshot,
      undoManager: this.undoManager,
    });
  }

  /**
   * Insert a footnote at the current cursor position
   */
  async insertFootnote() {
    // Get current selection using SelectionManager
    const { selection, range } = this.selectionManager.getWorkingSelection();

    // Walk up from selection to find sub-book container, fall back to main-content
    const anchorEl = selection?.anchorNode?.nodeType === Node.TEXT_NODE
      ? selection.anchorNode.parentElement
      : selection?.anchorNode;
    const subBookEl = anchorEl?.closest('[data-book-id][contenteditable="true"]');
    const bookId = subBookEl?.dataset?.bookId
      || document.querySelector('.main-content')?.id
      || this.currentBookId;

    if (!bookId) {
      console.warn("EditToolbar: Cannot insert footnote: no book ID found.");
      return;
    }

    if (!range) {
      console.warn("EditToolbar: Cannot insert footnote: no cursor position.");
      return;
    }

    try {
      // Dynamic import to avoid circular dependencies
      const { insertFootnoteAtCursor, openFootnoteForEditing } = await import('../footnotes/footnoteInserter.js');

      // Snapshot the parent block BEFORE insertion for undo tracking
      const focusNode = selection.focusNode;
      const blockEl = findBlockFromTarget(focusNode);
      const oldHTML = blockEl ? blockEl.innerHTML : null;
      let cursorBefore = 0;
      if (blockEl) {
        try {
          cursorBefore = getTextOffsetInElement(blockEl, focusNode, selection.focusOffset);
        } catch (e) { /* ignore */ }
      }

      // Seal any pending typing group before the footnote insertion
      this.undoManager.sealGroup();

      // Insert the footnote
      const { footnoteId, supElement } = await insertFootnoteAtCursor(
        range,
        bookId,
        (id, html, options) => this.saveToIndexedDB(id, html, options)
      );

      console.log(`Footnote inserted: ${footnoteId}`);

      // Record the insertion as an input entry (sup added to block innerHTML).
      // Footnote record stays in IndexedDB on undo — only the <sup> is removed/restored.
      if (blockEl && blockEl.id && oldHTML !== null) {
        const newHTML = blockEl.innerHTML;
        if (oldHTML !== newHTML) {
          let cursorAfter = 0;
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            try {
              cursorAfter = getTextOffsetInElement(blockEl, sel.focusNode, sel.focusOffset);
            } catch (e) { /* ignore */ }
          }

          this.undoManager._pushUndo(bookId, {
            type: 'input',
            elementId: blockEl.id,
            oldHTML,
            newHTML,
            bookId,
            cursorBefore,
            cursorAfter,
          });
          console.log(`[UndoManager] Recorded footnote insertion for undo on #${blockEl.id}`);
          this._updateUndoRedoButtons(bookId);
        }
      }

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

    // Derive the correct book from where the element actually lives in the DOM.
    // When editing a sub-book the element is inside [data-book-id][contenteditable],
    // so we use that book ID rather than this.currentBookId (which may still point
    // to the main book if setBookId(subBookId) hasn't been called yet).
    const element = document.getElementById(id);
    const subBookEl = element?.closest('[data-book-id][contenteditable="true"]');
    const bookId = subBookEl?.dataset?.bookId || this.currentBookId;

    if (!bookId) {
      console.warn("EditToolbar: Cannot save to IndexedDB: book ID not found.");
      return;
    }

    // `updateSingleIndexedDBRecord` will handle parsing ID, processing HTML, and calling `queueForSync`.
    // The history payload for this action will be built by `debouncedMasterSync`.
    await updateSingleIndexedDBRecord({
      id: id,
      html: html,
      action: "update", // This action type is used internally by updateSingleIndexedDBRecord
      book: bookId,
    }, options);

    console.log(
      `EditToolbar: Queued update for ID: ${id}. History handled by debounced sync.`
    );
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

    // Clear any inline positioning styles to let CSS handle it
    // (unless keyboard is open and keyboardManager is controlling position)
    const keyboardIsOpen = window.activeKeyboardManager && window.activeKeyboardManager.isKeyboardOpen;
    if (!keyboardIsOpen) {
      this.toolbar.style.removeProperty('left');
      this.toolbar.style.removeProperty('right');
      this.toolbar.style.removeProperty('transform');
      this.toolbar.style.removeProperty('width');
      this.toolbar.style.removeProperty('top');
    }
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

    // Clear inline positioning styles when hiding
    this.toolbar.style.removeProperty('left');
    this.toolbar.style.removeProperty('right');
    this.toolbar.style.removeProperty('transform');
    this.toolbar.style.removeProperty('width');
    this.toolbar.style.removeProperty('top');
  }

  /**
   * Clean up event listeners
   */
  destroy() {
    this.selectionManager.detachListener();
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("click", this.handleClickOutsideSubmenu);
    if (this._undoKeydownHandler) {
      document.removeEventListener('keydown', this._undoKeydownHandler, true);
    }
    if (this._beforeInputHandler) {
      document.removeEventListener('beforeinput', this._beforeInputHandler, true);
    }
    if (this._inputHandler) {
      document.removeEventListener('input', this._inputHandler, true);
    }
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
