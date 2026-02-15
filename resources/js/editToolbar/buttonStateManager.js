/**
 * Button State Manager for EditToolbar
 *
 * Manages the active/disabled states of formatting buttons based on current selection.
 * Updates button visual states to reflect the formatting at the cursor/selection position.
 */

import {
  hasParentWithTag,
  findClosestBlockParent,
  getBlockElementsInRange,
} from "./toolbarDOMUtils.js";

/**
 * ButtonStateManager class
 * Handles updating button states based on selection context
 */
export class ButtonStateManager {
  constructor(options = {}) {
    // Button references
    this.boldButton = options.boldButton || null;
    this.italicButton = options.italicButton || null;
    this.headingButton = options.headingButton || null;
    this.blockquoteButton = options.blockquoteButton || null;
    this.codeButton = options.codeButton || null;
    this.citationButton = options.citationButton || null;

    // Submenu reference
    this.headingSubmenu = options.headingSubmenu || null;

    // SelectionManager reference
    this.selectionManager = options.selectionManager || null;

    // Stored heading element (for Firefox X button support)
    this.storedHeadingElement = null;
  }

  /**
   * Update the active states of formatting buttons based on current selection
   */
  updateButtonStates() {
    if (!this.selectionManager || !this.selectionManager.currentSelection) return;

    const parentElement = this.selectionManager.getSelectionParentElement();
    const isTextSelected = !this.selectionManager.currentSelection.isCollapsed;

    // Check if selection/cursor is in paragraph context (for blockquote/code)
    let isInParagraphContext = true;
    if (isTextSelected && this.selectionManager.currentSelection.rangeCount > 0) {
      // Multi-block selection: check all blocks are paragraphs
      const range = this.selectionManager.currentSelection.getRangeAt(0);
      const affectedBlocks = getBlockElementsInRange(range);
      if (affectedBlocks.length > 0) {
        isInParagraphContext = affectedBlocks.every(block => block.tagName === 'P');
      }
    } else {
      // Cursor-only: check current block is a paragraph (or already blockquote/code)
      const blockParent = findClosestBlockParent(parentElement);
      if (blockParent) {
        isInParagraphContext = blockParent.tagName === 'P' ||
                               blockParent.tagName === 'BLOCKQUOTE' ||
                               blockParent.tagName === 'PRE';
      }
    }

    // Update bold button state
    // NOTE: Don't use queryCommandState("bold") as it returns true for headings (CSS bold)
    if (this.boldButton) {
      const isBold = hasParentWithTag(parentElement, "STRONG") ||
                     hasParentWithTag(parentElement, "B");
      this.boldButton.classList.toggle("active", isBold);
    }

    // Update italic button state
    // NOTE: Don't use queryCommandState("italic") as it may return false positives
    if (this.italicButton) {
      const isItalic = hasParentWithTag(parentElement, "EM") ||
                       hasParentWithTag(parentElement, "I");
      this.italicButton.classList.toggle("active", isItalic);
    }

    // Update heading button state
    if (this.headingButton) {
      const activeLevel =
        hasParentWithTag(parentElement, "H1") ? "h1" :
        hasParentWithTag(parentElement, "H2") ? "h2" :
        hasParentWithTag(parentElement, "H3") ? "h3" :
        hasParentWithTag(parentElement, "H4") ? "h4" :
        hasParentWithTag(parentElement, "H5") ? "h5" :
        hasParentWithTag(parentElement, "H6") ? "h6" : null;

      this.headingButton.classList.toggle("active", !!activeLevel);

      // Store the current heading element (for Firefox X button support)
      if (activeLevel && parentElement) {
        const blockParent = findClosestBlockParent(parentElement);
        if (blockParent && /^H[1-6]$/.test(blockParent.tagName)) {
          this.storedHeadingElement = blockParent;
        }
      } else {
        this.storedHeadingElement = null;
      }

      // Update submenu button states
      if (this.headingSubmenu) {
        this.headingSubmenu.querySelectorAll("[data-heading]").forEach(btn => {
          btn.classList.toggle("active", btn.dataset.heading === activeLevel);
        });
      }
    }

    // Update blockquote button state
    if (this.blockquoteButton) {
      const isActive = hasParentWithTag(parentElement, "BLOCKQUOTE");
      this.blockquoteButton.classList.toggle("active", isActive);

      // Disable if not in paragraph context (applies to both selection and cursor)
      const shouldDisable = !isInParagraphContext && !isActive;
      this.blockquoteButton.classList.toggle("disabled", shouldDisable);
      this.blockquoteButton.disabled = shouldDisable;
    }

    // Update code button state
    if (this.codeButton) {
      const isActive = hasParentWithTag(parentElement, "CODE") ||
                       hasParentWithTag(parentElement, "PRE");
      this.codeButton.classList.toggle("active", isActive);

      // Disable if not in paragraph context (applies to both selection and cursor)
      const shouldDisable = !isInParagraphContext && !isActive;
      this.codeButton.classList.toggle("disabled", shouldDisable);
      this.codeButton.disabled = shouldDisable;
    }

    // Update citation button state
    if (this.citationButton) {
      // Check if we have a valid range in editable content
      const hasValidRange = this.selectionManager.lastValidRange &&
        this.selectionManager.lastValidRange.commonAncestorContainer;

      // Verify the range is still in the document and in editable content
      const editableContent = document.querySelector(this.selectionManager.editableSelector);
      const isRangeValid = hasValidRange &&
        editableContent &&
        editableContent.contains(this.selectionManager.lastValidRange.commonAncestorContainer);

      // Disable if no valid range in editable content
      const shouldDisable = !isRangeValid;
      this.citationButton.classList.toggle("disabled", shouldDisable);
      this.citationButton.disabled = shouldDisable;
    }
  }

  /**
   * Get the stored heading element (used by heading submenu)
   * @returns {Element|null}
   */
  getStoredHeadingElement() {
    return this.storedHeadingElement;
  }

  /**
   * Set the stored heading element (used by heading submenu)
   * @param {Element|null} element
   */
  setStoredHeadingElement(element) {
    this.storedHeadingElement = element;
  }
}
