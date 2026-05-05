/**
 * Block Submenu Handler for EditToolbar
 *
 * Manages the block format dropdown submenu (bullet list, numbered list, blockquote):
 * - Opening/closing the submenu
 * - Handling block type selection
 * - Handling "Remove" X button (for lists and blockquotes)
 * - Click-outside detection for closing
 */

import {
  hasParentWithTag,
  findClosestBlockParent,
} from "./toolbarDOMUtils.js";

/**
 * BlockSubmenu class
 * Handles all block format submenu interactions
 */
export class BlockSubmenu {
  constructor(options = {}) {
    this.blockSubmenu = options.blockSubmenu || null;
    this.blockquoteButton = options.blockquoteButton || null;
    this.selectionManager = options.selectionManager || null;
    this.buttonStateManager = options.buttonStateManager || null;
    this.formatBlockCallback = options.formatBlockCallback || null;

    // Flag to prevent double-firing on mobile (when submenu button is clicked)
    this.submenuButtonJustClicked = false;

    // Bind methods
    this.toggleBlockSubmenu = this.toggleBlockSubmenu.bind(this);
    this.openBlockSubmenu = this.openBlockSubmenu.bind(this);
    this.closeBlockSubmenu = this.closeBlockSubmenu.bind(this);
    this.handleClickOutsideSubmenu = this.handleClickOutsideSubmenu.bind(this);
    this.handleBlockTypeSelection = this.handleBlockTypeSelection.bind(this);
    this.handleRemoveBlock = this.handleRemoveBlock.bind(this);
  }

  /**
   * Check if submenu button was just clicked (for mobile event handling)
   */
  wasSubmenuButtonJustClicked() {
    return this.submenuButtonJustClicked;
  }

  /**
   * Toggle the block submenu
   */
  toggleBlockSubmenu() {
    if (!this.blockSubmenu) return;

    const isVisible = !this.blockSubmenu.classList.contains("hidden");

    if (isVisible) {
      this.closeBlockSubmenu();
    } else {
      this.openBlockSubmenu();
    }
  }

  /**
   * Open the block submenu
   */
  openBlockSubmenu() {
    if (!this.blockSubmenu) return;

    // Check if currently in a list or blockquote
    const parentElement = this.selectionManager.getSelectionParentElement();
    const isInList = parentElement && (
      hasParentWithTag(parentElement, "UL") ||
      hasParentWithTag(parentElement, "OL")
    );
    const isInBlockquote = parentElement && hasParentWithTag(parentElement, "BLOCKQUOTE");

    // Show/hide the X (remove) button based on whether we're in a list or blockquote
    const removeBtn = this.blockSubmenu.querySelector("[data-action='remove-block']");
    if (removeBtn) {
      if (isInList || isInBlockquote) {
        removeBtn.classList.add("visible");
      } else {
        removeBtn.classList.remove("visible");
      }
    }

    this.blockSubmenu.classList.remove("hidden");

    // Attach click-outside listener after a small delay to prevent immediate closure
    setTimeout(() => {
      document.addEventListener("click", this.handleClickOutsideSubmenu);
    }, 0);

    // Remove old event listeners before adding new ones
    const typeButtons = this.blockSubmenu.querySelectorAll("[data-block-type]");
    typeButtons.forEach(btn => {
      // Clone and replace to remove all old listeners
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      // Desktop: prevent focus moving to button on mousedown (preserves selection)
      newBtn.addEventListener("mousedown", (e) => { e.preventDefault(); });

      // Add click listener
      newBtn.addEventListener("click", this.handleBlockTypeSelection);

      // Mobile touch handlers
      newBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });

      newBtn.addEventListener("touchend", (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Set flag to prevent blockquote button from firing
        this.submenuButtonJustClicked = true;

        const blockType = e.currentTarget.dataset.blockType;
        this._executeBlockType(blockType);
        this.closeBlockSubmenu();

        // Clear flag after delay
        setTimeout(() => {
          this.submenuButtonJustClicked = false;
        }, 1000);
      }, { passive: false });
    });

    // Attach handlers for remove button (clone to remove all old listeners)
    if (removeBtn) {
      const newRemoveBtn = removeBtn.cloneNode(true);
      removeBtn.parentNode.replaceChild(newRemoveBtn, removeBtn);

      // Desktop: prevent focus moving to button on mousedown (preserves selection)
      newRemoveBtn.addEventListener("mousedown", (e) => { e.preventDefault(); });

      newRemoveBtn.addEventListener("click", this.handleRemoveBlock);

      // Mobile touch handlers for X button
      newRemoveBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });

      newRemoveBtn.addEventListener("touchend", (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Set flag to prevent blockquote button from firing
        this.submenuButtonJustClicked = true;

        this._executeRemove();
        this.closeBlockSubmenu();

        // Clear flag after delay
        setTimeout(() => {
          this.submenuButtonJustClicked = false;
        }, 1000);
      }, { passive: false });
    }
  }

  /**
   * Close the block submenu
   */
  closeBlockSubmenu() {
    if (!this.blockSubmenu) return;

    this.blockSubmenu.classList.add("hidden");
    document.removeEventListener("click", this.handleClickOutsideSubmenu);
  }

  /**
   * Handle clicks outside the submenu to close it
   */
  handleClickOutsideSubmenu(e) {
    const submenu = this.blockSubmenu;
    const triggerBtn = this.blockquoteButton;

    if (!submenu || !triggerBtn) return;

    // Close if click is outside both submenu and blockquote button
    if (!submenu.contains(e.target) && !triggerBtn.contains(e.target)) {
      this.closeBlockSubmenu();
    }
  }

  /**
   * Handle selection of a block type
   */
  handleBlockTypeSelection(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const blockType = e.currentTarget.dataset.blockType;
    this._executeBlockType(blockType);
    this.closeBlockSubmenu();
  }

  /**
   * Handle removing block formatting (convert back to paragraphs)
   */
  handleRemoveBlock(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    this._executeRemove();
    this.closeBlockSubmenu();
  }

  /**
   * Execute the appropriate format action for a block type
   */
  _executeBlockType(blockType) {
    if (!this.formatBlockCallback) return;

    if (blockType === "ul" || blockType === "ol") {
      this.formatBlockCallback("list", blockType);
    } else if (blockType === "blockquote") {
      this.formatBlockCallback("blockquote");
    }
  }

  /**
   * Execute remove — detects whether in list or blockquote and removes accordingly
   */
  _executeRemove() {
    if (!this.formatBlockCallback) return;

    const parentElement = this.selectionManager.getSelectionParentElement();
    const isInList = parentElement && (
      hasParentWithTag(parentElement, "UL") ||
      hasParentWithTag(parentElement, "OL")
    );

    if (isInList) {
      this.formatBlockCallback("remove-list");
    } else {
      // Toggle off blockquote (calling blockquote when already in one removes it)
      this.formatBlockCallback("blockquote");
    }
  }
}
