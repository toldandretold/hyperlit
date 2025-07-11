import { updateIndexedDBRecord } from "./cache-indexedDB.js";
import { generateIdBetween, findPreviousElementId, findNextElementId } from "./IDfunctions.js";

// Private module-level variable to hold the toolbar instance
let editToolbarInstance = null;

/**
 * EditToolbar class for handling formatting controls in editable content
 */
class EditToolbar {
  /**
   * Options:
   * - toolbarId: The ID of the edit toolbar element (default "edit-toolbar").
   * - editableSelector: The selector for the editable content area (default ".main-content[contenteditable='true']").
   */
  constructor(options = {}) {
    this.toolbarId = options.toolbarId || "edit-toolbar";
    this.editableSelector = options.editableSelector || ".main-content[contenteditable='true']";
    
    // Get DOM elements
    this.toolbar = document.getElementById(this.toolbarId);
    
    // Check if toolbar exists
    if (!this.toolbar) {
      throw new Error(`Element with id "${this.toolbarId}" not found.`);
    }
    
    // Get toolbar buttons
    this.boldButton = document.getElementById("boldButton");
    this.italicButton = document.getElementById("italicButton");
    this.headingButton = document.getElementById("headingButton");
    this.blockquoteButton = document.getElementById("blockquoteButton");
    this.codeButton = document.getElementById("codeButton");
    
    // Mobile keyboard detection properties
    this.initialViewportHeight = window.innerHeight;
    this.isKeyboardOpen = false;
    this.isMobile = window.innerWidth <= 768;
    
    // Bind event handlers
    this.handleSelectionChange = this.handleSelectionChange.bind(this);
    this.updatePosition = this.updatePosition.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.handleVisualViewportChange = this.handleVisualViewportChange.bind(this);
    this.attachButtonHandlers = this.attachButtonHandlers.bind(this);
    
    this.resizeDebounceTimeout = null;
    this.isVisible = false;
    this.currentSelection = null;
    this.isFormatting = false;
    this.lastValidRange = null;
  }
  
  /**
   * Initialize event listeners and set initial state.
   */
  init() {
    
    
    // Update position on window resize
    window.addEventListener("resize", this.handleResize);
    
    // Setup mobile keyboard detection
    this.setupMobileKeyboardDetection();
    
    // Attach button click handlers
    this.attachButtonHandlers();
    
    // Initial position update
    this.updatePosition();
     // Start hidden - will be shown when setEditMode(true) is called
    this.hide();
  }
  
  /**
   * Setup mobile keyboard detection
   */
  setupMobileKeyboardDetection() {
    // Detect browser type
    this.browserType = this.detectBrowser();
    console.log('🔧 EditToolbar: Detected browser:', this.browserType);
  console.log('🔧 EditToolbar: Initial viewport height:', window.innerHeight);
  console.log('🔧 EditToolbar: Visual viewport supported:', 'visualViewport' in window);
  
  // Log initial state
  this.logViewportState('Initial setup');
    
    // Listen for viewport changes
    window.addEventListener('resize', this.handleViewportChange);
    window.addEventListener('orientationchange', () => {
      setTimeout(() => {
        this.initialViewportHeight = window.innerHeight;
        this.handleViewportChange();
      }, 500);
    });
    
    // Visual Viewport API for better detection (modern browsers)
    if ('visualViewport' in window) {
      window.visualViewport.addEventListener('resize', this.handleVisualViewportChange);
    }
    
    // Additional event listeners for different browsers
    if (this.browserType === 'safari') {
      // Safari-specific handling
      window.addEventListener('focusin', this.handleFocusIn.bind(this));
      window.addEventListener('focusout', this.handleFocusOut.bind(this));
    }
  }
  
  logViewportState(context) {
  const state = {
    context: context,
    windowHeight: window.innerHeight,
    windowWidth: window.innerWidth,
    initialHeight: this.initialViewportHeight,
    heightDiff: this.initialViewportHeight - window.innerHeight,
    isMobile: this.isMobile,
    isKeyboardOpen: this.isKeyboardOpen,
    toolbarVisible: this.isVisible,
    toolbarBottom: this.toolbar.style.bottom,
    toolbarPosition: this.toolbar.style.position
  };
  
  if ('visualViewport' in window) {
    state.visualHeight = window.visualViewport.height;
    state.visualWidth = window.visualViewport.width;
    state.keyboardHeight = window.innerHeight - window.visualViewport.height;
  }
  
  console.log('📊 EditToolbar viewport state:', state);
}

  detectBrowser() {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('safari') && !userAgent.includes('chrome')) {
      return 'safari';
    } else if (userAgent.includes('chrome')) {
      return 'chrome';
    } else if (userAgent.includes('firefox')) {
      return 'firefox';
    }
    return 'unknown';
  }
  /**
   * Handle viewport changes for keyboard detection
   */
  

    /**
   * Handle focus in events (mainly for Safari)
   */
  handleFocusIn(event) {
    if (this.isMobile && event.target.contentEditable === 'true') {
      setTimeout(() => {
        this.adjustForKeyboard(true);
      }, 300); // Delay to let keyboard animate
    }
  }

  /**
   * Handle focus out events (mainly for Safari)
   */
  handleFocusOut(event) {
  console.log('🎯 EditToolbar: Focus out event', {
    target: event.target.tagName,
    contentEditable: event.target.contentEditable,
    isMobile: this.isMobile
  });
  
  if (this.isMobile && event.target.contentEditable === 'true') {
    console.log('⌨️ EditToolbar: Keyboard should be closing...');
    setTimeout(() => {
      this.logViewportState('Focus out - after timeout');
      this.adjustForKeyboard(false);
    }, 100);
  }
}


    /**
   * Adjust toolbar position based on keyboard state and browser
   */
  adjustForKeyboard(keyboardOpen) {
    if (!this.isMobile) return;
    
    console.log(`🔧 EditToolbar: Adjusting for keyboard - ${keyboardOpen ? 'OPEN' : 'CLOSED'}`);
    
    const mainContent = document.querySelector('.main-content');
    
    if (keyboardOpen) {
      this.isKeyboardOpen = true;
      this.toolbar.classList.add('keyboard-open');
      
      if (mainContent) {
        mainContent.classList.add('toolbar-visible');
      }
      
      // AGGRESSIVE positioning - try multiple approaches
      this.toolbar.style.position = 'fixed';
      this.toolbar.style.zIndex = '999999';
      this.toolbar.style.transform = 'none';
      
      // Try to position above keyboard
      let bottomPosition = '0px';
      
      if ('visualViewport' in window) {
        const keyboardHeight = window.innerHeight - window.visualViewport.height;
        if (keyboardHeight > 50) {
          bottomPosition = `${keyboardHeight}px`;
          console.log(`📱 EditToolbar: Positioning ${bottomPosition} above keyboard`);
        }
      }
      
      this.toolbar.style.bottom = bottomPosition;
      
      // Force a repaint
      this.toolbar.style.display = 'none';
      this.toolbar.offsetHeight; // Trigger reflow
      this.toolbar.style.display = 'flex';
      
      console.log(`✅ EditToolbar: Keyboard open styles applied - bottom: ${bottomPosition}`);
      
    } else {
      this.isKeyboardOpen = false;
      this.toolbar.classList.remove('keyboard-open');
      
      if (mainContent) {
        mainContent.classList.remove('toolbar-visible');
      }
      
      // Reset positioning
      this.toolbar.style.position = 'fixed';
      this.toolbar.style.bottom = '0px';
      this.toolbar.style.zIndex = '99999';
      
      console.log('✅ EditToolbar: Keyboard closed styles applied');
    }
    
    this.logViewportState(`After adjust - keyboard ${keyboardOpen ? 'open' : 'closed'}`);
  }

    /**
   * Handle viewport changes for keyboard detection
   */
  handleViewportChange() {
  const currentHeight = window.innerHeight;
  const heightDifference = this.initialViewportHeight - currentHeight;
  this.isMobile = window.innerWidth <= 768;
  
  console.log('📏 EditToolbar: Viewport change', {
    currentHeight: currentHeight,
    initialHeight: this.initialViewportHeight,
    heightDifference: heightDifference,
    isMobile: this.isMobile,
    browserType: this.browserType
  });
  
  if (!this.isMobile) return;
  
  const keyboardOpen = heightDifference > 150;
  
  console.log(`⌨️ EditToolbar: Keyboard detected as ${keyboardOpen ? 'OPEN' : 'CLOSED'} (diff: ${heightDifference}px)`);
  
  this.adjustForKeyboard(keyboardOpen);
  
  // Update initial height on small changes
  if (Math.abs(heightDifference) < 50) {
    this.initialViewportHeight = currentHeight;
    console.log('📏 EditToolbar: Updated initial viewport height to', currentHeight);
  }
}
  
    /**
   * Handle Visual Viewport API changes (better keyboard detection)
   */
  handleVisualViewportChange() {
  if (!this.isMobile) return;
  
  const keyboardHeight = window.innerHeight - window.visualViewport.height;
  const keyboardOpen = keyboardHeight > 150;
  
  console.log('📱 EditToolbar: Visual viewport change', {
    windowHeight: window.innerHeight,
    visualHeight: window.visualViewport.height,
    keyboardHeight: keyboardHeight,
    keyboardOpen: keyboardOpen,
    browserType: this.browserType
  });
  
  // FORCE positioning regardless of browser
  if (keyboardOpen) {
    const bottomPos = Math.max(0, keyboardHeight - 10);
    this.toolbar.style.bottom = `${bottomPos}px`;
    console.log(`🚀 EditToolbar: FORCING bottom position to ${bottomPos}px`);
  } else {
    this.toolbar.style.bottom = '0px';
    console.log('🚀 EditToolbar: FORCING bottom position to 0px');
  }
  
  this.adjustForKeyboard(keyboardOpen);
}
  
  /**
   * Attach click handlers to formatting buttons
   */
  attachButtonHandlers() {
    if (this.boldButton) {
      this.boldButton.addEventListener("click", () => this.formatText("bold"));
    }
    
    if (this.italicButton) {
      this.italicButton.addEventListener("click", () => this.formatText("italic"));
    }
    
    if (this.headingButton) {
      this.headingButton.addEventListener("click", () => this.formatBlock("heading"));
    }
    
    if (this.blockquoteButton) {
      this.blockquoteButton.addEventListener("click", () => this.formatBlock("blockquote"));
    }
    
    if (this.codeButton) {
      this.codeButton.addEventListener("click", () => this.formatBlock("code"));
    }
  }
  
  /**
   * Handle selection changes within the document
   */
    /**
   * Handle selection changes within the document (only for button states and positioning)
   */
    /**
   * Handle selection changes within the document (only for button states and positioning)
   */
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
          
          // Only store selection if it's within editable content
          if (editableContent.contains(container)) {
            // STORE THE VALID SELECTION
            this.currentSelection = selection;
            this.lastValidRange = range.cloneRange(); // Store a copy of the range
            this.updateButtonStates();
            this.updatePosition();
          }
          // Don't update currentSelection if it's outside editable content
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
      
      // Use the stored valid range if current selection is invalid
      let workingSelection = this.currentSelection;
      let workingRange = null;
      
      if (this.lastValidRange && editableContent.contains(this.lastValidRange.commonAncestorContainer)) {
        // Restore the last valid selection
        workingSelection = window.getSelection();
        workingSelection.removeAllRanges();
        workingSelection.addRange(this.lastValidRange);
        workingRange = this.lastValidRange;
        console.log("🔄 Restored valid selection to:", workingRange.commonAncestorContainer);
      } else if (workingSelection && workingSelection.rangeCount > 0) {
        workingRange = workingSelection.getRangeAt(0);
      }
      
      if (!workingSelection || !workingRange) {
        console.warn("❌ No valid selection found");
        return;
      }
      
      // Update currentSelection to the working selection
      this.currentSelection = workingSelection;
      
      // Focus the editable content to ensure commands work
      editableContent.focus();
      
      // Check if there's an actual text selection or just a cursor position
      const isTextSelected = !this.currentSelection.isCollapsed;
      const parentElement = this.getSelectionParentElement();
      
      // Track the ID of the element being modified for later DB update
      let modifiedElementId = null;
      let newElement = null;
      
      switch (type) {
        case "bold":
          if (isTextSelected) {
            // Text is selected - apply/remove formatting only to selection
            document.execCommand("bold", false, null);
            const parentAfterBold = this.getSelectionParentElement();
            console.log("Element after bold formatting:", parentAfterBold.outerHTML);
            console.log("Element ID:", parentAfterBold.id);
            
            // Find the block parent to save
            const blockParent = this.findClosestBlockParent(parentAfterBold);
            if (blockParent && blockParent.id) {
              modifiedElementId = blockParent.id;
              newElement = blockParent;
            }
          } else {
            // Cursor position only - get current offset before changes
            const currentOffset = this.getTextOffsetInElement(
              parentElement,
              this.currentSelection.focusNode,
              this.currentSelection.focusOffset
            );
            
            if (this.hasParentWithTag(parentElement, "STRONG") || 
                this.hasParentWithTag(parentElement, "B")) {
              // Find the bold parent
              const boldElement = this.findParentWithTag(parentElement, "STRONG") || 
                                  this.findParentWithTag(parentElement, "B");
              if (boldElement) {
                // Replace bold element with its text content
                const newTextNode = document.createTextNode(boldElement.textContent);
                const parentNode = boldElement.parentNode;
                parentNode.replaceChild(newTextNode, boldElement);
                
                // Restore cursor position at the same text offset
                this.setCursorAtTextOffset(parentNode, currentOffset);
                
                // Find the block parent to save
                const blockParent = this.findClosestBlockParent(parentNode);
                if (blockParent && blockParent.id) {
                  modifiedElementId = blockParent.id;
                  newElement = blockParent;
                }
              }
            } else {
              // Find the text node containing the cursor
              let node = this.currentSelection.focusNode;
              if (node.nodeType !== Node.TEXT_NODE) {
                // If not a text node, find the first text node child
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                node = walker.firstChild();
              }
              
              if (node && node.nodeType === Node.TEXT_NODE) {
                // Create a range that encompasses the entire text node
                const range = document.createRange();
                range.selectNodeContents(node);
                
                // Select the entire text node
                this.currentSelection.removeAllRanges();
                this.currentSelection.addRange(range);
                
                // Apply bold formatting
                document.execCommand("bold", false, null);
                
                // Find the new bold element and restore cursor position
                const newBoldNode = this.findParentWithTag(node.parentNode, "STRONG") || 
                                   this.findParentWithTag(node.parentNode, "B");
                if (newBoldNode) {
                  this.setCursorAtTextOffset(newBoldNode, currentOffset);
                  
                  // Find the block parent to save
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
            // Text is selected - apply/remove formatting only to selection
            document.execCommand("italic", false, null);
            
            // Find the block parent to save
            const parentAfterItalic = this.getSelectionParentElement();
            const blockParent = this.findClosestBlockParent(parentAfterItalic);
            if (blockParent && blockParent.id) {
              modifiedElementId = blockParent.id;
              newElement = blockParent;
            }
          } else {
            // Cursor position only - get current offset before changes
            const currentOffset = this.getTextOffsetInElement(
              parentElement,
              this.currentSelection.focusNode,
              this.currentSelection.focusOffset
            );
            
            if (this.hasParentWithTag(parentElement, "EM") || 
                this.hasParentWithTag(parentElement, "I")) {
              // Find the italic parent
              const italicElement = this.findParentWithTag(parentElement, "EM") || 
                                   this.findParentWithTag(parentElement, "I");
              if (italicElement) {
                // Replace italic element with its text content
                const newTextNode = document.createTextNode(italicElement.textContent);
                const parentNode = italicElement.parentNode;
                parentNode.replaceChild(newTextNode, italicElement);
                
                // Restore cursor position at the same text offset
                this.setCursorAtTextOffset(parentNode, currentOffset);
                
                // Find the block parent to save
                const blockParent = this.findClosestBlockParent(parentNode);
                if (blockParent && blockParent.id) {
                  modifiedElementId = blockParent.id;
                  newElement = blockParent;
                }
              }
            } else {
              // Find the text node containing the cursor
              let node = this.currentSelection.focusNode;
              if (node.nodeType !== Node.TEXT_NODE) {
                // If not a text node, find the first text node child
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                node = walker.firstChild();
              }
              
              if (node && node.nodeType === Node.TEXT_NODE) {
                // Create a range that encompasses the entire text node
                const range = document.createRange();
                range.selectNodeContents(node);
                
                // Select the entire text node
                this.currentSelection.removeAllRanges();
                this.currentSelection.addRange(range);
                
                // Apply italic formatting
                document.execCommand("italic", false, null);
                
                // Find the new italic element and restore cursor position
                const newItalicNode = this.findParentWithTag(node.parentNode, "EM") || 
                                     this.findParentWithTag(node.parentNode, "I");
                if (newItalicNode) {
                  this.setCursorAtTextOffset(newItalicNode, currentOffset);
                  
                  // Find the block parent to save
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
      // RESET THE FLAG AFTER A SHORT DELAY
      setTimeout(() => {
        this.isFormatting = false;
      }, 100);
    }
  }

  /**
   * Format the current block with the specified style
   */
  formatBlock(type) {
  console.log("🔧 Format block called:", {
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
    
    // ADD THE SAME SELECTION RESTORATION LOGIC AS formatText():
    let workingSelection = this.currentSelection;
    let workingRange = null;
    
    if (this.lastValidRange && editableContent.contains(this.lastValidRange.commonAncestorContainer)) {
      // Restore the last valid selection
      workingSelection = window.getSelection();
      workingSelection.removeAllRanges();
      workingSelection.addRange(this.lastValidRange);
      workingRange = this.lastValidRange;
      console.log("🔄 Restored valid selection to:", workingRange.commonAncestorContainer);
    } else if (workingSelection && workingSelection.rangeCount > 0) {
      workingRange = workingSelection.getRangeAt(0);
    }
    
    if (!workingSelection || !workingRange) {
      console.warn("❌ No valid selection found");
      return;
    }
    
    // Update currentSelection to the working selection
    this.currentSelection = workingSelection;
    
    // Focus the editable content to ensure commands work
    editableContent.focus();
    
    // Check if there's an actual text selection or just a cursor position
    const isTextSelected = !this.currentSelection.isCollapsed;
    const parentElement = this.getSelectionParentElement();

    // NEW: Special handling for list items
    const listItem = this.findClosestListItem(parentElement);
    if (listItem) {
      return this.convertListItemToBlock(listItem, type);
    }

    // Track the ID of the element being modified for later DB update
    let modifiedElementId = null;
    let newElement = null;
    
    switch (type) {
      case "heading":
        if (isTextSelected) {
          const range = this.currentSelection.getRangeAt(0);
          const affectedBlocks = this.getBlockElementsInRange(range);
          
          if (affectedBlocks.length === 0) {
            // Fallback to original single-element logic
            const parentElementForSelection = this.getSelectionParentElement();
            // ... your existing single-element logic
          } else {
            // Process each block element
            const modifiedElements = [];
            
            for (const block of affectedBlocks) {
              const isHeading = /^H[1-6]$/.test(block.tagName);
              
              if (isHeading) {
                // Convert heading to paragraph
                const pElement = document.createElement("p");
                pElement.innerHTML = block.innerHTML;
                pElement.id = block.id; // Keep the same ID
                block.parentNode.replaceChild(pElement, block);
                modifiedElements.push({ id: pElement.id, element: pElement });
              } else {
                // Convert to heading
                const h2Element = document.createElement("h2");
                h2Element.innerHTML = block.innerHTML;
                h2Element.id = block.id; // Keep the same ID
                block.parentNode.replaceChild(h2Element, block);
                modifiedElements.push({ id: h2Element.id, element: h2Element });
              }
            }
            
            // Restore selection across the modified elements
            this.selectAcrossElements(modifiedElements);
            
            // For compatibility with existing code, set the first modified element
            if (modifiedElements.length > 0) {
              modifiedElementId = modifiedElements[0].id;
              newElement = modifiedElements[0].element;
            }
          }
        } else {
          // Cursor position only - toggle heading for the entire block
          const cursorFocusParent = this.currentSelection.focusNode.parentElement;
          const blockParent = this.findClosestBlockParent(cursorFocusParent);

          if (
            blockParent && 
            (blockParent.tagName === "H1" ||
              blockParent.tagName === "H2" ||
              blockParent.tagName === "H3" ||
              blockParent.tagName === "H4" ||
              blockParent.tagName === "H5" ||
              blockParent.tagName === "H6")
          ) {
            // Convert heading to paragraph
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
            // Convert paragraph or other block to heading
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
        }
        break;

      case "blockquote":
        if (isTextSelected) {
          const range = this.currentSelection.getRangeAt(0);
          const commonAncestor = range.commonAncestorContainer;
          const parentElement =
            commonAncestor.nodeType === Node.ELEMENT_NODE
              ? commonAncestor
              : commonAncestor.parentElement;

          const containingBlockquote = parentElement.closest("blockquote");

          if (containingBlockquote) {
            // UNWRAPPING FROM BLOCKQUOTE (Selected Text)
            const beforeOriginalId = findPreviousElementId(containingBlockquote);
            const afterOriginalId = findNextElementId(containingBlockquote);

            const contentFragment = document.createDocumentFragment();
            const lines = containingBlockquote.innerHTML.split(/<br\s*\/?>/gi).filter(line => line.trim() !== '');
            let firstNewP = null;
            let lastGeneratedId = beforeOriginalId;

            lines.forEach((lineHTML, index) => {
              const trimmedLineHTML = lineHTML.trim();
              if (trimmedLineHTML) {
                const pElement = document.createElement("p");
                pElement.innerHTML = trimmedLineHTML;

                const newPId = generateIdBetween(lastGeneratedId, afterOriginalId);
                pElement.id = newPId;
                lastGeneratedId = newPId;

                if (index === 0) {
                  firstNewP = pElement;
                }
                contentFragment.appendChild(pElement);
              }
            });

            if (contentFragment.childNodes.length > 0) {
              containingBlockquote.parentNode.replaceChild(
                contentFragment,
                containingBlockquote
              );
              modifiedElementId = firstNewP ? firstNewP.id : null;
              newElement = firstNewP;
              if (newElement && this.currentSelection) {
                this.setCursorAtTextOffset(newElement, 0);
              }
            } else {
              // Handle empty blockquote
              const pElement = document.createElement("p");
              pElement.innerHTML = "&nbsp;";
              const newPId = generateIdBetween(beforeOriginalId, afterOriginalId);
              pElement.id = newPId;
              containingBlockquote.parentNode.replaceChild(
                pElement,
                containingBlockquote
              );
              modifiedElementId = newPId;
              newElement = pElement;
              if (newElement && this.currentSelection) {
                this.setCursorAtTextOffset(newElement, 0);
              }
            }
          } else {
            // WRAPPING INTO BLOCKQUOTE (Selected Text)
            const blockquoteElement = document.createElement("blockquote");
            const selectedFragment = range.extractContents();

            // Convert selected content to blockquote format with <br> tags
            let blockquoteContent = "";
            for (let i = 0; i < selectedFragment.childNodes.length; i++) {
              const node = selectedFragment.childNodes[i];
              if (node.nodeType === Node.TEXT_NODE) {
                blockquoteContent += node.textContent;
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                blockquoteContent += node.textContent || node.innerHTML;
              }
              // Add <br> between nodes (this creates the line breaks)
              if (i < selectedFragment.childNodes.length - 1) {
                blockquoteContent += "<br>";
              }
            }
            
            // Add a trailing <br> to match blockquote format
            if (blockquoteContent && !blockquoteContent.endsWith("<br>")) {
              blockquoteContent += "<br>";
            }
            
            blockquoteElement.innerHTML = blockquoteContent;

            range.insertNode(blockquoteElement);

            const beforeId = findPreviousElementId(blockquoteElement);
            const afterId = findNextElementId(blockquoteElement);
            const newBlockquoteId = generateIdBetween(beforeId, afterId);
            blockquoteElement.id = newBlockquoteId;

            this.currentSelection.selectAllChildren(blockquoteElement);
            modifiedElementId = newBlockquoteId;
            newElement = blockquoteElement;
          }
        } else {
          // CURSOR POSITION ONLY (No Text Selected)
          const parentElement = this.currentSelection.focusNode.parentElement;
          const blockParentToToggle = this.findClosestBlockParent(parentElement);

          if (
            blockParentToToggle &&
            blockParentToToggle.tagName === "BLOCKQUOTE"
          ) {
            // UNWRAPPING BLOCKQUOTE (Cursor Position)
            const blockquoteToConvert = blockParentToToggle;
            const beforeOriginalId = findPreviousElementId(blockquoteToConvert);
            const afterOriginalId = findNextElementId(blockquoteToConvert);

            const contentFragment = document.createDocumentFragment();
            const lines = blockquoteToConvert.innerHTML.split(/<br\s*\/?>/gi).filter(line => line.trim() !== '');
            let firstNewP = null;
            let lastGeneratedId = beforeOriginalId;

            const currentOffset = this.getTextOffsetInElement(
              blockquoteToConvert,
              this.currentSelection.focusNode,
              this.currentSelection.focusOffset
            );

            lines.forEach((lineHTML, index) => {
              const trimmedLineHTML = lineHTML.trim();
              if (trimmedLineHTML) {
                const pElement = document.createElement("p");
                pElement.innerHTML = trimmedLineHTML;
                const newPId = generateIdBetween(lastGeneratedId, afterOriginalId);
                pElement.id = newPId;
                lastGeneratedId = newPId;
                if (index === 0) {
                  firstNewP = pElement;
                }
                contentFragment.appendChild(pElement);
              }
            });

            if (contentFragment.childNodes.length > 0) {
              blockquoteToConvert.parentNode.replaceChild(
                contentFragment,
                blockquoteToConvert
              );
              modifiedElementId = firstNewP ? firstNewP.id : null;
              newElement = firstNewP;
              if (newElement) this.setCursorAtTextOffset(newElement, 0);
            } else {
              const pElement = document.createElement("p");
              pElement.innerHTML = "&nbsp;";
              const newPId = generateIdBetween(beforeOriginalId, afterOriginalId);
              pElement.id = newPId;
              blockquoteToConvert.parentNode.replaceChild(
                pElement,
                blockquoteToConvert
              );
              modifiedElementId = newPId;
              newElement = pElement;
              if (newElement) this.setCursorAtTextOffset(newElement, 0);
            }
          } else if (blockParentToToggle) {
            // WRAPPING BLOCK TO BLOCKQUOTE (Cursor Position)
            const beforeId = findPreviousElementId(blockParentToToggle);
            const afterId = findNextElementId(blockParentToToggle);

            const blockquoteElement = document.createElement("blockquote");
            const newBlockquoteId = generateIdBetween(beforeId, afterId);
            blockquoteElement.id = newBlockquoteId;
            
            // Convert paragraph content to blockquote format with trailing <br>
            let content = blockParentToToggle.innerHTML;
            if (content && !content.endsWith("<br>")) {
              content += "<br>";
            }
            blockquoteElement.innerHTML = content;

            const currentOffset = this.getTextOffsetInElement(
              blockParentToToggle,
              this.currentSelection.focusNode,
              this.currentSelection.focusOffset
            );

            blockParentToToggle.parentNode.replaceChild(
              blockquoteElement,
              blockParentToToggle
            );
            modifiedElementId = newBlockquoteId;
            newElement = blockquoteElement;
            this.setCursorAtTextOffset(newElement, currentOffset);
          }
        }
        break;

      case "code":
        const getContainingPre = (element) => {
          if (!element) return null;
          return element.closest("pre");
        };

        if (isTextSelected) {
          const range = this.currentSelection.getRangeAt(0);
          const commonAncestor = range.commonAncestorContainer;
          const parentElementForSelection =
            commonAncestor.nodeType === Node.ELEMENT_NODE
              ? commonAncestor
              : commonAncestor.parentElement;
          const containingPreForSelection = getContainingPre(
            parentElementForSelection
          );

          if (containingPreForSelection) {
            // UNWRAPPING FROM CODE BLOCK (Selected Text)
            const preToUnwrap = containingPreForSelection;
            const codeContentElement = preToUnwrap.querySelector("code");
            const textContent = codeContentElement
              ? codeContentElement.textContent
              : "";

            const beforeOriginalId = findPreviousElementId(preToUnwrap);
            const afterOriginalId = findNextElementId(preToUnwrap);

            const contentFragment = document.createDocumentFragment();
            const lines = textContent.split("\n");
            let firstNewP = null;
            let lastGeneratedId = beforeOriginalId;

            lines.forEach((lineText, index) => {
              if (lineText.trim() || (lines.length === 1 && index === 0)) {
                const pElement = document.createElement("p");
                pElement.textContent = lineText || "\u00A0";
                const newPId = generateIdBetween(lastGeneratedId, afterOriginalId);
                pElement.id = newPId;
                lastGeneratedId = newPId;
                if (index === 0) {
                  firstNewP = pElement;
                }
                contentFragment.appendChild(pElement);
              }
            });

            if (contentFragment.childNodes.length > 0) {
              preToUnwrap.parentNode.replaceChild(contentFragment, preToUnwrap);
              modifiedElementId = firstNewP ? firstNewP.id : null;
              newElement = firstNewP;
              if (newElement && this.currentSelection) {
                this.setCursorAtTextOffset(newElement, 0);
              }
            } else {
              const pElement = document.createElement("p");
              pElement.textContent = "\u00A0";
              const newPId = generateIdBetween(beforeOriginalId, afterOriginalId);
              pElement.id = newPId;
              preToUnwrap.parentNode.replaceChild(pElement, preToUnwrap);
              modifiedElementId = newPId;
              newElement = pElement;
              if (newElement && this.currentSelection) {
                this.setCursorAtTextOffset(newElement, 0);
              }
            }
          } else {
            // WRAPPING SELECTED TEXT INTO NEW CODE BLOCK
            const preElement = document.createElement("pre");
            const codeElement = document.createElement("code");
            preElement.appendChild(codeElement);

            const selectedFragment = range.extractContents();
            let combinedTextContent = "";

            for (let i = 0; i < selectedFragment.childNodes.length; i++) {
              const node = selectedFragment.childNodes[i];
              combinedTextContent += node.textContent;
              if (i < selectedFragment.childNodes.length - 1) {
                combinedTextContent += "\n";
              }
            }
            codeElement.textContent = combinedTextContent;

            range.insertNode(preElement);

            const beforeId = findPreviousElementId(preElement);
            const afterId = findNextElementId(preElement);
            const newPreId = generateIdBetween(beforeId, afterId);
            preElement.id = newPreId;

            if (this.currentSelection && codeElement.firstChild) {
              const newRange = document.createRange();
              newRange.selectNodeContents(codeElement);
              this.currentSelection.removeAllRanges();
              this.currentSelection.addRange(newRange);
            }

            modifiedElementId = newPreId;
            newElement = preElement;
          }
        } else {
          // CURSOR POSITION ONLY (No Text Selected)
          const focusElement = this.currentSelection.focusNode;
          const parentElementForCursor =
            focusElement.nodeType === Node.ELEMENT_NODE
              ? focusElement
              : focusElement.parentElement;
          const containingPreAtCursor = getContainingPre(parentElementForCursor);

          if (containingPreAtCursor) {
            // UNWRAPPING CODE BLOCK (Cursor Position)
            const preToUnwrap = containingPreAtCursor;
            const codeContentElement = preToUnwrap.querySelector("code");
            const textContent = codeContentElement
              ? codeContentElement.textContent
              : "";

            const beforeOriginalId = findPreviousElementId(preToUnwrap);
            const afterOriginalId = findNextElementId(preToUnwrap);

            const currentOffsetInfo = {
              node: this.currentSelection.focusNode,
              offset: this.currentSelection.focusOffset,
              charOffsetInCode: this.getTextOffsetInElement(
                codeContentElement || preToUnwrap,
                this.currentSelection.focusNode,
                this.currentSelection.focusOffset
              ),
            };

            const contentFragment = document.createDocumentFragment();
            const lines = textContent.split("\n");
            let firstNewP = null;
            let lastGeneratedId = beforeOriginalId;
            let pForCursor = null;
            let charCount = 0;

            lines.forEach((lineText, index) => {
              if (lineText.trim() || (lines.length === 1 && index === 0)) {
                const pElement = document.createElement("p");
                pElement.textContent = lineText || "\u00A0";
                const newPId = generateIdBetween(lastGeneratedId, afterOriginalId);
                pElement.id = newPId;
                lastGeneratedId = newPId;

                if (index === 0) firstNewP = pElement;
                contentFragment.appendChild(pElement);

                if (
                  !pForCursor &&
                  currentOffsetInfo.charOffsetInCode <= charCount + lineText.length
                ) {
                  pForCursor = pElement;
                }
                charCount += lineText.length + 1;
              }
            });

            if (contentFragment.childNodes.length > 0) {
              preToUnwrap.parentNode.replaceChild(contentFragment, preToUnwrap);
              modifiedElementId = firstNewP ? firstNewP.id : null;
              newElement = firstNewP;

              const targetP = pForCursor || firstNewP;
              if (targetP && this.currentSelection) {
                let newOffset = 0;
                if (pForCursor) {
                  let tempCharCount = 0;
                  for (let i = 0; i < lines.indexOf(targetP.textContent.replace(/\u00A0/g, '')); i++) {
                      tempCharCount += lines[i].length + 1;
                  }
                  newOffset = Math.max(0, currentOffsetInfo.charOffsetInCode - tempCharCount);
                  newOffset = Math.min(newOffset, targetP.textContent.length);
                }
                this.setCursorAtTextOffset(targetP, newOffset);
              }
            } else {
              const pElement = document.createElement("p");
              pElement.textContent = "\u00A0";
              const newPId = generateIdBetween(beforeOriginalId, afterOriginalId);
              pElement.id = newPId;
              preToUnwrap.parentNode.replaceChild(pElement, preToUnwrap);
              modifiedElementId = newPId;
              newElement = pElement;
              if (newElement && this.currentSelection) {
                this.setCursorAtTextOffset(newElement, 0);
              }
            }
          } else {
            // WRAPPING BLOCK TO CODE BLOCK (Cursor Position)
            const blockParentToWrap = this.findClosestBlockParent(
              parentElementForCursor
            );
            if (blockParentToWrap) {
              const beforeId = findPreviousElementId(blockParentToWrap);
              const afterId = findNextElementId(blockParentToWrap);

              const preElement = document.createElement("pre");
              const codeElement = document.createElement("code");
              preElement.appendChild(codeElement);

              const newPreId = generateIdBetween(beforeId, afterId);
              preElement.id = newPreId;

              codeElement.textContent = blockParentToWrap.textContent;

              const currentOffset = this.getTextOffsetInElement(
                blockParentToWrap,
                this.currentSelection.focusNode,
                this.currentSelection.focusOffset
              );

              blockParentToWrap.parentNode.replaceChild(
                preElement,
                blockParentToWrap
              );
              modifiedElementId = newPreId;
              newElement = preElement;

              if (codeElement.firstChild && this.currentSelection) {
                this.setCursorAtTextOffset(codeElement, currentOffset);
              } else if (this.currentSelection) {
                this.setCursorAtTextOffset(codeElement, 0);
              }
            }
          }
        }
        break;
    }
    
    // Update button states after formatting
    this.updateButtonStates();
    
    // Save to IndexedDB
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
    // RESET THE FLAG AFTER A SHORT DELAY
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
  
  // AGGRESSIVE mobile positioning
  if (this.isMobile) {
    console.log('📱 EditToolbar: Applying mobile positioning');
    
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.classList.add('toolbar-visible');
    }
    
    // Force all the positioning styles
    this.toolbar.style.position = 'fixed';
    this.toolbar.style.bottom = '0px';
    this.toolbar.style.left = '0px';
    this.toolbar.style.right = '0px';
    this.toolbar.style.zIndex = '999999';
    this.toolbar.style.transform = 'none';
    this.toolbar.style.display = 'flex';
    
    // Check if keyboard is already open
    setTimeout(() => {
      this.logViewportState('Show toolbar - checking keyboard state');
      if ('visualViewport' in window) {
        const keyboardHeight = window.innerHeight - window.visualViewport.height;
        if (keyboardHeight > 150) {
          console.log('🚨 EditToolbar: Keyboard already open on show!');
          this.adjustForKeyboard(true);
        }
      }
    }, 100);
  }
  
  this.logViewportState('After show');
}
  
  /**
   * Hide the toolbar
   */
  hide() {
    if (!this.isVisible) return;
    
    this.toolbar.classList.remove("visible");
    this.isVisible = false;
    
    // Remove content padding on mobile
    if (this.isMobile) {
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        mainContent.classList.remove('toolbar-visible');
      }
    }
  }
  
  /**
   * Update the position of the toolbar
   */
  updatePosition() {
    // Skip position updates on mobile when keyboard is open
    if (this.isMobile && this.isKeyboardOpen) {
      return;
    }
    
    window.requestAnimationFrame(() => {
      const mainContent = document.querySelector(".main-content");
      if (!mainContent) {
        return;
      }
      
      const windowWidth = window.innerWidth;
      const computedMainWidth = mainContent.offsetWidth - 20;
      const margin = (windowWidth - computedMainWidth) / 2;
      
      const minDistance = 20;
      let newRight;
      
      if (margin >= 2 * minDistance) {
        newRight = margin - minDistance;
      } else {
        newRight = margin / 2;
      }
      
      // Only update right position on desktop
      if (!this.isMobile) {
        this.toolbar.style.right = `${newRight}px`;
      }
    });
  }
  
  /**
   * Handle resize event
   */
  handleResize() {
    // Update mobile detection
    this.isMobile = window.innerWidth <= 768;
    
    if (!this.isMobile) {
      // Desktop resize handling
      this.toolbar.classList.add("disable-right-transition");
      this.updatePosition();
      
      clearTimeout(this.resizeDebounceTimeout);
      this.resizeDebounceTimeout = setTimeout(() => {
        this.toolbar.classList.remove("disable-right-transition");
      }, 100);
    }
  }
  
  /**
   * Clean up event listeners
   */
    destroy() {
  document.removeEventListener("selectionchange", this.handleSelectionChange);
  window.removeEventListener("resize", this.handleResize);
  window.removeEventListener("resize", this.handleViewportChange);
  window.removeEventListener('focusin', this.handleFocusIn);
  window.removeEventListener('focusout', this.handleFocusOut);
  
  if ('visualViewport' in window) {
    window.visualViewport.removeEventListener('resize', this.handleVisualViewportChange);
  }
  
  if (this.debugInterval) {
    clearInterval(this.debugInterval);
  }
  
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