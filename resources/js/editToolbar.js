// In edit-toolbar.js

import {
  updateIndexedDBRecord,
  batchUpdateIndexedDBRecords,
  deleteIndexedDBRecord,
  batchDeleteIndexedDBRecords,
  getNodeChunkFromIndexedDB,
  parseNodeId,
  openDatabase,
  debouncedMasterSync,
  pendingSyncs,
} from "./cache-indexedDB.js";
import {
  generateIdBetween,
  setElementIds,
  findPreviousElementId,
  findNextElementId,
} from "./IDfunctions.js";
import {
  undoLastBatch,
  redoLastBatch,
  canUndo,
  canRedo,
  setCurrentBookId,
} from "./historyManager.js";
import { currentLazyLoader } from "./initializePage.js";

// Private module-level variable to hold the toolbar instance
let editToolbarInstance = null;

// ✅ NEW: Helper function to yield to the browser's main thread.
/**
 * Pauses execution and yields to the main thread, allowing the event loop
 * to process pending operations like IndexedDB commits.
 */
function yieldToMainThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * EditToolbar class for handling formatting controls in editable content
 */
class EditToolbar {
  // ... constructor and all other methods are unchanged ...
  constructor(options = {}) {
    this.toolbarId = options.toolbarId || "edit-toolbar";
    this.editableSelector =
      options.editableSelector || ".main-content[contenteditable='true']";
    this.currentBookId = options.currentBookId || null; // ✅ NEW: Accept currentBookId

    this.toolbar = document.getElementById(this.toolbarId);
    if (!this.toolbar) {
      console.log(`ℹ️ EditToolbar: Element with id "${this.toolbarId}" not found. Skipping toolbar initialization.`);
      this.isDisabled = true;
      return;
    }

    this.boldButton = document.getElementById("boldButton");
    this.italicButton = document.getElementById("italicButton");
    this.headingButton = document.getElementById("headingButton");
    this.blockquoteButton = document.getElementById("blockquoteButton");
    this.codeButton = document.getElementById("codeButton");
    this.undoButton = document.getElementById("undoButton");
    this.redoButton = document.getElementById("redoButton");

    this.isMobile = window.innerWidth <= 768;

    // Bind event handlers
    this.handleSelectionChange = this.handleSelectionChange.bind(this);
    this.attachButtonHandlers = this.attachButtonHandlers.bind(this);
    this.updateHistoryButtonStates =
      this.updateHistoryButtonStates.bind(this); // ✅ NEW: Bind this method

    this.isVisible = false;
    this.currentSelection = null;
    this.isFormatting = false;
    this.lastValidRange = null;

    this.isProcessingHistory = false;

    if (this.isMobile) {
      this.mobileBackupRange = null;
      this.mobileBackupText = "";
      this.mobileBackupContainer = null;
    }
  }

  init() {
    if (this.isDisabled) {
      console.log('ℹ️ EditToolbar: Skipping init() - toolbar is disabled due to missing elements');
      return;
    }
    this.attachButtonHandlers();
    this.hide();
    // ✅ NEW: Set the initial book ID in historyManager
    if (this.currentBookId) {
      setCurrentBookId(this.currentBookId);
    }
    this.updateHistoryButtonStates(); // Set initial state of undo/redo buttons
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
    this.updateHistoryButtonStates(); // Refresh button states
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
        action: () => this.formatBlock("heading"),
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
        action: () => this.handleUndo(),
      },
      {
        element: this.redoButton,
        name: "redo",
        action: () => this.handleRedo(),
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

            // Store the current selection immediately
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
              this.lastValidRange = selection.getRangeAt(0).cloneRange();
              console.log(
                `📱 ${name} touchstart - stored selection:`,
                this.lastValidRange.toString()
              );
            }
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

  async handleUndo() {
    if (this.isProcessingHistory) {
      console.log("⏳ Undo/Redo already in progress. Please wait.");
      return;
    }
    this.isProcessingHistory = true;
    this.updateHistoryButtonStates();

    try {
      if (pendingSyncs.size > 0) {
        console.log("🌀 Pending changes detected. Flushing sync before undoing...");
        await debouncedMasterSync.flush();
        console.log("✅ Flush complete.");
      }

      const targetId = await undoLastBatch();

      if (targetId && currentLazyLoader) {
        await currentLazyLoader.refresh(targetId);
      } else if (targetId) {
        window.location.reload();
      }
    } catch (error) {
      console.error("❌ Error during undo operation:", error);
    } finally {
      console.log("Yielding to main thread before releasing lock...");
      await yieldToMainThread();

      this.isProcessingHistory = false;
      this.updateHistoryButtonStates();
      console.log("✅ Undo/Redo lock released.");
    }
  }

  // ✅ FINAL, CORRECTED VERSION OF handleRedo
  async handleRedo() {
    if (this.isProcessingHistory) {
      console.log("⏳ Undo/Redo already in progress. Please wait.");
      return;
    }
    this.isProcessingHistory = true;
    this.updateHistoryButtonStates();

    try {
      const targetId = await redoLastBatch();

      if (targetId && currentLazyLoader) {
        await currentLazyLoader.refresh(targetId);
      } else if (targetId) {
        window.location.reload();
      }
    } catch (error) {
      console.error("❌ Error during redo operation:", error);
    } finally {
      console.log("Yielding to main thread before releasing lock...");
      await yieldToMainThread();

      this.isProcessingHistory = false;
      this.updateHistoryButtonStates();
      console.log("✅ Undo/Redo lock released.");
    }
  }

  /**
   * Update the active/disabled states of undo/redo buttons.
   */
  async updateHistoryButtonStates() {
    if (this.isDisabled) return;
    console.log("Updating history button states...");

    // ✅ RE-ACQUIRE REFERENCES TO THE BUTTONS HERE
    // This is vital because the DOM might have been rebuilt by lazyLoaderFactory.refresh()
    this.undoButton = document.getElementById("undoButton");
    this.redoButton = document.getElementById("redoButton");

    if (this.undoButton) {
      const canCurrentlyUndo = await canUndo();
      console.log(
        `Undo button: isProcessingHistory=${this.isProcessingHistory}, canCurrentlyUndo=${canCurrentlyUndo}`
      );
      this.undoButton.classList.toggle("processing", this.isProcessingHistory);
      this.undoButton.classList.toggle(
        "disabled",
        this.isProcessingHistory || !canCurrentlyUndo
      );
      this.undoButton.disabled =
        this.isProcessingHistory || !canCurrentlyUndo; // Disable button element
    } else {
      console.warn("Undo button not found in DOM.");
    }

    if (this.redoButton) {
      const canCurrentlyRedo = await canRedo();
      console.log(
        `Redo button: isProcessingHistory=${this.isProcessingHistory}, canCurrentlyRedo=${canCurrentlyRedo}`
      );
      this.redoButton.classList.toggle("processing", this.isProcessingHistory);
      this.redoButton.classList.toggle(
        "disabled",
        this.isProcessingHistory || !canCurrentlyRedo
      );
      this.redoButton.disabled =
        this.isProcessingHistory || !canCurrentlyRedo; // Disable button element
    } else {
      console.warn("Redo button not found in DOM.");
    }
  }

  /**
   * Handle selection changes within the document (only for button states and positioning)
   */
  handleSelectionChange() {
    const selection = window.getSelection();
    console.log("🔍 Selection change detected:", {
      hasSelection: !!selection,
      rangeCount: selection?.rangeCount,
      isCollapsed: selection?.isCollapsed,
      toolbarVisible: this.isVisible,
    });

    if (!selection || selection.rangeCount === 0) return;

    // Only update button states and position if toolbar is visible
    if (this.isVisible) {
      const editableContent = document.querySelector(this.editableSelector);
      if (editableContent) {
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;

        console.log("🎯 Selection container:", {
          container: container,
          containerParent: container.parentElement,
          containerId: container.id || container.parentElement?.id,
          isInEditable: editableContent.contains(container),
        });

        // Check if selection is coming from toolbar button click
        const isFromToolbar = container.closest && container.closest('#edit-toolbar');
        if (isFromToolbar) {
          console.log("🔧 Selection change from toolbar button - ignoring to preserve selection");
          return; // Don't update anything if selection changed due to toolbar button click
        }

        // Store selection if it's within editable content
        if (editableContent.contains(container)) {
          // STORE THE VALID SELECTION
          this.currentSelection = selection;
          this.lastValidRange = range.cloneRange();

          // On mobile, also store additional backup info
          if (this.isMobile) {
            this.mobileBackupRange = range.cloneRange();
            this.mobileBackupText = selection.toString();
            this.mobileBackupContainer = container;
            console.log("📱 Mobile backup stored:", {
              text: this.mobileBackupText,
              container: this.mobileBackupContainer,
            });
          }

          this.updateButtonStates();
          // this.updateHistoryButtonStates(); // Not strictly needed on every selection change,
          // but can be added if you want super-responsive updates.
          // Better to call it after history-modifying actions.
        }
      }
    }
  }

  /**
   * Set edit mode and control toolbar visibility
   * @param {boolean} isEditMode - Whether edit mode is active
   */
  setEditMode(isEditMode) {
    if (isEditMode) {
      this.show();
      // Re-add selection change listener when in edit mode
      document.addEventListener("selectionchange", this.handleSelectionChange);
      // Initial button state update
      this.handleSelectionChange();
      this.updateHistoryButtonStates(); // Ensure history buttons are up to date on mode change
    } else {
      this.hide();
      // Remove selection change listener when not in edit mode
      document.removeEventListener(
        "selectionchange",
        this.handleSelectionChange
      );
    }
  }

  /**
   * Update the active states of formatting buttons based on current selection
   */
  updateButtonStates() {
    if (!this.currentSelection) return;

    const parentElement = this.getSelectionParentElement();
    const isTextSelected = !this.currentSelection.isCollapsed;

    // Check if selection/cursor is in paragraph context (for blockquote/code)
    let isInParagraphContext = true;
    if (isTextSelected && this.currentSelection.rangeCount > 0) {
      // Multi-block selection: check all blocks are paragraphs
      const range = this.currentSelection.getRangeAt(0);
      const affectedBlocks = this.getBlockElementsInRange(range);
      if (affectedBlocks.length > 0) {
        isInParagraphContext = affectedBlocks.every(block => block.tagName === 'P');
      }
    } else {
      // Cursor-only: check current block is a paragraph (or already blockquote/code)
      const blockParent = this.findClosestBlockParent(parentElement);
      if (blockParent) {
        isInParagraphContext = blockParent.tagName === 'P' ||
                               blockParent.tagName === 'BLOCKQUOTE' ||
                               blockParent.tagName === 'PRE';
      }
    }

    // Update bold button state
    // NOTE: Don't use queryCommandState("bold") as it returns true for headings (CSS bold)
    if (this.boldButton) {
      const isBold = this.hasParentWithTag(parentElement, "STRONG") ||
                     this.hasParentWithTag(parentElement, "B");
      this.boldButton.classList.toggle("active", isBold);
    }

    // Update italic button state
    // NOTE: Don't use queryCommandState("italic") as it may return false positives
    if (this.italicButton) {
      const isItalic = this.hasParentWithTag(parentElement, "EM") ||
                       this.hasParentWithTag(parentElement, "I");
      this.italicButton.classList.toggle("active", isItalic);
    }

    // Update heading button state
    if (this.headingButton) {
      this.headingButton.classList.toggle(
        "active",
        this.hasParentWithTag(parentElement, "H1") ||
          this.hasParentWithTag(parentElement, "H2") ||
          this.hasParentWithTag(parentElement, "H3") ||
          this.hasParentWithTag(parentElement, "H4") ||
          this.hasParentWithTag(parentElement, "H5") ||
          this.hasParentWithTag(parentElement, "H6")
      );
    }

    // Update blockquote button state
    if (this.blockquoteButton) {
      const isActive = this.hasParentWithTag(parentElement, "BLOCKQUOTE");
      this.blockquoteButton.classList.toggle("active", isActive);

      // Disable if not in paragraph context (applies to both selection and cursor)
      const shouldDisable = !isInParagraphContext && !isActive;
      this.blockquoteButton.classList.toggle("disabled", shouldDisable);
      this.blockquoteButton.disabled = shouldDisable;
    }

    // Update code button state
    if (this.codeButton) {
      const isActive = this.hasParentWithTag(parentElement, "CODE") ||
                       this.hasParentWithTag(parentElement, "PRE");
      this.codeButton.classList.toggle("active", isActive);

      // Disable if not in paragraph context (applies to both selection and cursor)
      const shouldDisable = !isInParagraphContext && !isActive;
      this.codeButton.classList.toggle("disabled", shouldDisable);
      this.codeButton.disabled = shouldDisable;
    }
  }

  /**
   * Get the parent element of the current selection
   */
  getSelectionParentElement() {
    if (!this.currentSelection) return null;

    let parent = null;
    if (this.currentSelection.rangeCount > 0) {
      parent = this.currentSelection.getRangeAt(0).commonAncestorContainer;

      // If the parent is a text node, get its parent element
      if (parent.nodeType === 3) {
        parent = parent.parentNode;
      }
    }

    return parent;
  }

  /**
   * Check if element or any of its parents has the specified tag
   */
  hasParentWithTag(element, tagName) {
    if (!element) return false;

    if (element.tagName === tagName) {
      return true;
    }

    return element.parentNode && element.parentNode.nodeType === 1
      ? this.hasParentWithTag(element.parentNode, tagName)
      : false;
  }
  /**
   * Format the selected text with the specified style
   */
  async formatText(type) {
    console.log("🔧 Format text called:", {
      type: type,
      hasCurrentSelection: !!this.currentSelection,
      hasLastValidRange: !!this.lastValidRange,
      isCollapsed: this.currentSelection?.isCollapsed,
      currentSelectionText: this.currentSelection?.toString(),
    });

    this.isFormatting = true;

    try {
      const editableContent = document.querySelector(this.editableSelector);
      if (!editableContent) return;

      let workingSelection = this.currentSelection;
      let workingRange = null;

      if (
        this.lastValidRange &&
        editableContent.contains(this.lastValidRange.commonAncestorContainer)
      ) {
        try {
          workingSelection = window.getSelection();
          workingSelection.removeAllRanges();
          workingSelection.addRange(this.lastValidRange.cloneRange());
          workingRange = this.lastValidRange.cloneRange();
          console.log(
            "🔄 Restored valid selection to:",
            workingRange.commonAncestorContainer
          );
        } catch (e) {
          console.warn("Failed to restore lastValidRange:", e);
          workingSelection = null;
          workingRange = null;
        }
      }

      if (!workingSelection || !workingRange) {
        workingSelection = window.getSelection();
        if (workingSelection && workingSelection.rangeCount > 0) {
          workingRange = workingSelection.getRangeAt(0);
        }
      }

      if (!workingSelection || !workingRange) {
        console.warn("❌ No valid selection found - cannot format");
        return;
      }

      this.currentSelection = workingSelection;
      editableContent.focus();

      const affectedElementsBefore =
        this.getElementsInSelectionRange(workingRange);
      const originalStates = affectedElementsBefore.map((el) => ({
        id: el.id,
        html: el.outerHTML,
      }));

      const isTextSelected = !this.currentSelection.isCollapsed;
      const parentElement = this.getSelectionParentElement();

      let modifiedElementId = null;
      let newElement = null;

      switch (type) {
        case "bold":
          if (isTextSelected) {
            // Check if we're in a heading (execCommand gets confused due to CSS bold)
            const blockParent = this.findClosestBlockParent(parentElement);
            const isInHeading = blockParent && /^H[1-6]$/.test(blockParent.tagName);

            if (isInHeading) {
              // Manual <strong> wrapping for headings
              const range = this.currentSelection.getRangeAt(0);
              const selectedText = range.extractContents();
              const strong = document.createElement("strong");
              strong.appendChild(selectedText);
              range.insertNode(strong);

              // Restore selection
              const newRange = document.createRange();
              newRange.selectNodeContents(strong);
              this.currentSelection.removeAllRanges();
              this.currentSelection.addRange(newRange);

              modifiedElementId = blockParent.id;
              newElement = blockParent;
            } else {
              // Use native execCommand for paragraphs/blockquotes
              document.execCommand("bold", false, null);
              const parentAfterBold = this.getSelectionParentElement();
              const blockParentAfter = this.findClosestBlockParent(parentAfterBold);
              if (blockParentAfter && blockParentAfter.id) {
                modifiedElementId = blockParentAfter.id;
                newElement = blockParentAfter;
              }
            }
          } else {
            // Cursor-only bold (no selection)
            const currentOffset = this.getTextOffsetInElement(
              parentElement,
              this.currentSelection.focusNode,
              this.currentSelection.focusOffset
            );

            const blockParent = this.findClosestBlockParent(parentElement);
            const isInHeading = blockParent && /^H[1-6]$/.test(blockParent.tagName);

            if (
              this.hasParentWithTag(parentElement, "STRONG") ||
              this.hasParentWithTag(parentElement, "B")
            ) {
              // UNWRAP: Remove existing bold
              const boldElement =
                this.findParentWithTag(parentElement, "STRONG") ||
                this.findParentWithTag(parentElement, "B");
              if (boldElement) {
                const newTextNode = document.createTextNode(
                  boldElement.textContent
                );
                const parentNode = boldElement.parentNode;
                parentNode.replaceChild(newTextNode, boldElement);
                this.setCursorAtTextOffset(parentNode, currentOffset);
                const blockParentAfter = this.findClosestBlockParent(parentNode);
                if (blockParentAfter && blockParentAfter.id) {
                  modifiedElementId = blockParentAfter.id;
                  newElement = blockParentAfter;
                }
              }
            } else {
              // WRAP: Add bold to current text node
              let node = this.currentSelection.focusNode;
              if (node.nodeType !== Node.TEXT_NODE) {
                const walker = document.createTreeWalker(
                  node,
                  NodeFilter.SHOW_TEXT
                );
                node = walker.nextNode();
              }

              if (node && node.nodeType === Node.TEXT_NODE) {
                if (isInHeading) {
                  // Manual <strong> wrapping for headings
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  const selectedText = range.extractContents();
                  const strong = document.createElement("strong");
                  strong.appendChild(selectedText);
                  range.insertNode(strong);

                  this.setCursorAtTextOffset(strong, currentOffset);
                  modifiedElementId = blockParent.id;
                  newElement = blockParent;
                } else {
                  // Use execCommand for paragraphs
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  this.currentSelection.removeAllRanges();
                  this.currentSelection.addRange(range);
                  document.execCommand("bold", false, null);
                  const newBoldNode =
                    this.findParentWithTag(node.parentNode, "STRONG") ||
                    this.findParentWithTag(node.parentNode, "B");
                  if (newBoldNode) {
                    this.setCursorAtTextOffset(newBoldNode, currentOffset);
                    const blockParentAfter = this.findClosestBlockParent(newBoldNode);
                    if (blockParentAfter && blockParentAfter.id) {
                      modifiedElementId = blockParentAfter.id;
                      newElement = blockParentAfter;
                    }
                  }
                }
              }
            }
          }
          break;

        case "italic":
          if (isTextSelected) {
            document.execCommand("italic", false, null);
            const parentAfterItalic = this.getSelectionParentElement();
            const blockParent = this.findClosestBlockParent(parentAfterItalic);
            if (blockParent && blockParent.id) {
              modifiedElementId = blockParent.id;
              newElement = blockParent;
            }
          } else {
            const currentOffset = this.getTextOffsetInElement(
              parentElement,
              this.currentSelection.focusNode,
              this.currentSelection.focusOffset
            );

            if (
              this.hasParentWithTag(parentElement, "EM") ||
              this.hasParentWithTag(parentElement, "I")
            ) {
              const italicElement =
                this.findParentWithTag(parentElement, "EM") ||
                this.findParentWithTag(parentElement, "I");
              if (italicElement) {
                const newTextNode = document.createTextNode(
                  italicElement.textContent
                );
                const parentNode = italicElement.parentNode;
                parentNode.replaceChild(newTextNode, italicElement);
                this.setCursorAtTextOffset(parentNode, currentOffset);
                const blockParent = this.findClosestBlockParent(parentNode);
                if (blockParent && blockParent.id) {
                  modifiedElementId = blockParent.id;
                  newElement = blockParent;
                }
              }
            } else {
              let node = this.currentSelection.focusNode;
              if (node.nodeType !== Node.TEXT_NODE) {
                const walker = document.createTreeWalker(
                  node,
                  NodeFilter.SHOW_TEXT
                );
                node = walker.nextNode();
              }

              if (node && node.nodeType === Node.TEXT_NODE) {
                const range = document.createRange();
                range.selectNodeContents(node);
                this.currentSelection.removeAllRanges();
                this.currentSelection.addRange(range);
                document.execCommand("italic", false, null);
                const newItalicNode =
                  this.findParentWithTag(node.parentNode, "EM") ||
                  this.findParentWithTag(node.parentNode, "I");
                if (newItalicNode) {
                  this.setCursorAtTextOffset(newItalicNode, currentOffset);
                  const blockParent =
                    this.findClosestBlockParent(newItalicNode);
                  if (blockParent && blockParent.id) {
                    modifiedElementId = blockParent.id;
                    newElement = blockParent;
                  }
                }
              }
            }
          }
          break;
      }

      this.updateButtonStates();

      // REMOVED ALL HISTORY/SAVE BLOCK from formatText
      const handleHistoryAndSave = async () => {
        // Define an inner async function
        // Removed originalStates capture and complex historyPayload logic from here.
        // It's now handled by debouncedMasterSync's read of current/previous states.
        const affectedElementsAfter = []; // Still useful for knowing what to save
        if (modifiedElementId && document.getElementById(modifiedElementId)) {
          affectedElementsAfter.push({
            id: modifiedElementId,
            html: document.getElementById(modifiedElementId).outerHTML,
          });
        } else if (modifiedElementId && newElement) {
          affectedElementsAfter.push({
            id: newElement.id,
            html: newElement.outerHTML,
          });
        }

        // Save to IndexedDB if a specific element was modified/created.
        // This will trigger queueForSync and then debouncedMasterSync,
        // which handles history logging and redo clearing.
        if (modifiedElementId && newElement) {
          const updatedElement = document.getElementById(modifiedElementId);
          if (updatedElement) {
            await this.saveToIndexedDB(
              modifiedElementId,
              updatedElement.outerHTML
            );
          } else {
            await this.saveToIndexedDB(
              modifiedElementId,
              newElement.outerHTML
            );
          }
        }
        // Removed: await this.updateHistoryButtonStates(); // This is now handled by clearRedoHistory
      };

      handleHistoryAndSave().catch((error) => {
        console.error("Error processing save from formatText:", error);
      });
    } finally {
      setTimeout(() => {
        this.isFormatting = false;
      }, 100);
    }
  }

  async formatBlock(type) {
    // ✅ Mark as async
    console.log("🔧 Format block called:", {
      type: type,
      hasCurrentSelection: !!this.currentSelection,
      hasLastValidRange: !!this.lastValidRange,
      isCollapsed: this.currentSelection?.isCollapsed,
      currentSelectionText: this.currentSelection?.toString(),
    });

    this.isFormatting = true;

    try {
      const editableContent = document.querySelector(this.editableSelector);
      if (!editableContent) return;

      // Simple selection restoration
      let workingSelection = this.currentSelection;
      let workingRange = null;

      if (
        this.lastValidRange &&
        editableContent.contains(this.lastValidRange.commonAncestorContainer)
      ) {
        try {
          workingSelection = window.getSelection();
          workingSelection.removeAllRanges();
          workingSelection.addRange(this.lastValidRange.cloneRange());
          workingRange = this.lastValidRange.cloneRange();
        } catch (e) {
          console.warn("Failed to restore lastValidRange:", e);
          workingSelection = null;
          workingRange = null;
        }
      }

      if (!workingSelection || !workingRange) {
        workingSelection = window.getSelection();
        if (workingSelection && workingSelection.rangeCount > 0) {
          workingRange = workingSelection.getRangeAt(0);
        }
      }

      if (!workingSelection || !workingRange) {
        console.warn("❌ No valid selection found - cannot format");
        return;
      }

      this.currentSelection = workingSelection;
      editableContent.focus();

      const isTextSelected = !this.currentSelection.isCollapsed;
      const parentElement = this.getSelectionParentElement();

      const listItem = this.findClosestListItem(parentElement);
      if (listItem) {
        await this.convertListItemToBlock(listItem, type); // ✅ await here
        // History for list conversion is handled inside convertListItemToBlock (via saveToIndexedDB)
        this.updateButtonStates();
        return; // Exit after list conversion
      }

      let modifiedElementId = null;
      let newElement = null; // Reference to the element after modification
      // Removed originalBlockStates capture from here, as it's not used directly anymore

      switch (type) {
        case "heading":
          if (isTextSelected) {
            const range = this.currentSelection.getRangeAt(0);
            const affectedBlocks = this.getBlockElementsInRange(range);

            if (affectedBlocks.length > 0) {
              const recordsToUpdate = [];
              const modifiedElementsForSelection = [];

              for (const block of affectedBlocks) {
                const isHeading = /^H[1-6]$/.test(block.tagName);
                let newBlockElement;

                if (isHeading) {
                  newBlockElement = document.createElement("p");
                } else {
                  newBlockElement = document.createElement("h2");
                }
                newBlockElement.innerHTML = block.innerHTML;
                newBlockElement.id = block.id; // Keep the same ID if block is replaced
                // Preserve data-node-id attribute if it exists
                if (block.hasAttribute('data-node-id')) {
                  newBlockElement.setAttribute('data-node-id', block.getAttribute('data-node-id'));
                }

                block.parentNode.replaceChild(newBlockElement, block);
                modifiedElementsForSelection.push({
                  id: newBlockElement.id,
                  element: newBlockElement,
                });
                recordsToUpdate.push({
                  // This is used by batchUpdateIndexedDBRecords
                  id: newBlockElement.id,
                  html: newBlockElement.outerHTML,
                });
              }

              this.selectAcrossElements(modifiedElementsForSelection);

              // Update button states after selection is set
              this.currentSelection = window.getSelection();
              this.updateButtonStates();

              // No direct history payload creation here. batchUpdateIndexedDBRecords will trigger queueForSync.
              if (recordsToUpdate.length > 0) {
                batchUpdateIndexedDBRecords(recordsToUpdate);
              }
              break; // Break from switch after handling selected text
            }
          }

          // Cursor-only logic
          const cursorFocusParent =
            this.currentSelection.focusNode.parentElement;
          const blockParent = this.findClosestBlockParent(cursorFocusParent);

          if (blockParent && /^H[1-6]$/.test(blockParent.tagName)) {
            const headingElement = blockParent;
            const beforeId = findPreviousElementId(headingElement);
            const afterId = findNextElementId(headingElement);
            const currentOffset = this.getTextOffsetInElement(
              headingElement,
              this.currentSelection.focusNode,
              this.currentSelection.focusOffset
            );
            const pElement = document.createElement("p");
            pElement.innerHTML = headingElement.innerHTML;
            const newPId = headingElement.id;
            if (newPId) {
              pElement.id = newPId;
            } else {
              setElementIds(pElement, beforeId, afterId, this.currentBookId);
            }
            // Preserve data-node-id attribute if it exists
            if (headingElement.hasAttribute('data-node-id')) {
              pElement.setAttribute('data-node-id', headingElement.getAttribute('data-node-id'));
            }
            headingElement.parentNode.replaceChild(pElement, headingElement);
            this.setCursorAtTextOffset(pElement, currentOffset);
            modifiedElementId = newPId;
            newElement = pElement;

            // Update button states after cursor is set
            this.currentSelection = window.getSelection();
            this.updateButtonStates();

            // No direct history payload here. saveToIndexedDB will trigger queueForSync.
          } else if (blockParent) {
            const beforeId = findPreviousElementId(blockParent);
            const afterId = findNextElementId(blockParent);
            const currentOffset = this.getTextOffsetInElement(
              blockParent,
              this.currentSelection.focusNode,
              this.currentSelection.focusOffset
            );
            const h2Element = document.createElement("h2");
            h2Element.innerHTML = blockParent.innerHTML;
            const newH2Id = blockParent.id;
            if (newH2Id) {
              h2Element.id = newH2Id;
            } else {
              setElementIds(h2Element, beforeId, afterId, this.currentBookId);
            }
            // Preserve data-node-id attribute if it exists
            if (blockParent.hasAttribute('data-node-id')) {
              h2Element.setAttribute('data-node-id', blockParent.getAttribute('data-node-id'));
            }
            blockParent.parentNode.replaceChild(h2Element, blockParent);
            this.setCursorAtTextOffset(h2Element, currentOffset);
            modifiedElementId = newH2Id;
            newElement = h2Element;

            // Update button states after cursor is set
            this.currentSelection = window.getSelection();
            this.updateButtonStates();

            // No direct history payload here. saveToIndexedDB will trigger queueForSync.
          }
          break;

        case "blockquote":
        case "code":
          if (isTextSelected) {
            const range = this.currentSelection.getRangeAt(0);
            const affectedBlocks = this.getBlockElementsInRange(range);

            // DEFENSE-IN-DEPTH: Only allow paragraph elements for blockquote/code conversion
            const paragraphBlocks = affectedBlocks.filter(block => block.tagName === 'P');

            if (paragraphBlocks.length > 0) {
              const beforeId = findPreviousElementId(paragraphBlocks[0]);
              const afterId = findNextElementId(
                paragraphBlocks[paragraphBlocks.length - 1]
              );

              let newBlockElement;
              if (type === "blockquote") {
                newBlockElement = document.createElement("blockquote");
                // Preserve HTML formatting by using innerHTML instead of textContent
                const combinedHTML = paragraphBlocks
                  .map((block) => block.innerHTML)
                  .join(" ");
                newBlockElement.innerHTML = combinedHTML.trim() + "<br>";
              } else {
                // For code blocks, show the actual HTML markup
                // Use a special marker to preserve original paragraph boundaries
                const combinedHTML = paragraphBlocks
                  .map((block) => block.innerHTML)
                  .join("\n<!-- PARAGRAPH_BREAK -->\n");
                newBlockElement = document.createElement("pre");
                const codeElement = document.createElement("code");
                codeElement.textContent = combinedHTML;
                newBlockElement.appendChild(codeElement);
              }

              setElementIds(newBlockElement, beforeId, afterId, this.currentBookId);

              const parent = paragraphBlocks[0].parentNode;
              parent.insertBefore(newBlockElement, paragraphBlocks[0]);

              const deletedOriginalIds = paragraphBlocks.map(
                (block) => block.id
              );
              paragraphBlocks.forEach((block) => block.remove());

              this.currentSelection.selectAllChildren(newBlockElement);
              modifiedElementId = newBlockElement.id;
              newElement = newBlockElement;

              // These are effectively a deletion of old blocks and creation of a new one.
              // Handle this as a batch operation involving both.
              // We queue the new block as an "update" and the deleted blocks as "deletions".
              if (this.currentBookId && newBlockElement.id) {
                // Queue the new block as an update
                await this.saveToIndexedDB(
                  newBlockElement.id,
                  newBlockElement.outerHTML
                );

                // Queue the old blocks as deletions (using batchDeleteIndexedDBRecords for multiple)
                if (deletedOriginalIds.length > 0) {
                  await batchDeleteIndexedDBRecords(deletedOriginalIds); // batchDelete will queueForSync
                }
              }
            } else {
              // Fallback for selections not in a block (still need to handle this)
              console.warn(
                "Selection for block format is not within a recognized block. This may fail."
              );
              const parentElement = this.getSelectionParentElement();
              const containingBlock =
                this.findClosestBlockParent(parentElement);
              if (containingBlock) {
                const beforeId = findPreviousElementId(containingBlock);
                const afterId = findNextElementId(containingBlock);

                document.execCommand("formatBlock", false, type);

                const newElem =
                  document.getElementById(beforeId)?.nextElementSibling ||
                  document.getElementById(afterId)?.previousElementSibling;
                if (newElem) {
                  setElementIds(newElem, beforeId, afterId, this.currentBookId);
                  modifiedElementId = newElem.id;
                  newElement = newElem;
                  await this.saveToIndexedDB(
                    modifiedElementId,
                    newElement.outerHTML
                  );
                }
              }
            }
          } else {
            // CURSOR-ONLY LOGIC
            const parentElement =
              this.currentSelection.focusNode.parentElement;
            const blockParentToToggle =
              this.findClosestBlockParent(parentElement);
            const isBlockquote =
              blockParentToToggle?.tagName === "BLOCKQUOTE";
            const isCode = blockParentToToggle?.tagName === "PRE";

            // DEFENSE-IN-DEPTH: Only allow paragraph wrapping (or unwrapping existing blockquote/code)
            if (blockParentToToggle &&
                blockParentToToggle.tagName !== 'P' &&
                !isBlockquote &&
                !isCode) {
              console.warn(`Cannot convert ${blockParentToToggle.tagName} to ${type} - only paragraphs allowed`);
              return;
            }

            if (
              (type === "blockquote" && isBlockquote) ||
              (type === "code" && isCode)
            ) {
              // UNWRAPPING
              const blockToUnwrap = blockParentToToggle;
              const beforeOriginalId = findPreviousElementId(blockToUnwrap);
              const afterOriginalId = findNextElementId(blockToUnwrap);
              
              const fragment = document.createDocumentFragment();
              let lastId = beforeOriginalId;
              let firstNewP = null;
              const createdP_ids_with_html = []; // Store IDs with HTML for saveToIndexedDB

              if (type === "blockquote" && isBlockquote) {
                // For blockquotes, preserve HTML formatting when unwrapping
                const p = document.createElement("p");
                // Remove trailing <br> if present, then set innerHTML to preserve formatting
                let content = blockToUnwrap.innerHTML;
                if (content.endsWith("<br>")) {
                  content = content.slice(0, -4);
                }
                p.innerHTML = content || "\u00A0";
                setElementIds(p, lastId, afterOriginalId, this.currentBookId);
                firstNewP = p;
                fragment.appendChild(p);
                createdP_ids_with_html.push({
                  id: p.id,
                  html: p.outerHTML,
                });
              } else {
                // For code blocks, parse HTML markup back into functioning HTML
                const htmlContent = blockToUnwrap.textContent;
                
                // Check if content has paragraph break markers (multiple paragraphs)
                if (htmlContent.includes("<!-- PARAGRAPH_BREAK -->")) {
                  const paragraphContents = htmlContent.split("\n<!-- PARAGRAPH_BREAK -->\n");
                  
                  paragraphContents.forEach((paragraphHTML, index) => {
                    if (paragraphHTML.trim()) {
                      const p = document.createElement("p");
                      try {
                        p.textContent = paragraphHTML.trim();
                      } catch (e) {
                        console.warn("Failed to parse HTML from code block:", paragraphHTML);
                        p.textContent = paragraphHTML.trim();
                      }
                      setElementIds(p, lastId, afterOriginalId, this.currentBookId);
                      lastId = p.id;
                      if (index === 0) firstNewP = p;
                      fragment.appendChild(p);
                      createdP_ids_with_html.push({
                        id: p.id,
                        html: p.outerHTML,
                      });
                    }
                  });
                } else {
                  // Single paragraph case - split by actual line breaks if any
                  const lines = htmlContent.split("\n");
                  
                  lines.forEach((line, index) => {
                    if (line.trim() || lines.length === 1) {
                      const p = document.createElement("p");
                      try {
                        p.textContent = line || "\u00A0";
                      } catch (e) {
                        console.warn("Failed to parse HTML from code block:", line);
                        p.textContent = line || "\u00A0";
                      }
                      setElementIds(p, lastId, afterOriginalId, this.currentBookId);
                      lastId = p.id;
                      if (index === 0) firstNewP = p;
                      fragment.appendChild(p);
                      createdP_ids_with_html.push({
                        id: p.id,
                        html: p.outerHTML,
                      });
                    }
                  });
                }
              }

              if (fragment.childNodes.length > 0) {
                blockToUnwrap.parentNode.replaceChild(fragment, blockToUnwrap);
                newElement = firstNewP;
                modifiedElementId = newElement.id;
                this.setCursorAtTextOffset(newElement, 0);

                // Queue new paragraphs as updates (batchUpdate)
                await batchUpdateIndexedDBRecords(createdP_ids_with_html);
                // Queue old wrapper block as deletion
                if (blockToUnwrap.id) {
                  await this.deleteFromIndexedDB(blockToUnwrap.id); // Assuming this is your single delete func
                }
              } else {
                // Handle empty case (unwrap an empty block)
                const p = document.createElement("p");
                p.innerHTML = "&nbsp;";
                setElementIds(p, beforeOriginalId, afterOriginalId, this.currentBookId);
                blockToUnwrap.parentNode.replaceChild(p, blockToUnwrap);
                newElement = p;
                modifiedElementId = p.id;
                this.setCursorAtTextOffset(newElement, 0);

                await this.saveToIndexedDB(p.id, p.outerHTML); // Queue new empty paragraph
                if (blockToUnwrap.id) {
                  await this.deleteFromIndexedDB(blockToUnwrap.id); // Queue old wrapper block
                }
              }
            } else if (blockParentToToggle) {
              // WRAPPING
              const beforeId = findPreviousElementId(blockParentToToggle);
              const afterId = findNextElementId(blockParentToToggle);
              const currentOffset = this.getTextOffsetInElement(
                blockParentToToggle,
                this.currentSelection.focusNode,
                this.currentSelection.focusOffset
              );

              let newBlockElement;
              if (type === "blockquote") {
                newBlockElement = document.createElement("blockquote");
                let content = blockParentToToggle.innerHTML;
                if (content && !content.endsWith("<br>")) content += "<br>";
                newBlockElement.innerHTML = content;
              } else {
                newBlockElement = document.createElement("pre");
                const code = document.createElement("code");
                // Show the HTML markup in the code block
                code.textContent = blockParentToToggle.innerHTML;
                newBlockElement.appendChild(code);
              }

              setElementIds(newBlockElement, beforeId, afterId, this.currentBookId);
              blockParentToToggle.parentNode.replaceChild(
                newBlockElement,
                blockParentToToggle
              );
              newElement = newBlockElement;
              modifiedElementId = newElement.id;
              this.setCursorAtTextOffset(newElement, currentOffset);

              // This is a delete of old blockParentToToggle and creation of newBlockElement
              // Queue newBlockElement as an update, oldBlockParentToToggle as a deletion.
              if (newBlockElement.id && blockParentToToggle.id) {
                await this.saveToIndexedDB(
                  newBlockElement.id,
                  newBlockElement.outerHTML
                ); // Queue new block
                await this.deleteFromIndexedDB(blockParentToToggle.id); // Queue old block for deletion
              }
            }
          }
          break;
      }

      this.updateButtonStates();

      // REMOVED ALL HISTORY/SAVE BLOCK from formatBlock
      const handleHistoryAndSave = async () => {
        // Define an inner async function
        const affectedElementsAfter = [];
        if (modifiedElementId && document.getElementById(modifiedElementId)) {
          affectedElementsAfter.push({
            id: modifiedElementId,
            html: document.getElementById(modifiedElementId).outerHTML,
          });
        } else if (modifiedElementId && newElement) {
          affectedElementsAfter.push({
            id: newElement.id,
            html: newElement.outerHTML,
          });
        }

        // Save to IndexedDB if a specific element was modified/created.
        // This will trigger queueForSync and then debouncedMasterSync,
        // which handles history logging and redo clearing.
        if (modifiedElementId && newElement) {
          const updatedElement = document.getElementById(modifiedElementId);
          if (updatedElement) {
            await this.saveToIndexedDB(
              modifiedElementId,
              updatedElement.outerHTML
            );
          } else {
            await this.saveToIndexedDB(
              modifiedElementId,
              newElement.outerHTML
            );
          }
        }
        // Removed: await this.updateHistoryButtonStates(); // This is now handled by clearRedoHistory
      };

      // Call the inner async function immediately (no setTimeout for this chain)
      handleHistoryAndSave().catch((error) => {
        console.error("Error processing save from formatBlock:", error);
      });
    } finally {
      // This setTimeout is now ONLY for resetting isFormatting,
      // it won't interfere with the history state updates.
      setTimeout(() => {
        this.isFormatting = false;
      }, 100);
    }
  }

  getElementsInSelectionRange(range) {
    const elements = [];
    const iterator = document.createNodeIterator(
      range.commonAncestorContainer,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (node.id && range.intersectsNode(node)) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      }
    );

    let node;
    while ((node = iterator.nextNode())) {
      elements.push(node);
    }
    return elements;
  }

  /**
   * Check if an element is a block-level element
   */
  isBlockElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    
    const blockElements = [
      "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", 
      "BLOCKQUOTE", "PRE", "UL", "OL", "LI", "TABLE", 
      "TR", "TD", "TH", "SECTION", "ARTICLE", "ASIDE", 
      "HEADER", "FOOTER", "MAIN", "NAV", "FIGURE", "FIGCAPTION"
    ];
    
    return blockElements.includes(element.tagName);
  }

  getBlockElementsInRange(range) {
    const blockElements = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (this.isBlockElement(node) && range.intersectsNode(node)) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      blockElements.push(node);
    }

    return blockElements;
  }

  selectAcrossElements(elements) {
    if (elements.length === 0) return;

    const range = document.createRange();
    range.setStartBefore(elements[0].element);
    range.setEndAfter(elements[elements.length - 1].element);

    this.currentSelection.removeAllRanges();
    this.currentSelection.addRange(range);
  }

  /**
   * Helper method to update IndexedDB record (for a single item)
   * This now calls updateIndexedDBRecord (in cache-indexedDB.js) which queues for sync.
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
   * This now calls deleteIndexedDBRecord (in cache-indexedDB.js) which queues for sync.
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
   */
  async unwrapSelectedTextFromHeading() {
    // ✅ Mark as async
    if (!this.currentSelection || this.currentSelection.isCollapsed) {
      console.warn("unwrapSelectedTextFromHeading called with no selection.");
      return null;
    }

    const range = this.currentSelection.getRangeAt(0);
    let headingElement = null;
    let currentElement = this.getSelectionParentElement();

    while (currentElement) {
      if (
        currentElement.nodeType === Node.ELEMENT_NODE &&
        /^H[1-6]$/.test(currentElement.tagName)
      ) {
        headingElement = currentElement;
        break;
      }
      if (
        currentElement.hasAttribute("contenteditable") &&
        currentElement.getAttribute("contenteditable") === "true"
      )
        break;
      if (currentElement === document.body) break;
      currentElement = currentElement.parentNode;
    }

    if (!headingElement) {
      console.warn(
        "unwrapSelectedTextFromHeading: Could not find parent heading element."
      );
      return null;
    }

    // Removed: Capture original state for history (no longer needed here)

    const beforeOriginalId = findPreviousElementId(headingElement);
    const afterOriginalId = findNextElementId(headingElement);

    const pElement = document.createElement("p");
    pElement.innerHTML = headingElement.innerHTML;

    setElementIds(pElement, beforeOriginalId, afterOriginalId, this.currentBookId);

    try {
      headingElement.parentNode.replaceChild(pElement, headingElement);
    } catch (domError) {
      console.error(
        "unwrapSelectedTextFromHeading: DOM replacement failed.",
        domError
      );
      return null;
    }

    if (this.currentSelection) {
      const newRange = document.createRange();
      newRange.selectNodeContents(pElement);
      this.currentSelection.removeAllRanges();
      this.currentSelection.addRange(newRange);
    }

    console.log(`unwrapSelectedTextFromHeading: New paragraph ID "${newPId}"`);

    // Call saveToIndexedDB for the new paragraph and deleteFromIndexedDB for the old heading
    if (this.currentBookId) {
      await this.saveToIndexedDB(pElement.id, pElement.outerHTML);
      await this.deleteFromIndexedDB(headingElement.id);
    }

    return {
      id: newPId,
      element: pElement,
    };
  }

  /**
   * Find parent element with the specified tag
   */
  findParentWithTag(element, tagName) {
    if (!element) return null;

    if (element.tagName === tagName) {
      return element;
    }

    return element.parentNode && element.parentNode.nodeType === 1
      ? this.findParentWithTag(element.parentNode, tagName)
      : null;
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
  }

  /**
   * Hide the toolbar
   */
  hide() {
    if (this.isDisabled) return;
    if (!this.isVisible) return;

    this.toolbar.classList.remove("visible");
    this.isVisible = false;
  }

  /**
   * Clean up event listeners
   */
  destroy() {
    document.removeEventListener("selectionchange", this.handleSelectionChange);
    window.removeEventListener("resize", this.handleResize);

    console.log("🧹 EditToolbar: Destroyed and cleaned up");
  }

  /**
   * Find the closest block-level parent element
   */
  findClosestBlockParent(element) {
    if (!element) return null;

    const blockElements = [
      "P",
      "DIV",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "BLOCKQUOTE",
      "PRE",
      "UL",
      "OL",
      "LI",
      "TABLE",
      "TR",
      "TD",
      "TH",
    ];

    if (blockElements.includes(element.tagName)) {
      return element;
    }

    return element.parentNode && element.parentNode.nodeType === 1
      ? this.findClosestBlockParent(element.parentNode)
      : null;
  }

  /**
   * Get the text offset of the cursor within an element
   */
  getTextOffsetInElement(element, container, offset) {
    if (!element || !container) return 0;

    const range = document.createRange();
    range.setStart(element, 0);
    range.setEnd(container, offset);

    const textBeforeCursor = range.toString();
    return textBeforeCursor.length;
  }

  /**
   * Set cursor to a specific text offset within an element
   */
  setCursorAtTextOffset(element, textOffset) {
    if (!element) return;

    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let currentOffset = 0;
    let targetNode = null;
    let targetOffset = 0;

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const textLength = textNode.textContent.length;

      if (currentOffset + textLength >= textOffset) {
        targetNode = textNode;
        targetOffset = textOffset - currentOffset;
        break;
      }

      currentOffset += textLength;
    }

    if (!targetNode) {
      const lastTextNode = this.getLastTextNode(element);
      if (lastTextNode) {
        targetNode = lastTextNode;
        targetOffset = lastTextNode.textContent.length;
      } else {
        targetNode = element;
        targetOffset = 0;
      }
    }

    if (targetNode) {
      const range = document.createRange();
      range.setStart(
        targetNode,
        Math.min(targetOffset, targetNode.textContent?.length || 0)
      );
      range.collapse(true);
      this.currentSelection.removeAllRanges();
      this.currentSelection.addRange(range);
    }
  }

  /**
   * Get the last text node in an element
   */
  getLastTextNode(element) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let lastTextNode = null;
    while (walker.nextNode()) {
      lastTextNode = walker.currentNode;
    }

    return lastTextNode;
  }

  /**
   * Find the closest list item parent
   */
  findClosestListItem(element) {
    if (!element) return null;

    while (element && element !== document.body) {
      if (element.tagName === "LI") {
        return element;
      }
      element = element.parentElement;
    }

    return null;
  }

  /**
   * Convert a list item to a block element (blockquote or code)
   */
  async convertListItemToBlock(listItem, blockType) {
    // ✅ Mark as async
    // Removed original state capture (history is handled by queueForSync flow)

    const immediateParentList = listItem.parentElement;

    if (
      !immediateParentList ||
      !["UL", "OL"].includes(immediateParentList.tagName)
    ) {
      console.warn("Cannot convert list item - not in a list");
      return;
    }

    let listWithId = immediateParentList;
    while (listWithId && listWithId !== document.body) {
      if (
        (listWithId.tagName === "UL" || listWithId.tagName === "OL") &&
        listWithId.id
      ) {
        break;
      }
      listWithId = listWithId.parentElement;
    }

    if (!listWithId) {
      console.warn("Cannot convert list item - no parent list with ID found");
      return;
    }

    console.log(`Converting list item from list with ID: ${listWithId.id}`);

    const newBlock =
      blockType === "blockquote"
        ? document.createElement("blockquote")
        : document.createElement("pre");

    if (blockType === "code") {
      const codeElement = document.createElement("code");
      newBlock.appendChild(codeElement);
      codeElement.textContent = listItem.textContent.trim();
    } else {
      let content = listItem.innerHTML.trim();
      if (content && !content.endsWith("<br>")) {
        content += "<br>";
      }
      newBlock.innerHTML = content;
    }

    const beforeId = findPreviousElementId(listWithId);
    const afterId = findNextElementId(listWithId);
    setElementIds(newBlock, beforeId, afterId, this.currentBookId);

    // Removed originalRootListHtmlBeforeSplit capture (history is handled by queueForSync flow)

    await this.splitListAndInsertBlock(
      immediateParentList,
      listItem,
      newBlock,
      listWithId
    ); // ✅ await here

    // Save the new block to IndexedDB
    await this.saveToIndexedDB(newBlock.id, newBlock.outerHTML); // ✅ await here
    this.setCursorAtTextOffset(newBlock, 0);

    // REMOVED ALL HISTORY PAYLOAD CONSTRUCTION AND addHistoryBatch CALLS
    // The history for this complex operation (delete list item, insert block, split list)
    // will now be formed by debouncedMasterSync from the individual queueForSync calls
    // made by saveToIndexedDB and deleteFromIndexedDB within splitListAndInsertBlock
    // and cleanupAfterSplit.

    return newBlock;
  }

  /**
   * Split a list around a specific item and insert a block element
   * Now ensures the original list's HTML state is captured if it's the `rootListWithId`
   */
  async splitListAndInsertBlock(
    parentList,
    targetItem,
    newBlock,
    rootListWithId
  ) {
    // ✅ Mark as async
    const allItems = Array.from(parentList.children);
    const targetIndex = allItems.indexOf(targetItem);

    if (targetIndex === -1) return;

    const itemsBefore = allItems.slice(0, targetIndex);
    const itemsAfter = allItems.slice(targetIndex + 1);

    targetItem.remove(); // Remove the target item first

    // Removed originalRootListHtml capture (history is handled by queueForSync flow)

    if (parentList === rootListWithId) {
      // Simple case: we're splitting the root list directly
      rootListWithId.parentNode.insertBefore(
        newBlock,
        rootListWithId.nextSibling
      );

      if (itemsAfter.length > 0) {
        const newList = document.createElement(parentList.tagName);
        const afterBlockId = findNextElementId(newBlock);
        setElementIds(newList, newBlock.id, afterBlockId, this.currentBookId);

        itemsAfter.forEach((item) => newList.appendChild(item));

        newBlock.parentNode.insertBefore(newList, newBlock.nextSibling);
        await this.saveToIndexedDB(newList.id, newList.outerHTML); // This will call queueForSync
      }
      await this.saveToIndexedDB(rootListWithId.id, rootListWithId.outerHTML); // This will call queueForSync
    } else {
      // Complex case: nested list
      const pathToRoot = [];
      let currentElement = parentList;
      while (currentElement && currentElement !== rootListWithId) {
        pathToRoot.unshift(currentElement);
        currentElement = currentElement.parentElement;
      }

      let topLevelItem = parentList;
      while (topLevelItem.parentElement !== rootListWithId) {
        topLevelItem = topLevelItem.parentElement;
      }

      const rootItems = Array.from(rootListWithId.children);
      const topLevelIndex = rootItems.indexOf(topLevelItem);

      if (topLevelIndex !== -1) {
        const insertAfter = rootItems[topLevelIndex];
        rootListWithId.parentNode.insertBefore(
          newBlock,
          insertAfter.nextSibling
        );

        if (itemsAfter.length > 0) {
          const newTopLevelItem = document.createElement("li");
          const newNestedList = document.createElement(parentList.tagName);

          itemsAfter.forEach((item) => newNestedList.appendChild(item));
          newTopLevelItem.appendChild(newNestedList);

          const newList = document.createElement(rootListWithId.tagName);
          const afterBlockId = findNextElementId(newBlock);
          setElementIds(newList, newBlock.id, afterBlockId, this.currentBookId);

          newList.appendChild(newTopLevelItem);
          newBlock.parentNode.insertBefore(newList, newBlock.nextSibling);
          await this.saveToIndexedDB(newList.id, newList.outerHTML); // This will call queueForSync
        }
      }
      await this.cleanupAfterSplit(rootListWithId); // Cleanup also saves to DB and triggers queueForSync
    }
  }

  async cleanupAfterSplit(rootList) {
    // ✅ Mark as async
    // Removed originalRootListHtml capture (history is handled by queueForSync flow)

    const emptyLists = rootList.querySelectorAll("ul:empty, ol:empty");
    emptyLists.forEach((list) => list.remove());

    const listItems = rootList.querySelectorAll("li");
    listItems.forEach((li) => {
      const hasContent = li.textContent.trim() !== "";
      const hasNonEmptyChildren = Array.from(li.children).some(
        (child) =>
          child.textContent.trim() !== "" || child.children.length > 0
      );

      if (!hasContent && !hasNonEmptyChildren) {
        li.remove();
      }
    });

    // Save the updated root list, which will trigger queueForSync
    await this.saveToIndexedDB(rootList.id, rootList.outerHTML); // ✅ await here
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