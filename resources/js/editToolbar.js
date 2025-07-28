// In edit-toolbar.js

import { updateIndexedDBRecord, batchUpdateIndexedDBRecords } from "./cache-indexedDB.js";
import { generateIdBetween, findPreviousElementId, findNextElementId } from "./IDfunctions.js";
import { undoLastBatch, redoLastBatch, canUndo, canRedo, addHistoryBatch, setCurrentBookId } from './historyManager.js';

// Private module-level variable to hold the toolbar instance
let editToolbarInstance = null;

/**
 * EditToolbar class for handling formatting controls in editable content
 */
class EditToolbar {
  constructor(options = {}) {
    this.toolbarId = options.toolbarId || "edit-toolbar";
    this.editableSelector = options.editableSelector || ".main-content[contenteditable='true']";
    this.currentBookId = options.currentBookId || null; // ✅ NEW: Accept currentBookId

    this.toolbar = document.getElementById(this.toolbarId);
    if (!this.toolbar) {
      throw new Error(`Element with id "${this.toolbarId}" not found.`);
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
    this.updateHistoryButtonStates = this.updateHistoryButtonStates.bind(this); // ✅ NEW: Bind this method

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
    this.currentBookId = bookId;
    setCurrentBookId(bookId); // Update the history manager
    this.updateHistoryButtonStates(); // Refresh button states
  }

  /**
   * Attach click handlers to formatting buttons
   */
  attachButtonHandlers() {
    const buttons = [{
        element: this.boldButton,
        name: "bold",
        action: () => this.formatText("bold")
      },
      {
        element: this.italicButton,
        name: "italic",
        action: () => this.formatText("italic")
      },
      {
        element: this.headingButton,
        name: "heading",
        action: () => this.formatBlock("heading")
      },
      {
        element: this.blockquoteButton,
        name: "blockquote",
        action: () => this.formatBlock("blockquote")
      },
      {
        element: this.codeButton,
        name: "code",
        action: () => this.formatBlock("code")
      },
      {
        element: this.undoButton,
        name: "undo",
        action: () => this.handleUndo()
      },
      {
        element: this.redoButton,
        name: "redo",
        action: () => this.handleRedo()
      }
    ];

    buttons.forEach(({
      element,
      name,
      action
    }) => {
      if (element) {
        console.log(`✅ ${name} button found:`, element);

        // Prevent default behavior that clears selection
        element.addEventListener("touchstart", (e) => {
          e.preventDefault();
          e.stopPropagation();

          // Store the current selection immediately
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            this.lastValidRange = selection.getRangeAt(0).cloneRange();
            console.log(`📱 ${name} touchstart - stored selection:`, this.lastValidRange.toString());
          }
        }, {
          passive: false
        });

        element.addEventListener("touchend", (e) => {
          e.preventDefault();
          e.stopPropagation();

          console.log(`📱 ${name} touchend - executing action`);

          // Small delay to ensure selection is stored
          setTimeout(() => {
            action();
          }, 10);
        }, {
          passive: false
        });

        // Keep desktop click handler
        element.addEventListener("click", (e) => {
          // Only handle click if not a touch device
          if (!this.isMobile) {
            console.log(`🖱️ ${name} button clicked!`, e);
            e.preventDefault();
            e.stopPropagation();
            action();
          }
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
    this.updateHistoryButtonStates(); // Update visual state immediately
    try {
      await undoLastBatch();
    } catch (error) {
      console.error("❌ Error during undo operation:", error);
    } finally {
      this.isProcessingHistory = false;
      this.updateHistoryButtonStates(); // Update visual state after completion
      console.log("✅ Undo/Redo lock released.");
    }
  }

  async handleRedo() {
    if (this.isProcessingHistory) {
      console.log("⏳ Undo/Redo already in progress. Please wait.");
      return;
    }
    this.isProcessingHistory = true;
    this.updateHistoryButtonStates(); // Update visual state immediately
    try {
      await redoLastBatch();
    } catch (error) {
      console.error("❌ Error during redo operation:", error);
    } finally {
      this.isProcessingHistory = false;
      this.updateHistoryButtonStates(); // Update visual state after completion
      console.log("✅ Undo/Redo lock released.");
    }
  }

  /**
   * Update the active/disabled states of undo/redo buttons.
   */
  async updateHistoryButtonStates() {
    console.log("Updating history button states...");

    // ✅ RE-ACQUIRE REFERENCES TO THE BUTTONS HERE
    // This is vital because the DOM might have been rebuilt by lazyLoaderFactory.refresh()
    this.undoButton = document.getElementById("undoButton");
    this.redoButton = document.getElementById("redoButton");

    if (this.undoButton) {
      const canCurrentlyUndo = await canUndo();
      console.log(`Undo button: isProcessingHistory=${this.isProcessingHistory}, canCurrentlyUndo=${canCurrentlyUndo}`);
      this.undoButton.classList.toggle("processing", this.isProcessingHistory);
      this.undoButton.classList.toggle("disabled", this.isProcessingHistory || !canCurrentlyUndo);
      this.undoButton.disabled = this.isProcessingHistory || !canCurrentlyUndo; // Disable button element
    } else {
      console.warn("Undo button not found in DOM.");
    }

    if (this.redoButton) {
      const canCurrentlyRedo = await canRedo();
      console.log(`Redo button: isProcessingHistory=${this.isProcessingHistory}, canCurrentlyRedo=${canCurrentlyRedo}`);
      this.redoButton.classList.toggle("processing", this.isProcessingHistory);
      this.redoButton.classList.toggle("disabled", this.isProcessingHistory || !canCurrentlyRedo);
      this.redoButton.disabled = this.isProcessingHistory || !canCurrentlyRedo; // Disable button element
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
      toolbarVisible: this.isVisible
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
          isInEditable: editableContent.contains(container)
        });

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
              container: this.mobileBackupContainer
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
      document.removeEventListener("selectionchange", this.handleSelectionChange);
    }
  }

  /**
   * Update the active states of formatting buttons based on current selection
   */
  updateButtonStates() {
    if (!this.currentSelection) return;

    const parentElement = this.getSelectionParentElement();

    // Update bold button state
    if (this.boldButton) {
      this.boldButton.classList.toggle("active",
        document.queryCommandState("bold") ||
        this.hasParentWithTag(parentElement, "STRONG") ||
        this.hasParentWithTag(parentElement, "B"));
    }

    // Update italic button state
    if (this.italicButton) {
      this.italicButton.classList.toggle("active",
        document.queryCommandState("italic") ||
        this.hasParentWithTag(parentElement, "EM") ||
        this.hasParentWithTag(parentElement, "I"));
    }

    // Update heading button state
    if (this.headingButton) {
      this.headingButton.classList.toggle("active",
        this.hasParentWithTag(parentElement, "H1") ||
        this.hasParentWithTag(parentElement, "H2") ||
        this.hasParentWithTag(parentElement, "H3") ||
        this.hasParentWithTag(parentElement, "H4") ||
        this.hasParentWithTag(parentElement, "H5") ||
        this.hasParentWithTag(parentElement, "H6"));
    }

    // Update blockquote button state
    if (this.blockquoteButton) {
      this.blockquoteButton.classList.toggle("active",
        this.hasParentWithTag(parentElement, "BLOCKQUOTE"));
    }

    // Update code button state
    if (this.codeButton) {
      this.codeButton.classList.toggle("active",
        this.hasParentWithTag(parentElement, "CODE") ||
        this.hasParentWithTag(parentElement, "PRE"));
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

    return element.parentNode && element.parentNode.nodeType === 1 ?
      this.hasParentWithTag(element.parentNode, tagName) : false;
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
      currentSelectionText: this.currentSelection?.toString()
    });

    this.isFormatting = true;

    try {
      const editableContent = document.querySelector(this.editableSelector);
      if (!editableContent) return;

      let workingSelection = this.currentSelection;
      let workingRange = null;

      if (this.lastValidRange && editableContent.contains(this.lastValidRange.commonAncestorContainer)) {
        try {
          workingSelection = window.getSelection();
          workingSelection.removeAllRanges();
          workingSelection.addRange(this.lastValidRange.cloneRange());
          workingRange = this.lastValidRange.cloneRange();
          console.log("🔄 Restored valid selection to:", workingRange.commonAncestorContainer);
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

      const affectedElementsBefore = this.getElementsInSelectionRange(workingRange);
      const originalStates = affectedElementsBefore.map(el => ({
        id: el.id,
        html: el.outerHTML
      }));

      const isTextSelected = !this.currentSelection.isCollapsed;
      const parentElement = this.getSelectionParentElement();

      let modifiedElementId = null;
      let newElement = null;

      switch (type) {
        case "bold":
          if (isTextSelected) {
            document.execCommand("bold", false, null);
            const parentAfterBold = this.getSelectionParentElement();
            const blockParent = this.findClosestBlockParent(parentAfterBold);
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

            if (this.hasParentWithTag(parentElement, "STRONG") ||
              this.hasParentWithTag(parentElement, "B")) {
              const boldElement = this.findParentWithTag(parentElement, "STRONG") ||
                this.findParentWithTag(parentElement, "B");
              if (boldElement) {
                const newTextNode = document.createTextNode(boldElement.textContent);
                const parentNode = boldElement.parentNode;
                parentNode.replaceChild(newTextNode, boldElement);
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
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                node = walker.nextNode();
              }

              if (node && node.nodeType === Node.TEXT_NODE) {
                const range = document.createRange();
                range.selectNodeContents(node);
                this.currentSelection.removeAllRanges();
                this.currentSelection.addRange(range);
                document.execCommand("bold", false, null);
                const newBoldNode = this.findParentWithTag(node.parentNode, "STRONG") ||
                  this.findParentWithTag(node.parentNode, "B");
                if (newBoldNode) {
                  this.setCursorAtTextOffset(newBoldNode, currentOffset);
                  const blockParent = this.findClosestBlockParent(newBoldNode);
                  if (blockParent && blockParent.id) {
                    modifiedElementId = blockParent.id;
                    newElement = blockParent;
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

            if (this.hasParentWithTag(parentElement, "EM") ||
              this.hasParentWithTag(parentElement, "I")) {
              const italicElement = this.findParentWithTag(parentElement, "EM") ||
                this.findParentWithTag(parentElement, "I");
              if (italicElement) {
                const newTextNode = document.createTextNode(italicElement.textContent);
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
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                node = walker.nextNode();
              }

              if (node && node.nodeType === Node.TEXT_NODE) {
                const range = document.createRange();
                range.selectNodeContents(node);
                this.currentSelection.removeAllRanges();
                this.currentSelection.addRange(range);
                document.execCommand("italic", false, null);
                const newItalicNode = this.findParentWithTag(node.parentNode, "EM") ||
                  this.findParentWithTag(node.parentNode, "I");
                if (newItalicNode) {
                  this.setCursorAtTextOffset(newItalicNode, currentOffset);
                  const blockParent = this.findClosestBlockParent(newItalicNode);
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

      // ✅ THIS IS THE ONLY HISTORY/SAVE BLOCK THAT SHOULD REMAIN
      const handleHistoryAndSave = async () => {
        const affectedElementsAfter = [];
        if (modifiedElementId && document.getElementById(modifiedElementId)) {
          affectedElementsAfter.push({
            id: modifiedElementId,
            html: document.getElementById(modifiedElementId).outerHTML
          });
        } else if (modifiedElementId && newElement) {
          affectedElementsAfter.push({
            id: newElement.id,
            html: newElement.outerHTML
          });
        }

        if (this.currentBookId && (originalStates.length > 0 || affectedElementsAfter.length > 0)) {
            const previousElementState = originalStates.find(item => item.id === (modifiedElementId || newElement?.id));
            const newElementState = affectedElementsAfter.find(item => item.id === (modifiedElementId || newElement?.id));

            if (previousElementState && newElementState) {
                 await addHistoryBatch(this.currentBookId, {
                     updates: {
                         nodeChunks: [{
                             book: this.currentBookId,
                             startLine: previousElementState.id,
                             html: previousElementState.html
                         }]
                     },
                     deletions: {
                         nodeChunks: []
                     }
                 });
            } else if (!previousElementState && newElementState) {
                await addHistoryBatch(this.currentBookId, {
                    updates: { nodeChunks: [] },
                    deletions: {
                        nodeChunks: [{
                            book: this.currentBookId,
                            startLine: newElementState.id,
                            html: newElementState.html
                        }]
                    }
                });
            } else if (previousElementState && !newElementState) {
                await addHistoryBatch(this.currentBookId, {
                    updates: { nodeChunks: [] },
                    deletions: {
                        nodeChunks: [{
                            book: this.currentBookId,
                            startLine: previousElementState.id,
                            html: previousElementState.html
                        }]
                    }
                });
            }
        }
        if (modifiedElementId && newElement) { // Only call saveToIndexedDB if a specific element was modified/created
          const updatedElement = document.getElementById(modifiedElementId);
          if (updatedElement) {
            await this.saveToIndexedDB(modifiedElementId, updatedElement.outerHTML);
          } else {
            await this.saveToIndexedDB(modifiedElementId, newElement.outerHTML);
          }
        }
        await this.updateHistoryButtonStates();
      };

      handleHistoryAndSave().catch(error => {
          console.error("Error processing history and save:", error);
      });

    } finally {
      setTimeout(() => {
        this.isFormatting = false;
      }, 100);
    }
  }

  async formatBlock(type) { // ✅ Mark as async
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
        // History for list conversion is handled inside convertListItemToBlock
        this.updateButtonStates();
        return; // Exit after list conversion
      }

      let modifiedElementId = null;
      let newElement = null; // Reference to the element after modification
      let originalBlockStates = []; // To store original state of blocks for history

      // Capture original state before modification
      if (isTextSelected) {
        const affectedBlocksBefore = this.getBlockElementsInRange(workingRange);
        originalBlockStates = affectedBlocksBefore.map(block => ({ id: block.id, html: block.outerHTML }));
      } else {
        const blockParentBefore = this.findClosestBlockParent(parentElement);
        if (blockParentBefore && blockParentBefore.id) {
          originalBlockStates.push({ id: blockParentBefore.id, html: blockParentBefore.outerHTML });
        }
      }


      switch (type) {
        case "heading":
          if (isTextSelected) {
            const range = this.currentSelection.getRangeAt(0);
            const affectedBlocks = this.getBlockElementsInRange(range);

            if (affectedBlocks.length > 0) {
              const recordsToUpdate = [];
              const modifiedElementsForSelection = [];
              const newElementIds = []; // To track new IDs for history payload

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

                block.parentNode.replaceChild(newBlockElement, block);
                modifiedElementsForSelection.push({
                  id: newBlockElement.id,
                  element: newBlockElement,
                });
                recordsToUpdate.push({
                  id: newBlockElement.id,
                  html: newBlockElement.outerHTML,
                });
                newElementIds.push(newBlockElement.id); // Add modified/new element ID
              }

              this.selectAcrossElements(modifiedElementsForSelection);

              // ✅ NEW: Add batch update to history
              if (this.currentBookId && recordsToUpdate.length > 0) {
                  const historyPayload = {
                      updates: {
                          nodeChunks: originalBlockStates.map(item => ({
                              book: this.currentBookId,
                              startLine: item.id,
                              html: item.html
                          }))
                      },
                      deletions: {
                          nodeChunks: []
                      }
                  };
                  await addHistoryBatch(this.currentBookId, historyPayload); // ✅ await here
              }
              // Original IndexedDB save for batch updates.
              if (recordsToUpdate.length > 0) {
                  // If batchUpdateIndexedDBRecords doesn't implicitly call addHistoryBatch,
                  // you'd need to modify it or call addHistoryBatch after it.
                  // For now, let's assume saveToIndexedDB handles history, and
                  // batchUpdateIndexedDBRecords will too if refactored.
                  batchUpdateIndexedDBRecords(recordsToUpdate);
              }
              break; // Break from switch after handling selected text
            }
          }

          // Cursor-only logic
          const cursorFocusParent = this.currentSelection.focusNode.parentElement;
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
            const newPId = headingElement.id || generateIdBetween(beforeId, afterId); // Try to preserve ID
            pElement.id = newPId;
            headingElement.parentNode.replaceChild(pElement, headingElement);
            this.setCursorAtTextOffset(pElement, currentOffset);
            modifiedElementId = newPId;
            newElement = pElement;

            // ✅ History for cursor-only heading toggle
            if (this.currentBookId && originalBlockStates.length > 0) {
                await addHistoryBatch(this.currentBookId, { // ✅ await here
                    updates: {
                        nodeChunks: [{
                            book: this.currentBookId,
                            startLine: originalBlockStates[0].id,
                            html: originalBlockStates[0].html
                        }]
                    },
                    deletions: { nodeChunks: [] } // No deletions, just an update/replace
                });
            }

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
            const newH2Id = blockParent.id || generateIdBetween(beforeId, afterId); // Try to preserve ID
            h2Element.id = newH2Id;
            blockParent.parentNode.replaceChild(h2Element, blockParent);
            this.setCursorAtTextOffset(h2Element, currentOffset);
            modifiedElementId = newH2Id;
            newElement = h2Element;

            // ✅ History for cursor-only heading toggle
            if (this.currentBookId && originalBlockStates.length > 0) {
                await addHistoryBatch(this.currentBookId, { // ✅ await here
                    updates: {
                        nodeChunks: [{
                            book: this.currentBookId,
                            startLine: originalBlockStates[0].id,
                            html: originalBlockStates[0].html
                        }]
                    },
                    deletions: { nodeChunks: [] }
                });
            }
          }
          break;

        case "blockquote":
        case "code":
          if (isTextSelected) {
            const range = this.currentSelection.getRangeAt(0);
            const affectedBlocks = this.getBlockElementsInRange(range);

            if (affectedBlocks.length > 0) {
              const beforeId = findPreviousElementId(affectedBlocks[0]);
              const afterId = findNextElementId(
                affectedBlocks[affectedBlocks.length - 1]
              );

              const combinedText = affectedBlocks
                .map((block) => block.textContent)
                .join(type === "code" ? "\n" : " ");

              let newBlockElement;
              if (type === "blockquote") {
                newBlockElement = document.createElement("blockquote");
                newBlockElement.innerHTML = combinedText.trim() + "<br>";
              } else {
                newBlockElement = document.createElement("pre");
                const codeElement = document.createElement("code");
                codeElement.textContent = combinedText;
                newBlockElement.appendChild(codeElement);
              }

              newBlockElement.id = generateIdBetween(beforeId, afterId);

              const parent = affectedBlocks[0].parentNode;
              parent.insertBefore(
                newBlockElement,
                affectedBlocks[0]
              );

              // Store IDs of deleted elements for history
              const deletedOriginalIds = affectedBlocks.map(block => block.id);
              affectedBlocks.forEach((block) => block.remove());

              this.currentSelection.selectAllChildren(newBlockElement);
              modifiedElementId = newBlockElement.id;
              newElement = newBlockElement;

              // ✅ NEW: Add batch history for block wrapping selection
              if (this.currentBookId) {
                  const historyPayload = {
                      updates: { // For undo, these are the original elements that were effectively 'deleted' and need to be re-added
                          nodeChunks: originalBlockStates.map(item => ({
                              book: this.currentBookId,
                              startLine: item.id,
                              html: item.html
                          }))
                      },
                      deletions: { // For undo, this is the newly created block element that needs to be removed
                          nodeChunks: [{
                              book: this.currentBookId,
                              startLine: newBlockElement.id,
                              html: newBlockElement.outerHTML
                          }]
                      }
                  };
                  await addHistoryBatch(this.currentBookId, historyPayload); // ✅ await here
              }
            } else {
              // Fallback for selections not in a block - this has the original bug
              // This part of the logic needs to be re-evaluated, but the main case is fixed.
              console.warn("Selection for block format is not within a recognized block. This may fail.");
              const parentElement = this.getSelectionParentElement();
              const containingBlock = this.findClosestBlockParent(parentElement);
              if (containingBlock) {
                const beforeId = findPreviousElementId(containingBlock);
                const afterId = findNextElementId(containingBlock);
                const newId = generateIdBetween(beforeId, afterId);

                document.execCommand("formatBlock", false, type);

                const newElem = document.getElementById(beforeId)?.nextElementSibling || document.getElementById(afterId)?.previousElementSibling;
                if (newElem) {
                  newElem.id = newId;
                  modifiedElementId = newId;
                  newElement = newElem;

                  // ✅ History for single block wrapping (fallback)
                  if (this.currentBookId && originalBlockStates.length > 0) {
                      const historyPayload = {
                          updates: {
                              nodeChunks: originalBlockStates.map(item => ({
                                  book: this.currentBookId,
                                  startLine: item.id,
                                  html: item.html
                              }))
                          },
                          deletions: {
                              nodeChunks: [{
                                  book: this.currentBookId,
                                  startLine: newElem.id,
                                  html: newElem.outerHTML
                              }]
                          }
                      };
                      await addHistoryBatch(this.currentBookId, historyPayload); // ✅ await here
                  }
                }
              }
            }
          } else {
            // CURSOR-ONLY LOGIC
            const parentElement = this.currentSelection.focusNode.parentElement;
            const blockParentToToggle = this.findClosestBlockParent(parentElement);
            const isBlockquote = blockParentToToggle?.tagName === "BLOCKQUOTE";
            const isCode = blockParentToToggle?.tagName === "PRE";

            if (
              (type === "blockquote" && isBlockquote) ||
              (type === "code" && isCode)
            ) {
              // UNWRAPPING
              const blockToUnwrap = blockParentToToggle;
              const beforeOriginalId = findPreviousElementId(blockToUnwrap);
              const afterOriginalId = findNextElementId(blockToUnwrap);
              const textContent = blockToUnwrap.textContent;
              const lines = textContent.split("\n");
              const fragment = document.createDocumentFragment();
              let lastId = beforeOriginalId;
              let firstNewP = null;
              const createdP_ids = []; // Track IDs of new P elements

              lines.forEach((line, index) => {
                if (line.trim() || lines.length === 1) {
                  const p = document.createElement("p");
                  p.textContent = line || "\u00A0";
                  p.id = generateIdBetween(lastId, afterOriginalId);
                  lastId = p.id;
                  if (index === 0) firstNewP = p;
                  fragment.appendChild(p);
                  createdP_ids.push({ id: p.id, html: p.outerHTML });
                }
              });

              if (fragment.childNodes.length > 0) {
                blockToUnwrap.parentNode.replaceChild(fragment, blockToUnwrap);
                newElement = firstNewP;
                modifiedElementId = newElement.id;
                this.setCursorAtTextOffset(newElement, 0);

                // ✅ History for unwrap
                if (this.currentBookId) {
                    const historyPayload = {
                        updates: { // For undo, these are the blocks that need to be re-wrapped (i.e., new P tags become the old block)
                            nodeChunks: [{
                                book: this.currentBookId,
                                startLine: blockToUnwrap.id,
                                html: blockToUnwrap.outerHTML // Original block to put back
                            }]
                        },
                        deletions: { // For undo, these are the new P tags that need to be removed
                            nodeChunks: createdP_ids.map(item => ({
                                book: this.currentBookId,
                                startLine: item.id,
                                html: item.html
                            }))
                        }
                    };
                    await addHistoryBatch(this.currentBookId, historyPayload); // ✅ await here
                }
              } else {
                // Handle empty case (unwrap an empty block)
                const p = document.createElement("p");
                p.innerHTML = "&nbsp;";
                p.id = generateIdBetween(beforeOriginalId, afterOriginalId);
                blockToUnwrap.parentNode.replaceChild(p, blockToUnwrap);
                newElement = p;
                modifiedElementId = p.id;
                this.setCursorAtTextOffset(newElement, 0);

                // ✅ History for unwrap empty
                if (this.currentBookId) {
                    const historyPayload = {
                        updates: {
                            nodeChunks: [{
                                book: this.currentBookId,
                                startLine: blockToUnwrap.id,
                                html: blockToUnwrap.outerHTML
                            }]
                        },
                        deletions: {
                            nodeChunks: [{
                                book: this.currentBookId,
                                startLine: p.id,
                                html: p.outerHTML
                            }]
                        }
                    };
                    await addHistoryBatch(this.currentBookId, historyPayload); // ✅ await here
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
                code.textContent = blockParentToToggle.textContent;
                newBlockElement.appendChild(code);
              }

              newBlockElement.id = generateIdBetween(beforeId, afterId);
              blockParentToToggle.parentNode.replaceChild(
                newBlockElement,
                blockParentToToggle
              );
              newElement = newBlockElement;
              modifiedElementId = newElement.id;
              this.setCursorAtTextOffset(newElement, currentOffset);

              // ✅ History for wrap
              if (this.currentBookId) {
                  const historyPayload = {
                      updates: { // For undo, this is the original block to put back
                          nodeChunks: [{
                              book: this.currentBookId,
                              startLine: blockParentToToggle.id,
                              html: blockParentToToggle.outerHTML
                          }]
                      },
                      deletions: { // For undo, this is the newly created wrapper block to remove
                          nodeChunks: [{
                              book: this.currentBookId,
                              startLine: newBlockElement.id,
                              html: newBlockElement.outerHTML
                          }]
                      }
                  };
                  await addHistoryBatch(this.currentBookId, historyPayload); // ✅ await here
              }
            }
          }
          break;
      }

      this.updateButtonStates();

      // ✅ THIS IS THE ONLY HISTORY/SAVE BLOCK THAT SHOULD REMAIN
      const handleHistoryAndSave = async () => { // Define an inner async function
        const affectedElementsAfter = [];
        if (modifiedElementId && document.getElementById(modifiedElementId)) {
          affectedElementsAfter.push({
            id: modifiedElementId,
            html: document.getElementById(modifiedElementId).outerHTML
          });
        } else if (modifiedElementId && newElement) {
          affectedElementsAfter.push({
            id: newElement.id,
            html: newElement.outerHTML
          });
        }

        if (this.currentBookId && (originalBlockStates.length > 0 || affectedElementsAfter.length > 0)) {
            const previousElementState = originalBlockStates.find(item => item.id === (modifiedElementId || newElement?.id));
            const newElementState = affectedElementsAfter.find(item => item.id === (modifiedElementId || newElement?.id));

            if (previousElementState && newElementState) {
                 await addHistoryBatch(this.currentBookId, {
                     updates: {
                         nodeChunks: [{
                             book: this.currentBookId,
                             startLine: previousElementState.id,
                             html: previousElementState.html
                         }]
                     },
                     deletions: {
                         nodeChunks: []
                     }
                 });
            } else if (!previousElementState && newElementState) {
                await addHistoryBatch(this.currentBookId, {
                    updates: { nodeChunks: [] },
                    deletions: {
                        nodeChunks: [{
                            book: this.currentBookId,
                            startLine: newElementState.id,
                            html: newElementState.html
                        }]
                    }
                });
            } else if (previousElementState && !newElementState) {
                await addHistoryBatch(this.currentBookId, {
                    updates: { nodeChunks: [] },
                    deletions: {
                        nodeChunks: [{
                            book: this.currentBookId,
                            startLine: previousElementState.id,
                            html: previousElementState.html
                        }]
                    }
                });
            }
        }
        // Save to IndexedDB if it's a direct element modification outside of `addHistoryBatch`'s implicit save
        if (modifiedElementId && newElement) {
          const updatedElement = document.getElementById(modifiedElementId);
          if (updatedElement) {
            await this.saveToIndexedDB(modifiedElementId, updatedElement.outerHTML);
          } else {
            await this.saveToIndexedDB(modifiedElementId, newElement.outerHTML);
          }
        }
        await this.updateHistoryButtonStates(); // Update button states AFTER history is processed
      };

      // Call the inner async function immediately (no setTimeout for this chain)
      handleHistoryAndSave().catch(error => {
          console.error("Error processing history and save:", error);
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
        }
      }
    );

    let node;
    while ((node = iterator.nextNode())) {
      elements.push(node);
    }
    return elements;
  }

  getBlockElementsInRange(range) {
    const blockElements = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) => {
          if (this.isBlockElement(node) && range.intersectsNode(node)) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    let node;
    while (node = walker.nextNode()) {
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
   * Helper method to update IndexedDB record
   * ✅ IMPORTANT: This function should now also trigger addHistoryBatch
   */
  async saveToIndexedDB(id, html) { // ✅ Mark as async
    console.log(`Manual update for element ID: ${id}`);
    if (!this.currentBookId) {
      console.warn("Cannot save to IndexedDB: currentBookId is not set.");
      return;
    }

    // Retrieve the current state from DB before update for history
    const db = await openDatabase();
    const tx = db.transaction("nodeChunks", "readonly");
    const store = tx.objectStore("nodeChunks");
    const request = store.get([this.currentBookId, id]);

    return new Promise((resolve, reject) => { // Wrap in Promise to await internal operations
        request.onsuccess = async (event) => { // ✅ Mark as async
            const oldRecord = event.target.result;
            const originalHtml = oldRecord ? oldRecord.html : null;

            updateIndexedDBRecord({
                id: id,
                html: html,
                action: "update",
                book: this.currentBookId
            }).then(async () => { // ✅ Mark as async
                console.log(`Successfully updated record with key: ${id}`);

                const payload = {
                    updates: {
                        nodeChunks: [{
                            book: this.currentBookId,
                            startLine: id,
                            html: originalHtml // The state to revert to on undo
                        }]
                    },
                    deletions: {
                        nodeChunks: [] // No deletions for a simple update
                    }
                };
                if (!originalHtml) { // If it was a new insertion
                    payload.deletions.nodeChunks.push({ book: this.currentBookId, startLine: id, html: html }); // To undo, delete the new item
                    payload.updates.nodeChunks = []; // No update needed for undo
                }

                await addHistoryBatch(this.currentBookId, payload); // ✅ await here
                await this.updateHistoryButtonStates(); // ✅ await here
                resolve(); // Resolve the promise once everything is done
            }).catch(error => {
                console.error(`Error updating IndexedDB record for ${id}:`, error);
                reject(error); // Reject on error
            });
        };
        request.onerror = (event) => {
            console.error(`Error fetching old record for history logging for ${id}:`, event.target.error);
            // Proceed with update anyway, but history might be incomplete
            updateIndexedDBRecord({
                id: id,
                html: html,
                action: "update",
                book: this.currentBookId
            }).then(async () => { // ✅ Mark as async
                console.log(`Successfully updated record with key: ${id} (history might be incomplete)`);
                await this.updateHistoryButtonStates(); // ✅ await here
                resolve(); // Resolve even if history is incomplete
            }).catch(error => {
                console.error(`Error updating IndexedDB record for ${id}:`, error);
                reject(error); // Reject on error
            });
        };
    });
  }

  /**
   * Unwrap selected text from any heading tag (H1-H6)
   */
  async unwrapSelectedTextFromHeading() { // ✅ Mark as async
    if (!this.currentSelection || this.currentSelection.isCollapsed) {
      console.warn("unwrapSelectedTextFromHeading called with no selection.");
      return null;
    }

    const range = this.currentSelection.getRangeAt(0);
    let headingElement = null;
    let currentElement = this.getSelectionParentElement();

    while (currentElement) {
      if (currentElement.nodeType === Node.ELEMENT_NODE && /^H[1-6]$/.test(currentElement.tagName)) {
        headingElement = currentElement;
        break;
      }
      if (currentElement.hasAttribute('contenteditable') && currentElement.getAttribute('contenteditable') === 'true') break;
      if (currentElement === document.body) break;
      currentElement = currentElement.parentNode;
    }

    if (!headingElement) {
      console.warn("unwrapSelectedTextFromHeading: Could not find parent heading element.");
      return null;
    }

    // Capture original state for history
    const originalHeadingHtml = headingElement.outerHTML;
    const originalHeadingId = headingElement.id;


    const beforeOriginalId = findPreviousElementId(headingElement);
    const afterOriginalId = findNextElementId(headingElement);

    const pElement = document.createElement("p");
    pElement.innerHTML = headingElement.innerHTML;

    const newPId = generateIdBetween(beforeOriginalId, afterOriginalId);
    if (!newPId) {
      console.error("unwrapSelectedTextFromHeading: Failed to generate a new ID for the paragraph.");
      pElement.id = `temp_${Date.now()}`;
    } else {
      pElement.id = newPId;
    }

    try {
      headingElement.parentNode.replaceChild(pElement, headingElement);
    } catch (domError) {
      console.error("unwrapSelectedTextFromHeading: DOM replacement failed.", domError);
      return null;
    }

    if (this.currentSelection) {
      const newRange = document.createRange();
      newRange.selectNodeContents(pElement);
      this.currentSelection.removeAllRanges();
      this.currentSelection.addRange(newRange);
    }

    console.log(`unwrapSelectedTextFromHeading: Returning ID "${newPId}" and element`, pElement);

    // ✅ NEW: Add to history after unwrap
    if (this.currentBookId) {
        const historyPayload = {
            updates: {
                nodeChunks: [{
                    book: this.currentBookId,
                    startLine: originalHeadingId,
                    html: originalHeadingHtml
                }]
            },
            deletions: {
                nodeChunks: [{
                    book: this.currentBookId,
                    startLine: pElement.id,
                    html: pElement.outerHTML
                }]
            }
        };
        await addHistoryBatch(this.currentBookId, historyPayload); // ✅ await here
        await this.updateHistoryButtonStates(); // ✅ await here
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

    return element.parentNode && element.parentNode.nodeType === 1 ?
      this.findParentWithTag(element.parentNode, tagName) : null;
  }

  /**
   * Show the toolbar
   */
  show() {
    if (this.isVisible) return;

    console.log('👁️ EditToolbar: Showing toolbar');

    this.toolbar.classList.add("visible");
    this.isVisible = true;
  }

  /**
   * Hide the toolbar
   */
  hide() {
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

    console.log('🧹 EditToolbar: Destroyed and cleaned up');
  }

  /**
   * Find the closest block-level parent element
   */
  findClosestBlockParent(element) {
    if (!element) return null;

    const blockElements = [
      'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'TD', 'TH'
    ];

    if (blockElements.includes(element.tagName)) {
      return element;
    }

    return element.parentNode && element.parentNode.nodeType === 1 ?
      this.findClosestBlockParent(element.parentNode) : null;
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
      range.setStart(targetNode, Math.min(targetOffset, targetNode.textContent?.length || 0));
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
      if (element.tagName === 'LI') {
        return element;
      }
      element = element.parentElement;
    }

    return null;
  }

  /**
   * Convert a list item to a block element (blockquote or code)
   */
  async convertListItemToBlock(listItem, blockType) { // ✅ Mark as async
    // Capture original state of parent list and the list item for history
    const originalParentListId = listItem.parentElement.id;
    const originalListItemId = listItem.id;
    const originalParentListHtml = listItem.parentElement.outerHTML; // Capture parent list's HTML
    const originalListItemHtml = listItem.outerHTML;

    const immediateParentList = listItem.parentElement;

    if (!immediateParentList || !['UL', 'OL'].includes(immediateParentList.tagName)) {
      console.warn("Cannot convert list item - not in a list");
      return;
    }

    let listWithId = immediateParentList;
    while (listWithId && listWithId !== document.body) {
      if ((listWithId.tagName === 'UL' || listWithId.tagName === 'OL') && listWithId.id) {
        break;
      }
      listWithId = listWithId.parentElement;
    }

    if (!listWithId) {
      console.warn("Cannot convert list item - no parent list with ID found");
      return;
    }

    console.log(`Converting list item from list with ID: ${listWithId.id}`);

    const newBlock = blockType === 'blockquote' ?
      document.createElement('blockquote') :
      document.createElement('pre');

    if (blockType === 'code') {
      const codeElement = document.createElement('code');
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
    newBlock.id = generateIdBetween(beforeId, afterId);

    // Perform DOM modification and capture new state for history
    const originalRootListHtmlBeforeSplit = listWithId.outerHTML; // Capture root list HTML before split

    await this.splitListAndInsertBlock(immediateParentList, listItem, newBlock, listWithId); // ✅ await here

    // Save the new block to IndexedDB
    await this.saveToIndexedDB(newBlock.id, newBlock.outerHTML); // ✅ await here
    this.setCursorAtTextOffset(newBlock, 0);

    // ✅ NEW: Add to history after list item conversion
    if (this.currentBookId) {
        const affectedElementsAfter = [];
        const updatedRootList = document.getElementById(listWithId.id);
        if (newBlock.id && document.getElementById(newBlock.id)) {
            affectedElementsAfter.push({
                id: newBlock.id,
                html: document.getElementById(newBlock.id).outerHTML
            });
        }
        if (updatedRootList) {
            affectedElementsAfter.push({
                id: updatedRootList.id,
                html: updatedRootList.outerHTML
            });
        }

        const historyPayload = {
            updates: {
                nodeChunks: [{
                    book: this.currentBookId,
                    startLine: listWithId.id,
                    html: originalRootListHtmlBeforeSplit // Revert root list to this state
                }]
            },
            deletions: {
                nodeChunks: [{
                    book: this.currentBookId,
                    startLine: newBlock.id,
                    html: newBlock.outerHTML // Remove the new block
                }]
            }
        };

        // If a new list was created after the split, add it to deletions for undo
        const newPostSplitList = document.getElementById(newBlock.nextElementSibling?.id);
        if (newPostSplitList && (newPostSplitList.tagName === 'UL' || newPostSplitList.tagName === 'OL')) {
            historyPayload.deletions.nodeChunks.push({
                book: this.currentBookId,
                startLine: newPostSplitList.id,
                html: newPostSplitList.outerHTML
            });
        }

        await addHistoryBatch(this.currentBookId, historyPayload); // ✅ await here
        await this.updateHistoryButtonStates(); // ✅ await here
    }

    return newBlock;
  }

  /**
   * Split a list around a specific item and insert a block element
   * Now ensures the original list's HTML state is captured if it's the `rootListWithId`
   */
  async splitListAndInsertBlock(parentList, targetItem, newBlock, rootListWithId) { // ✅ Mark as async
    const allItems = Array.from(parentList.children);
    const targetIndex = allItems.indexOf(targetItem);

    if (targetIndex === -1) return;

    const itemsBefore = allItems.slice(0, targetIndex);
    const itemsAfter = allItems.slice(targetIndex + 1);

    targetItem.remove(); // Remove the target item first

    // Store current state of rootListWithId if it's about to be modified for history purposes
    // const originalRootListHtml = rootListWithId.outerHTML; // This is captured in convertListItemToBlock now

    if (parentList === rootListWithId) {
      // Simple case: we're splitting the root list directly
      rootListWithId.parentNode.insertBefore(newBlock, rootListWithId.nextSibling);

      if (itemsAfter.length > 0) {
        const newList = document.createElement(parentList.tagName);
        const afterBlockId = findNextElementId(newBlock);
        newList.id = generateIdBetween(newBlock.id, afterBlockId);

        itemsAfter.forEach(item => newList.appendChild(item));

        newBlock.parentNode.insertBefore(newList, newBlock.nextSibling);
        await this.saveToIndexedDB(newList.id, newList.outerHTML); // This will call addHistoryBatch for the new list ✅ await here
      }
      await this.saveToIndexedDB(rootListWithId.id, rootListWithId.outerHTML); // This will call addHistoryBatch for the updated original list ✅ await here
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
        rootListWithId.parentNode.insertBefore(newBlock, insertAfter.nextSibling);

        if (itemsAfter.length > 0) {
          const newTopLevelItem = document.createElement('li');
          const newNestedList = document.createElement(parentList.tagName);

          itemsAfter.forEach(item => newNestedList.appendChild(item));
          newTopLevelItem.appendChild(newNestedList);

          const newList = document.createElement(rootListWithId.tagName);
          const afterBlockId = findNextElementId(newBlock);
          newList.id = generateIdBetween(newBlock.id, afterBlockId);

          newList.appendChild(newTopLevelItem);
          newBlock.parentNode.insertBefore(newList, newBlock.nextSibling);
          await this.saveToIndexedDB(newList.id, newList.outerHTML); // This will call addHistoryBatch ✅ await here
        }
      }
      await this.cleanupAfterSplit(rootListWithId); // Cleanup also saves to DB and triggers history ✅ await here
    }
  }

  async cleanupAfterSplit(rootList) { // ✅ Mark as async
    // Store original HTML of rootList before cleanup for history
    // const originalRootListHtml = rootList.outerHTML; // Captured in convertListItemToBlock

    const emptyLists = rootList.querySelectorAll('ul:empty, ol:empty');
    emptyLists.forEach(list => list.remove());

    const listItems = rootList.querySelectorAll('li');
    listItems.forEach(li => {
      const hasContent = li.textContent.trim() !== '';
      const hasNonEmptyChildren = Array.from(li.children).some(child =>
        child.textContent.trim() !== '' || child.children.length > 0
      );

      if (!hasContent && !hasNonEmptyChildren) {
        li.remove();
      }
    });

    // Save the updated root list, which will trigger addHistoryBatch
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
    if (options.currentBookId && options.currentBookId !== editToolbarInstance.currentBookId) {
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