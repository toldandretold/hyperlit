import { updateIndexedDBRecord, batchUpdateIndexedDBRecords, } from "./cache-indexedDB.js";
import { generateIdBetween, findPreviousElementId, findNextElementId } from "./IDfunctions.js";
import { undoLastBatch, redoLastBatch } from './historyManager.js';

// Private module-level variable to hold the toolbar instance
let editToolbarInstance = null;

/**
 * EditToolbar class for handling formatting controls in editable content
 */
class EditToolbar {
  constructor(options = {}) {
    this.toolbarId = options.toolbarId || "edit-toolbar";
    this.editableSelector = options.editableSelector || ".main-content[contenteditable='true']";
    
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
    
    this.isVisible = false;
    this.currentSelection = null;
    this.isFormatting = false;
    this.lastValidRange = null;

    // ✅ ADD THIS FLAG to prevent rapid clicks while an undo/redo is processing
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
  }
  
  /**
   * Attach click handlers to formatting buttons
   */
  attachButtonHandlers() {
    const buttons = [
      { element: this.boldButton, name: "bold", action: () => this.formatText("bold") },
      { element: this.italicButton, name: "italic", action: () => this.formatText("italic") },
      { element: this.headingButton, name: "heading", action: () => this.formatBlock("heading") },
      { element: this.blockquoteButton, name: "blockquote", action: () => this.formatBlock("blockquote") },
      { element: this.codeButton, name: "code", action: () => this.formatBlock("code") },
      { element: this.undoButton, name: "undo", action: () => this.handleUndo() },
      { element: this.redoButton, name: "redo", action: () => this.handleRedo() }
    ];
    
    buttons.forEach(({ element, name, action }) => {
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
        }, { passive: false });
        
        element.addEventListener("touchend", (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          console.log(`📱 ${name} touchend - executing action`);
          
          // Small delay to ensure selection is stored
          setTimeout(() => {
            action();
          }, 10);
        }, { passive: false });
        
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
    try {
      await undoLastBatch();
    } catch (error) {
      console.error("❌ Error during undo operation:", error);
    } finally {
      // This block will run AFTER await undoLastBatch() is complete,
      // ensuring the UI is unlocked for the next action.
      this.isProcessingHistory = false;
      console.log("✅ Undo/Redo lock released.");
    }
  }

  async handleRedo() {
    if (this.isProcessingHistory) {
      console.log("⏳ Undo/Redo already in progress. Please wait.");
      return;
    }
    this.isProcessingHistory = true;
    try {
      await redoLastBatch();
    } catch (error) {
      console.error("❌ Error during redo operation:", error);
    } finally {
      // This ensures the UI is unlocked even if redo fails.
      this.isProcessingHistory = false;
      console.log("✅ Undo/Redo lock released.");
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
formatText(type) {
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
    
    // Much simpler selection restoration
    let workingSelection = this.currentSelection;
    let workingRange = null;
    
    // First try lastValidRange if it exists
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
    
    // If no lastValidRange, try current selection
    if (!workingSelection || !workingRange) {
      workingSelection = window.getSelection();
      if (workingSelection && workingSelection.rangeCount > 0) {
        workingRange = workingSelection.getRangeAt(0);
      }
    }
    
    // If still nothing, just bail out
    if (!workingSelection || !workingRange) {
      console.warn("❌ No valid selection found - cannot format");
      return;
    }
    
    // Update currentSelection to the working selection
    this.currentSelection = workingSelection;
    
    // Focus the editable content to ensure commands work
    editableContent.focus();
    
    // Rest of your existing formatText logic stays exactly the same...
    const isTextSelected = !this.currentSelection.isCollapsed;
    const parentElement = this.getSelectionParentElement();
    
    let modifiedElementId = null;
    let newElement = null;
    
    switch (type) {
      case "bold":
        // Your existing bold logic here - don't change it
        if (isTextSelected) {
          document.execCommand("bold", false, null);
          const parentAfterBold = this.getSelectionParentElement();
          const blockParent = this.findClosestBlockParent(parentAfterBold);
          if (blockParent && blockParent.id) {
            modifiedElementId = blockParent.id;
            newElement = blockParent;
          }
        } else {
          // Your existing cursor-only bold logic
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
        // Your existing italic logic here - don't change it
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
    
    // Update button states after formatting
    this.updateButtonStates();
    
    // Save to IndexedDB if we have a modified element
    if (modifiedElementId && newElement) {
      setTimeout(() => {
        const updatedElement = document.getElementById(modifiedElementId);
        if (updatedElement) {
          this.saveToIndexedDB(modifiedElementId, updatedElement.outerHTML);
        } else {
          this.saveToIndexedDB(modifiedElementId, newElement.outerHTML);
        }
      }, 50);
    }

  } finally {
    setTimeout(() => {
      this.isFormatting = false;
    }, 100);
  }
}

/**
 * Format the current block with the specified style
 */
// IN edit-toolbar.js, REPLACE the entire formatBlock function with this:

/**
 * Format the current block with the specified style
 */
formatBlock(type) {
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
      return this.convertListItemToBlock(listItem, type);
    }

    let modifiedElementId = null;
    let newElement = null;

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
              newBlockElement.id = block.id;

              block.parentNode.replaceChild(newBlockElement, block);
              modifiedElementsForSelection.push({
                id: newBlockElement.id,
                element: newBlockElement,
              });
              recordsToUpdate.push({
                id: newBlockElement.id,
                html: newBlockElement.outerHTML,
              });
            }

            this.selectAcrossElements(modifiedElementsForSelection);
            if (recordsToUpdate.length > 0) {
              batchUpdateIndexedDBRecords(recordsToUpdate);
            }
            break;
          }
        }

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
          const newPId = generateIdBetween(beforeId, afterId);
          pElement.id = newPId;
          headingElement.parentNode.replaceChild(pElement, headingElement);
          this.setCursorAtTextOffset(pElement, currentOffset);
          modifiedElementId = newPId;
          newElement = pElement;
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
          const newH2Id = generateIdBetween(beforeId, afterId);
          h2Element.id = newH2Id;
          blockParent.parentNode.replaceChild(h2Element, blockParent);
          this.setCursorAtTextOffset(h2Element, currentOffset);
          modifiedElementId = newH2Id;
          newElement = h2Element;
        }
        break;

      case "blockquote":
      case "code":
        if (isTextSelected) {
          const range = this.currentSelection.getRangeAt(0);
          const affectedBlocks = this.getBlockElementsInRange(range);

          if (affectedBlocks.length > 0) {
            // ===== THE FIX IS HERE: Get position BEFORE changing the DOM =====
            const beforeId = findPreviousElementId(affectedBlocks[0]);
            const afterId = findNextElementId(
              affectedBlocks[affectedBlocks.length - 1]
            );

            // Combine the text content of all affected blocks
            const combinedText = affectedBlocks
              .map((block) => block.textContent)
              .join(type === "code" ? "\n" : " ");

            // Create the new element
            let newBlockElement;
            if (type === "blockquote") {
              newBlockElement = document.createElement("blockquote");
              newBlockElement.innerHTML = combinedText.trim() + "<br>";
            } else {
              // 'code'
              newBlockElement = document.createElement("pre");
              const codeElement = document.createElement("code");
              codeElement.textContent = combinedText;
              newBlockElement.appendChild(codeElement);
            }

            // Generate the ID using the saved position
            newBlockElement.id = generateIdBetween(beforeId, afterId);

            // Replace the old blocks with the new one
            const parent = affectedBlocks[0].parentNode;
            parent.insertBefore(
              newBlockElement,
              affectedBlocks[0]
            );
            affectedBlocks.forEach((block) => block.remove());

            // Set selection and save
            this.currentSelection.selectAllChildren(newBlockElement);
            modifiedElementId = newBlockElement.id;
            newElement = newBlockElement;
            // ======================= END OF FIX ============================
          } else {
            // Fallback for selections not in a block - this has the original bug
            // This part of the logic needs to be re-evaluated, but the main case is fixed.
            console.warn("Selection for block format is not within a recognized block. This may fail.");
            const parentElement = this.getSelectionParentElement();
            const containingBlock = this.findClosestBlockParent(parentElement);
            if (containingBlock) {
                // This is a complex case, for now we just wrap the whole block
                // to prevent the ID bug.
                const beforeId = findPreviousElementId(containingBlock);
                const afterId = findNextElementId(containingBlock);
                const newId = generateIdBetween(beforeId, afterId);
                
                document.execCommand("formatBlock", false, type);
                
                // Find the newly created element and assign the correct ID
                const newElem = document.getElementById(beforeId)?.nextElementSibling || document.getElementById(afterId)?.previousElementSibling;
                if(newElem) {
                    newElem.id = newId;
                    modifiedElementId = newId;
                    newElement = newElem;
                }
            }
          }
        } else {
          // CURSOR-ONLY LOGIC (This was already correct)
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

            lines.forEach((line, index) => {
              if (line.trim() || lines.length === 1) {
                const p = document.createElement("p");
                p.textContent = line || "\u00A0";
                p.id = generateIdBetween(lastId, afterOriginalId);
                lastId = p.id;
                if (index === 0) firstNewP = p;
                fragment.appendChild(p);
              }
            });

            if (fragment.childNodes.length > 0) {
              blockToUnwrap.parentNode.replaceChild(fragment, blockToUnwrap);
              newElement = firstNewP;
              modifiedElementId = newElement.id;
              this.setCursorAtTextOffset(newElement, 0);
            } else {
              // Handle empty case
              const p = document.createElement("p");
              p.innerHTML = "&nbsp;";
              p.id = generateIdBetween(beforeOriginalId, afterOriginalId);
              blockToUnwrap.parentNode.replaceChild(p, blockToUnwrap);
              newElement = p;
              modifiedElementId = p.id;
              this.setCursorAtTextOffset(newElement, 0);
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
              // 'code'
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
          }
        }
        break;
    }

    this.updateButtonStates();

    if (modifiedElementId && newElement) {
      setTimeout(() => {
        const updatedElement = document.getElementById(modifiedElementId);
        if (updatedElement) {
          this.saveToIndexedDB(modifiedElementId, updatedElement.outerHTML);
        } else {
          this.saveToIndexedDB(modifiedElementId, newElement.outerHTML);
        }
      }, 50);
    }
  } finally {
    setTimeout(() => {
      this.isFormatting = false;
    }, 100);
  }
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
        }
      }
    );
    
    let node;
    while (node = walker.nextNode()) {
      blockElements.push(node);
    }
    
    return blockElements;
  }

  isBlockElement(element) {
    const blockTags = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'LI'];
    return blockTags.includes(element.tagName);
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
   */
  saveToIndexedDB(id, html) {
    console.log(`Manual update for element ID: ${id}`);
    
    updateIndexedDBRecord({
      id: id,
      html: html,
      action: "update"
    }).then(() => {
      console.log(`Successfully updated record with key: ${id}`);
    }).catch(error => {
      console.error(`Error updating IndexedDB record for ${id}:`, error);
    });
  }

  /**
   * Unwrap selected text from any heading tag (H1-H6)
   */
  unwrapSelectedTextFromHeading() {
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
  convertListItemToBlock(listItem, blockType) {
    // Find the immediate parent list (even if it doesn't have an ID)
    const immediateParentList = listItem.parentElement;
    
    if (!immediateParentList || !['UL', 'OL'].includes(immediateParentList.tagName)) {
      console.warn("Cannot convert list item - not in a list");
      return;
    }
    
    // Walk up to find a list with an ID for positioning reference
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
    
    // Create the new block element
    const newBlock = blockType === 'blockquote' 
      ? document.createElement('blockquote')
      : document.createElement('pre');
      
    if (blockType === 'code') {
      const codeElement = document.createElement('code');
      newBlock.appendChild(codeElement);
      // FIX: Only get the direct text content of the specific list item
      codeElement.textContent = listItem.textContent.trim();
    } else {
      // For blockquote, only get the direct innerHTML of the specific list item
      let content = listItem.innerHTML.trim();
      if (content && !content.endsWith("<br>")) {
        content += "<br>";
      }
      newBlock.innerHTML = content;
    }
        
    // Generate ID based on the list with ID's position
    const beforeId = findPreviousElementId(listWithId);
    const afterId = findNextElementId(listWithId);
    newBlock.id = generateIdBetween(beforeId, afterId);
    
    // Now split the immediate parent list at the target item
    this.splitListAndInsertBlock(immediateParentList, listItem, newBlock, listWithId);
    
    // Position cursor and save
    this.setCursorAtTextOffset(newBlock, 0);
    this.saveToIndexedDB(newBlock.id, newBlock.outerHTML);
    
    return newBlock;
  }

  /**
   * Split a list around a specific item and insert a block element
   */
  splitListAndInsertBlock(parentList, targetItem, newBlock, rootListWithId) {
    const allItems = Array.from(parentList.children);
    const targetIndex = allItems.indexOf(targetItem);
    
    if (targetIndex === -1) return;
    
    const itemsBefore = allItems.slice(0, targetIndex);
    const itemsAfter = allItems.slice(targetIndex + 1);
    
    // STEP 1: Remove the target item first
    targetItem.remove();
    
    // STEP 2: Handle the case where we need to split the immediate parent list
    if (parentList === rootListWithId) {
      // Simple case: we're splitting the root list directly
      
      // Insert the new block after the current list
      rootListWithId.parentNode.insertBefore(newBlock, rootListWithId.nextSibling);
      
      // If there are items after, create a new list for them
      if (itemsAfter.length > 0) {
        const newList = document.createElement(parentList.tagName);
        const afterBlockId = findNextElementId(newBlock);
        newList.id = generateIdBetween(newBlock.id, afterBlockId);
        
        // Move remaining items to the new list
        itemsAfter.forEach(item => newList.appendChild(item));
        
        // Insert the new list after the block
        newBlock.parentNode.insertBefore(newList, newBlock.nextSibling);
        this.saveToIndexedDB(newList.id, newList.outerHTML);
      }
      
      // Update the original list (now only contains items before)
      this.saveToIndexedDB(rootListWithId.id, rootListWithId.outerHTML);
      
    } else {
      // Complex case: we're in a nested list, need to find the exact insertion point
      
      // Find the path from the nested list back to the root
      const pathToRoot = [];
      let currentElement = parentList;
      
      while (currentElement && currentElement !== rootListWithId) {
        pathToRoot.unshift(currentElement);
        currentElement = currentElement.parentElement;
      }
      
      // Find the top-level item in the root list that contains our nested structure
      let topLevelItem = parentList;
      while (topLevelItem.parentElement !== rootListWithId) {
        topLevelItem = topLevelItem.parentElement;
      }
      
      // Get the position of this top-level item in the root list
      const rootItems = Array.from(rootListWithId.children);
      const topLevelIndex = rootItems.indexOf(topLevelItem);
      
      // Insert the new block after this top-level item
      if (topLevelIndex !== -1) {
        const insertAfter = rootItems[topLevelIndex];
        rootListWithId.parentNode.insertBefore(newBlock, insertAfter.nextSibling);
        
        // If there are items after in the nested list, we need to restructure
        if (itemsAfter.length > 0) {
          // Create a new top-level item to hold the remaining nested items
          const newTopLevelItem = document.createElement('li');
          const newNestedList = document.createElement(parentList.tagName);
          
          itemsAfter.forEach(item => newNestedList.appendChild(item));
          newTopLevelItem.appendChild(newNestedList);
          
          // Insert this new structure after our block
          const newList = document.createElement(rootListWithId.tagName);
          const afterBlockId = findNextElementId(newBlock);
          newList.id = generateIdBetween(newBlock.id, afterBlockId);
          
          newList.appendChild(newTopLevelItem);
          newBlock.parentNode.insertBefore(newList, newBlock.nextSibling);
          this.saveToIndexedDB(newList.id, newList.outerHTML);
        }
      }
      
      // Clean up the original structure
      this.cleanupAfterSplit(rootListWithId);
    }
  }

  cleanupAfterSplit(rootList) {
    // Remove empty nested lists
    const emptyLists = rootList.querySelectorAll('ul:empty, ol:empty');
    emptyLists.forEach(list => list.remove());
    
    // Remove list items that only contain empty lists or are empty
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
    
    // Save the updated root list
    this.saveToIndexedDB(rootList.id, rootList.outerHTML);
  }
}

/**
 * Initialize the edit toolbar if it doesn't exist yet
 */
export function initEditToolbar(options = {}) {
  if (!editToolbarInstance) {
    editToolbarInstance = new EditToolbar(options);
    editToolbarInstance.init();
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