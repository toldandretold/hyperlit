import { updateIndexedDBRecord } from "./cache-indexedDB.js";

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
    
    // Bind event handlers
    this.handleSelectionChange = this.handleSelectionChange.bind(this);
    this.handleEditableChange = this.handleEditableChange.bind(this);
    this.updatePosition = this.updatePosition.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.attachButtonHandlers = this.attachButtonHandlers.bind(this);
    
    this.resizeDebounceTimeout = null;
    this.isVisible = false;
    this.currentSelection = null;
  }
  
  /**
   * Initialize event listeners and set initial state.
   */
  init() {
    // Listen for selection changes
    document.addEventListener("selectionchange", this.handleSelectionChange);
    
    // Listen for changes to contenteditable attribute
    const observer = new MutationObserver(this.handleEditableChange);
    document.querySelectorAll(".main-content").forEach(element => {
      observer.observe(element, { 
        attributes: true, 
        attributeFilter: ['contenteditable'] 
      });
    });
    
    // Update position on window resize
    window.addEventListener("resize", this.handleResize);
    
    // Attach button click handlers
    this.attachButtonHandlers();
    
    // Initial check for editable content
    this.handleEditableChange();
    
    // Initial position update
    this.updatePosition();
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
  handleSelectionChange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    
    this.currentSelection = selection;
    
    // Check if selection is within editable content
    const editableContent = document.querySelector(this.editableSelector);
    if (!editableContent) {
      this.hide();
      return;
    }
    
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    
    // Check if the selection is within our editable content
    if (editableContent.contains(container)) {
      this.show();
      this.updateButtonStates();
      this.updatePosition();
    } else {
      this.hide();
    }
  }
  
  /**
   * Handle changes to contenteditable attribute
   */
  handleEditableChange() {
    const editableContent = document.querySelector(this.editableSelector);
    
    if (editableContent) {
      // Content is editable, check if selection is within it
      this.handleSelectionChange();
    } else {
      // Content is not editable, hide toolbar
      this.hide();
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
  const editableContent = document.querySelector(this.editableSelector);
  if (!editableContent || !this.currentSelection) return;
  
  // Focus the editable content to ensure commands work
  editableContent.focus();
  
  // Check if there's an actual text selection or just a cursor position
  const isTextSelected = !this.currentSelection.isCollapsed;
  const parentElement = this.getSelectionParentElement();
  
  switch (type) {
    case "bold":
      if (isTextSelected) {
        // Text is selected - apply/remove formatting only to selection
        document.execCommand("bold", false, null);
      } else {
        // Cursor position only - toggle formatting for the entire element
        if (this.hasParentWithTag(parentElement, "STRONG") || 
            this.hasParentWithTag(parentElement, "B")) {
          // Find the bold parent
          const boldElement = this.findParentWithTag(parentElement, "STRONG") || 
                              this.findParentWithTag(parentElement, "B");
          if (boldElement) {
            // Preserve the cursor position
            const range = this.currentSelection.getRangeAt(0);
            const offset = range.startOffset;
            const textNode = boldElement.firstChild;
            
            // Replace bold element with its text content
            const newTextNode = document.createTextNode(boldElement.textContent);
            boldElement.parentNode.replaceChild(newTextNode, boldElement);
            
            // Restore cursor position
            const newRange = document.createRange();
            newRange.setStart(newTextNode, Math.min(offset, newTextNode.length));
            newRange.setEnd(newTextNode, Math.min(offset, newTextNode.length));
            this.currentSelection.removeAllRanges();
            this.currentSelection.addRange(newRange);
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
            
            // Restore cursor to where it was
            const newRange = document.createRange();
            const boldNode = this.findParentWithTag(node, "STRONG") || 
                            this.findParentWithTag(node, "B");
            if (boldNode && boldNode.firstChild) {
              newRange.setStart(boldNode.firstChild, 0);
              newRange.collapse(true);
              this.currentSelection.removeAllRanges();
              this.currentSelection.addRange(newRange);
            }
          }
        }
      }
      break;
      
    case "italic":
      if (isTextSelected) {
        // Text is selected - apply/remove formatting only to selection
        document.execCommand("italic", false, null);
      } else {
        // Cursor position only - toggle formatting for the entire element
        if (this.hasParentWithTag(parentElement, "EM") || 
            this.hasParentWithTag(parentElement, "I")) {
          // Find the italic parent
          const italicElement = this.findParentWithTag(parentElement, "EM") || 
                               this.findParentWithTag(parentElement, "I");
          if (italicElement) {
            // Preserve the cursor position
            const range = this.currentSelection.getRangeAt(0);
            const offset = range.startOffset;
            const textNode = italicElement.firstChild;
            
            // Replace italic element with its text content
            const newTextNode = document.createTextNode(italicElement.textContent);
            italicElement.parentNode.replaceChild(newTextNode, italicElement);
            
            // Restore cursor position
            const newRange = document.createRange();
            newRange.setStart(newTextNode, Math.min(offset, newTextNode.length));
            newRange.setEnd(newTextNode, Math.min(offset, newTextNode.length));
            this.currentSelection.removeAllRanges();
            this.currentSelection.addRange(newRange);
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
            
            // Restore cursor to where it was
            const newRange = document.createRange();
            const italicNode = this.findParentWithTag(node, "EM") || 
                              this.findParentWithTag(node, "I");
            if (italicNode && italicNode.firstChild) {
              newRange.setStart(italicNode.firstChild, 0);
              newRange.collapse(true);
              this.currentSelection.removeAllRanges();
              this.currentSelection.addRange(newRange);
            }
          }
        }
      }
      break;
      

  }
  
  // Update button states after formatting
  this.updateButtonStates();
}

/**
 * Format the current block with the specified style
 */
/**
 * Format the current block with the specified style
 */
/**
 * Format the current block with the specified style
 */
formatBlock(type) {
  const editableContent = document.querySelector(this.editableSelector);
  if (!editableContent || !this.currentSelection) return;
  
  // Focus the editable content to ensure commands work
  editableContent.focus();
  
  // Check if there's an actual text selection or just a cursor position
  const isTextSelected = !this.currentSelection.isCollapsed;
  const parentElement = this.getSelectionParentElement();
  
  // Track the ID of the element being modified for later DB update
  let modifiedElementId = null;
  let newElement = null;
  
  switch (type) {
    case "heading":
      if (isTextSelected) {
        // Text is selected - create a new heading with just the selected text
        if (this.hasParentWithTag(parentElement, "H1") || 
            this.hasParentWithTag(parentElement, "H2") || 
            this.hasParentWithTag(parentElement, "H3") || 
            this.hasParentWithTag(parentElement, "H4") || 
            this.hasParentWithTag(parentElement, "H5") || 
            this.hasParentWithTag(parentElement, "H6")) {
          // If selection is already in a heading, convert it to paragraph
          this.unwrapSelectedTextFromHeading();
        } else {
          // Extract the selection and wrap it in a heading
          const range = this.currentSelection.getRangeAt(0);
          const h2Element = document.createElement("h2");
          
          try {
            // Try to surround the selection with the heading
            range.surroundContents(h2Element);
          } catch (e) {
            // If that fails (e.g., selection spans multiple nodes),
            // extract the content and insert it in a new heading
            const fragment = range.extractContents();
            h2Element.appendChild(fragment);
            range.insertNode(h2Element);
          }
        }
      } else {
        // Cursor position only - toggle heading for the entire block
        // Find the closest block-level parent with an ID
        const blockParent = this.findClosestBlockParent(parentElement);
        
        if (this.hasParentWithTag(parentElement, "H1") || 
            this.hasParentWithTag(parentElement, "H2") || 
            this.hasParentWithTag(parentElement, "H3") || 
            this.hasParentWithTag(parentElement, "H4") || 
            this.hasParentWithTag(parentElement, "H5") || 
            this.hasParentWithTag(parentElement, "H6")) {
          // Convert heading to paragraph
          const headingElement = this.findParentWithTag(parentElement, "H1") || 
                                this.findParentWithTag(parentElement, "H2") ||
                                this.findParentWithTag(parentElement, "H3") ||
                                this.findParentWithTag(parentElement, "H4") ||
                                this.findParentWithTag(parentElement, "H5") ||
                                this.findParentWithTag(parentElement, "H6");
          
          if (headingElement) {
            // Preserve the ID
            const id = headingElement.id;
            
            // Create a new paragraph with the same content
            const pElement = document.createElement("p");
            pElement.innerHTML = headingElement.innerHTML;
            
            // Set the same ID
            if (id) pElement.id = id;
            
            // Replace the heading with the paragraph
            headingElement.parentNode.replaceChild(pElement, headingElement);
            
            // Set cursor in the new paragraph
            const newRange = document.createRange();
            newRange.setStart(pElement, 0);
            newRange.collapse(true);
            this.currentSelection.removeAllRanges();
            this.currentSelection.addRange(newRange);
            
            // Store for IndexedDB update
            modifiedElementId = id;
            newElement = pElement;
          }
        } else if (blockParent) {
          // Convert paragraph or other block to heading
          // Preserve the ID
          const id = blockParent.id;
          
          // Create a new heading with the same content
          const h2Element = document.createElement("h2");
          h2Element.innerHTML = blockParent.innerHTML;
          
          // Set the same ID
          if (id) h2Element.id = id;
          
          // Replace the block with the heading
          blockParent.parentNode.replaceChild(h2Element, blockParent);
          
          // Set cursor in the new heading
          const newRange = document.createRange();
          newRange.setStart(h2Element, 0);
          newRange.collapse(true);
          this.currentSelection.removeAllRanges();
          this.currentSelection.addRange(newRange);
          
          // Store for IndexedDB update
          modifiedElementId = id;
          newElement = h2Element;
        }
      }
      break;
      
    case "blockquote":
      if (isTextSelected) {
        // Text is selected - create a new blockquote with just the selected text
        if (this.hasParentWithTag(parentElement, "BLOCKQUOTE")) {
          // If selection is already in a blockquote, convert it to paragraph
          this.unwrapSelectedTextFromTag("BLOCKQUOTE");
        } else {
          // Extract the selection and wrap it in a blockquote
          const range = this.currentSelection.getRangeAt(0);
          const blockquoteElement = document.createElement("blockquote");
          
          try {
            // Try to surround the selection with the blockquote
            range.surroundContents(blockquoteElement);
          } catch (e) {
            // If that fails (e.g., selection spans multiple nodes),
            // extract the content and insert it in a new blockquote
            const fragment = range.extractContents();
            blockquoteElement.appendChild(fragment);
            range.insertNode(blockquoteElement);
          }
        }
      } else {
        // Cursor position only - toggle blockquote for the entire block
        // Find the closest block-level parent with an ID
        const blockParent = this.findClosestBlockParent(parentElement);
        
        if (this.hasParentWithTag(parentElement, "BLOCKQUOTE")) {
          // Convert blockquote to paragraph
          const blockquoteElement = this.findParentWithTag(parentElement, "BLOCKQUOTE");
          
          if (blockquoteElement) {
            // Preserve the ID
            const id = blockquoteElement.id;
            
            // Create a new paragraph with the same content
            const pElement = document.createElement("p");
            pElement.innerHTML = blockquoteElement.innerHTML;
            
            // Set the same ID
            if (id) pElement.id = id;
            
            // Replace the blockquote with the paragraph
            blockquoteElement.parentNode.replaceChild(pElement, blockquoteElement);
            
            // Set cursor in the new paragraph
            const newRange = document.createRange();
            newRange.setStart(pElement, 0);
            newRange.collapse(true);
            this.currentSelection.removeAllRanges();
            this.currentSelection.addRange(newRange);
            
            // Store for IndexedDB update
            modifiedElementId = id;
            newElement = pElement;
          }
        } else if (blockParent) {
          // Convert paragraph or other block to blockquote
          // Preserve the ID
          const id = blockParent.id;
          
          // Create a new blockquote with the same content
          const blockquoteElement = document.createElement("blockquote");
          blockquoteElement.innerHTML = blockParent.innerHTML;
          
          // Set the same ID
          if (id) blockquoteElement.id = id;
          
          // Replace the block with the blockquote
          blockParent.parentNode.replaceChild(blockquoteElement, blockParent);
          
          // Set cursor in the new blockquote
          const newRange = document.createRange();
          newRange.setStart(blockquoteElement, 0);
          newRange.collapse(true);
          this.currentSelection.removeAllRanges();
          this.currentSelection.addRange(newRange);
          
          // Store for IndexedDB update
          modifiedElementId = id;
          newElement = blockquoteElement;
        }
      }
      break;

    case "code":
      // New code block handling
      if (isTextSelected) {
        // Text is selected - create a new code block with just the selected text
        if (this.hasParentWithTag(parentElement, "PRE") || 
            (this.hasParentWithTag(parentElement, "CODE") && this.hasParentWithTag(parentElement.parentNode, "PRE"))) {
          // If selection is already in a code block, convert it to paragraph
          this.unwrapSelectedTextFromCodeBlock();
        } else {
          // Extract the selection and wrap it in a code block
          const range = this.currentSelection.getRangeAt(0);
          const preElement = document.createElement("pre");
          const codeElement = document.createElement("code");
          preElement.appendChild(codeElement);
          
          try {
            // Try to surround the selection with the code block
            const fragment = range.extractContents();
            codeElement.appendChild(fragment);
            range.insertNode(preElement);
          } catch (e) {
            console.error("Error creating code block:", e);
          }
        }
      } else {
        // Cursor position only - toggle code block for the entire block
        // Find the closest block-level parent
        const blockParent = this.findClosestBlockParent(parentElement);
        
        if (this.hasParentWithTag(parentElement, "PRE") || 
            (this.hasParentWithTag(parentElement, "CODE") && this.hasParentWithTag(parentElement.parentNode, "PRE"))) {
          // If already in a code block, convert to paragraph
          const preElement = this.findParentWithTag(parentElement, "PRE");
          if (preElement) {
            // Preserve the ID
            const id = preElement.id;
            
            // Create a new paragraph
            const pElement = document.createElement("p");
            
            // Get the text content, preserving only inline formatting
            // But we need to make sure we're not preserving code tags
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = this.getTextWithInlineFormatting(preElement);
            
            // Remove any remaining code tags in the content
            const codeElements = tempDiv.querySelectorAll('code');
            codeElements.forEach(codeEl => {
              // Replace code element with its contents
              while (codeEl.firstChild) {
                codeEl.parentNode.insertBefore(codeEl.firstChild, codeEl);
              }
              codeEl.parentNode.removeChild(codeEl);
            });
            
            // Set the cleaned content
            pElement.innerHTML = tempDiv.innerHTML;
            
            // Set the same ID
            if (id) pElement.id = id;
            
            // Replace the pre element with the paragraph
            preElement.parentNode.replaceChild(pElement, preElement);
            
            // Set cursor in the new paragraph
            const newRange = document.createRange();
            newRange.setStart(pElement, 0);
            newRange.collapse(true);
            this.currentSelection.removeAllRanges();
            this.currentSelection.addRange(newRange);
            
            // Store for IndexedDB update
            modifiedElementId = id;
            newElement = pElement;
          }
        } else if (blockParent) {
          // Convert block to code block
          // Preserve the ID
          const id = blockParent.id;
          
          // Create a new code block
          const preElement = document.createElement("pre");
          const codeElement = document.createElement("code");
          preElement.appendChild(codeElement);
          
          // Get the text content, preserving only inline formatting
          const content = this.getTextWithInlineFormatting(blockParent);
          codeElement.innerHTML = content;
          
          // Set the same ID on the pre element
          if (id) preElement.id = id;
          
          // Replace the block with the code block
          blockParent.parentNode.replaceChild(preElement, blockParent);
          
          // Set cursor in the new code block
          const newRange = document.createRange();
          if (codeElement.firstChild) {
            newRange.setStart(codeElement.firstChild, 0);
          } else {
            newRange.setStart(codeElement, 0);
          }
          newRange.collapse(true);
          this.currentSelection.removeAllRanges();
          this.currentSelection.addRange(newRange);
          
          // Store for IndexedDB update
          modifiedElementId = id;
          newElement = preElement;
        }
      }
      break;
  }
  
  // Update button states after formatting
  this.updateButtonStates();
  
  // At the end of formatBlock method:
  if (modifiedElementId && newElement) {
    // Add a small delay to ensure DOM is updated
    setTimeout(() => {
      // Get the latest HTML from the DOM
      const updatedElement = document.getElementById(modifiedElementId);
      if (updatedElement) {
        this.saveToIndexedDB(modifiedElementId, updatedElement.outerHTML);
      } else {
        // If element is no longer in DOM, use the HTML we have
        this.saveToIndexedDB(modifiedElementId, newElement.outerHTML);
      }
    }, 50);
  }

}


/**
 * Helper method to update IndexedDB record
 * @param {string} id - The ID of the element to update
 * @param {string} html - The HTML content to save
 */
saveToIndexedDB(id, html) {
  console.log(`Manual update for element ID: ${id}`);
  
  // Use the imported updateIndexedDBRecord function
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
 * Unwrap selected text from a specific tag
 * @param {string} tagName - The tag name to unwrap from (e.g., "CODE", "BLOCKQUOTE")
 */
unwrapSelectedTextFromTag(tagName) {
  if (!this.currentSelection || this.currentSelection.isCollapsed) return;
  
  const range = this.currentSelection.getRangeAt(0);
  const fragment = range.extractContents();
  
  // Create a temporary div to hold the extracted content
  const tempDiv = document.createElement("div");
  tempDiv.appendChild(fragment);
  
  // Find all instances of the tag and unwrap them
  const elements = tempDiv.querySelectorAll(tagName.toLowerCase());
  elements.forEach(element => {
    // Replace the element with its contents
    while (element.firstChild) {
      element.parentNode.insertBefore(element.firstChild, element);
    }
    element.parentNode.removeChild(element);
  });
  
  // If the selection was entirely within the tag, we need to handle it differently
  const parentTag = this.findParentWithTag(range.commonAncestorContainer, tagName);
  if (parentTag) {
    // Split the parent tag at the selection points
    this.splitElementAtRange(parentTag, range);
  } else {
    // Insert the modified content back
    range.insertNode(tempDiv);
    
    // Remove the temporary div, leaving its contents
    while (tempDiv.firstChild) {
      tempDiv.parentNode.insertBefore(tempDiv.firstChild, tempDiv);
    }
    tempDiv.parentNode.removeChild(tempDiv);
  }
}

/**
 * Unwrap selected text from any heading tag (H1-H6)
 */
unwrapSelectedTextFromHeading() {
  if (!this.currentSelection || this.currentSelection.isCollapsed) return;
  
  const range = this.currentSelection.getRangeAt(0);
  const fragment = range.extractContents();
  
  // Create a temporary div to hold the extracted content
  const tempDiv = document.createElement("div");
  tempDiv.appendChild(fragment);
  
  // Find all heading elements and unwrap them
  const headings = tempDiv.querySelectorAll("h1, h2, h3, h4, h5, h6");
  headings.forEach(heading => {
    // Create a paragraph to replace the heading
    const p = document.createElement("p");
    
    // Move all children from heading to paragraph
    while (heading.firstChild) {
      p.appendChild(heading.firstChild);
    }
    
    // Replace heading with paragraph
    heading.parentNode.replaceChild(p, heading);
  });
  
  // Check if the selection was entirely within a heading
  const parentHeading = 
    this.findParentWithTag(range.commonAncestorContainer, "H1") ||
    this.findParentWithTag(range.commonAncestorContainer, "H2") ||
    this.findParentWithTag(range.commonAncestorContainer, "H3") ||
    this.findParentWithTag(range.commonAncestorContainer, "H4") ||
    this.findParentWithTag(range.commonAncestorContainer, "H5") ||
    this.findParentWithTag(range.commonAncestorContainer, "H6");
  
  if (parentHeading) {
    // Split the parent heading at the selection points
    this.splitElementAtRange(parentHeading, range);
  } else {
    // Insert the modified content back
    range.insertNode(tempDiv);
    
    // Remove the temporary div, leaving its contents
    while (tempDiv.firstChild) {
      tempDiv.parentNode.insertBefore(tempDiv.firstChild, tempDiv);
    }
    tempDiv.parentNode.removeChild(tempDiv);
  }
}

/**
 * Split an element at the points defined by a range
 * @param {Element} element - The element to split
 * @param {Range} range - The range defining the split points
 */
splitElementAtRange(element, range) {
  // Create a document fragment from the element's contents
  const contents = element.innerHTML;
  
  // Get the start and end offsets relative to the element
  const startOffset = this.getOffsetRelativeToElement(element, range.startContainer, range.startOffset);
  const endOffset = this.getOffsetRelativeToElement(element, range.endContainer, range.endOffset);
  
  // Split the content into three parts: before selection, selection, after selection
  const beforeContent = contents.substring(0, startOffset);
  const selectedContent = contents.substring(startOffset, endOffset);
  const afterContent = contents.substring(endOffset);
  
  // Create new elements
  const beforeElement = document.createElement(element.tagName);
  beforeElement.innerHTML = beforeContent;
  
  const selectedElement = document.createElement("p"); // Convert to paragraph
  selectedElement.innerHTML = selectedContent;
  
  const afterElement = document.createElement(element.tagName);
  afterElement.innerHTML = afterContent;
  
  // Replace the original element with the three new elements
  if (beforeContent.trim()) {
    element.parentNode.insertBefore(beforeElement, element);
  }
  
  element.parentNode.insertBefore(selectedElement, element);
  
  if (afterContent.trim()) {
    element.parentNode.insertBefore(afterElement, element);
  }
  
  // Remove the original element
  element.parentNode.removeChild(element);
  
  // Select the new paragraph content
  const newRange = document.createRange();
  newRange.selectNodeContents(selectedElement);
  this.currentSelection.removeAllRanges();
  this.currentSelection.addRange(newRange);
}

/**
 * Calculate the text offset relative to an element
 * @param {Element} element - The reference element
 * @param {Node} container - The container node
 * @param {number} offset - The offset within the container
 * @returns {number} The offset relative to the element
 */
getOffsetRelativeToElement(element, container, offset) {
  // Create a range from the start of the element to the selection point
  const range = document.createRange();
  range.setStart(element, 0);
  range.setEnd(container, offset);
  
  // The length of this range's text is the offset we want
  return range.toString().length;
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
   * Update the position of the toolbar
   */
  updatePosition() {
    window.requestAnimationFrame(() => {
      const mainContent = document.querySelector(".main-content");
      if (!mainContent) {
        return;
      }
      
      const windowWidth = window.innerWidth;
      const computedMainWidth = mainContent.offsetWidth - 20;
      const margin = (windowWidth - computedMainWidth) / 2;
      
      // Desired minimum distance from the main-content's edge
      const minDistance = 20;
      let newRight;
      
      if (margin >= 2 * minDistance) {
        newRight = margin - minDistance;
      } else {
        newRight = margin / 2;
      }
      
      // Update toolbar position
      this.toolbar.style.right = `${newRight}px`;
    });
  }
  
  /**
   * Handle resize event
   */
  handleResize() {
    this.toolbar.classList.add("disable-right-transition");
    this.updatePosition();
    
    clearTimeout(this.resizeDebounceTimeout);
    this.resizeDebounceTimeout = setTimeout(() => {
      this.toolbar.classList.remove("disable-right-transition");
    }, 100);
  }
  
  /**
   * Clean up event listeners
   */
  destroy() {
    document.removeEventListener("selectionchange", this.handleSelectionChange);
    window.removeEventListener("resize", this.handleResize);
  }

  /**
 * Find the closest block-level parent element
 * @param {Element} element - The starting element
 * @returns {Element|null} The closest block-level parent or null
 */
findClosestBlockParent(element) {
  if (!element) return null;
  
  // List of block-level elements
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
 * Get text content with inline formatting preserved
 * @param {Element} element - The element to extract content from
 * @returns {string} HTML content with inline formatting
 */
getTextWithInlineFormatting(element) {
  // Create a clone to work with
  const clone = element.cloneNode(true);
  
  // Remove any nested block elements, keeping their content
  const blockElements = clone.querySelectorAll('pre, blockquote, h1, h2, h3, h4, h5, h6, ul, ol, li, table, tr, td, th');
  blockElements.forEach(blockEl => {
    // Replace the block element with its innerHTML
    const fragment = document.createDocumentFragment();
    const div = document.createElement('div');
    div.innerHTML = blockEl.innerHTML;
    while (div.firstChild) {
      fragment.appendChild(div.firstChild);
    }
    blockEl.parentNode.replaceChild(fragment, blockEl);
  });
  
  return clone.innerHTML;
}

/**
 * Unwrap selected text from a code block
 */
/**
 * Unwrap selected text from a code block
 */
unwrapSelectedTextFromCodeBlock() {
  if (!this.currentSelection || this.currentSelection.isCollapsed) return;
  
  const range = this.currentSelection.getRangeAt(0);
  const fragment = range.extractContents();
  
  // Create a temporary div to hold the extracted content
  const tempDiv = document.createElement("div");
  tempDiv.appendChild(fragment);
  
  // First, handle any nested code elements inside pre elements
  const preElements = tempDiv.querySelectorAll("pre");
  preElements.forEach(preElement => {
    // Find code elements inside this pre
    const nestedCodeElements = preElement.querySelectorAll("code");
    
    // If there are nested code elements, unwrap them first
    if (nestedCodeElements.length > 0) {
      nestedCodeElements.forEach(codeElement => {
        // Replace the code element with its contents
        while (codeElement.firstChild) {
          preElement.insertBefore(codeElement.firstChild, codeElement);
        }
        codeElement.parentNode.removeChild(codeElement);
      });
    }
    
    // Now create a paragraph to replace the pre
    const p = document.createElement("p");
    
    // Move all children from pre to paragraph
    while (preElement.firstChild) {
      p.appendChild(preElement.firstChild);
    }
    
    // Replace pre with paragraph
    preElement.parentNode.replaceChild(p, preElement);
  });
  
  // Handle any standalone code elements (not inside pre)
  const standaloneCodeElements = tempDiv.querySelectorAll("code");
  standaloneCodeElements.forEach(element => {
    // Replace the element with its contents
    while (element.firstChild) {
      element.parentNode.insertBefore(element.firstChild, element);
    }
    element.parentNode.removeChild(element);
  });
  
  // Check if the selection was entirely within a code block
  const parentPre = this.findParentWithTag(range.commonAncestorContainer, "PRE");
  const parentCode = this.findParentWithTag(range.commonAncestorContainer, "CODE");
  
  if (parentPre || parentCode) {
    // If we have both a pre and code parent, handle the pre (which contains the code)
    const elementToSplit = parentPre || parentCode;
    
    // Split the parent element at the selection points
    this.splitElementAtRange(elementToSplit, range);
  } else {
    // Insert the modified content back
    range.insertNode(tempDiv);
    
    // Remove the temporary div, leaving its contents
    while (tempDiv.firstChild) {
      tempDiv.parentNode.insertBefore(tempDiv.firstChild, tempDiv);
    }
    tempDiv.parentNode.removeChild(tempDiv);
  }
}



}


/**
 * Initialize the edit toolbar if it doesn't exist yet
 * @param {Object} options - Configuration options for the EditToolbar
 * @returns {EditToolbar} The EditToolbar instance
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
 * @returns {EditToolbar|null} The EditToolbar instance or null if not initialized
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






