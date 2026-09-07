/**
 * Block Submenu Handler for EditToolbar
 *
 * Manages the block-type picker submenu (paragraph, bullet list, numbered
 * list, blockquote, code):
 * - Opening/closing the submenu
 * - Handling block type selection (the P option converts back to paragraph —
 *   it replaced the old "Remove" ✕, whose toggle semantics turned a plain
 *   paragraph INTO a blockquote)
 * - Click-outside detection for closing
 */

import {
  hasParentWithTag,
} from "./toolbarDOMUtils";

/**
 * BlockSubmenu class
 * Handles all block format submenu interactions
 */
export class BlockSubmenu {
  blockSubmenu: HTMLElement | null;
  blockquoteButton: HTMLElement | null;
  selectionManager: any;
  buttonStateManager: any;
  formatBlockCallback: any;
  submenuButtonJustClicked: boolean = false;

  constructor(options: any = {}) {
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
    this._convertToParagraph = this._convertToParagraph.bind(this);
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

    // Refresh option active/disabled states so the menu opens showing the truth
    this.buttonStateManager?.updateButtonStates?.();

    this.blockSubmenu.classList.remove("hidden");
    this.blockquoteButton?.classList.add("menu-open");

    // Attach click-outside listener after a small delay to prevent immediate closure
    setTimeout(() => {
      document.addEventListener("click", this.handleClickOutsideSubmenu);
    }, 0);

    // Remove old event listeners before adding new ones
    const typeButtons = this.blockSubmenu.querySelectorAll("[data-block-type]");
    typeButtons.forEach((btn: any) => {
      // Clone and replace to remove all old listeners
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      // Desktop: prevent focus moving to button on mousedown (preserves selection)
      newBtn.addEventListener("mousedown", (e: any) => { e.preventDefault(); });

      // Add click listener
      newBtn.addEventListener("click", this.handleBlockTypeSelection);

      // Mobile touch handlers
      newBtn.addEventListener("touchstart", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });

      newBtn.addEventListener("touchend", (e: any) => {
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

  }

  /**
   * Close the block submenu
   */
  closeBlockSubmenu() {
    if (!this.blockSubmenu) return;

    this.blockSubmenu.classList.add("hidden");
    this.blockquoteButton?.classList.remove("menu-open");
    document.removeEventListener("click", this.handleClickOutsideSubmenu);
  }

  /**
   * Handle clicks outside the submenu to close it
   */
  handleClickOutsideSubmenu(e: any) {
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
  handleBlockTypeSelection(e: any) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const blockType = e.currentTarget.dataset.blockType;
    this._executeBlockType(blockType);
    this.closeBlockSubmenu();
  }

  /**
   * Execute the appropriate format action for a block type
   */
  _executeBlockType(blockType: any) {
    if (!this.formatBlockCallback) return;

    if (blockType === "ul" || blockType === "ol") {
      this.formatBlockCallback("list", blockType);
    } else if (blockType === "blockquote") {
      this.formatBlockCallback("blockquote");
    } else if (blockType === "code") {
      this.formatBlockCallback("code");
    } else if (blockType === "p") {
      this._convertToParagraph();
    }
  }

  /**
   * The P option: convert the current block back to a paragraph. The format
   * callbacks are TOGGLES, so this must dispatch by the CURRENT type — and
   * do nothing when already a paragraph (toggling blockquote from a paragraph
   * is exactly the old ✕ bug that WRAPPED it instead).
   */
  _convertToParagraph() {
    if (!this.formatBlockCallback) return;

    const parentElement = this.selectionManager.getSelectionParentElement();
    const isInList = parentElement && (
      hasParentWithTag(parentElement, "UL") ||
      hasParentWithTag(parentElement, "OL")
    );
    const isInCode = parentElement && hasParentWithTag(parentElement, "PRE");
    const isInBlockquote = parentElement && hasParentWithTag(parentElement, "BLOCKQUOTE");

    if (isInList) {
      this.formatBlockCallback("remove-list");
    } else if (isInCode) {
      // Toggle off code (calling code when already in a PRE removes it)
      this.formatBlockCallback("code");
    } else if (isInBlockquote) {
      // Toggle off blockquote (calling blockquote when already in one removes it)
      this.formatBlockCallback("blockquote");
    }
    // Already a paragraph → nothing to do.
  }
}
