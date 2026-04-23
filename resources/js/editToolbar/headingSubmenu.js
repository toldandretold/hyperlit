/**
 * Heading Submenu Handler for EditToolbar
 *
 * Manages the heading level dropdown submenu:
 * - Opening/closing the submenu
 * - Handling heading level selection (H1-H6)
 * - Handling "Remove Heading" X button
 * - Click-outside detection for closing
 */

import {
  hasParentWithTag,
  findClosestBlockParent,
  getFirstTextNode,
  setCursorAtTextOffset,
} from "./toolbarDOMUtils.js";

/**
 * HeadingSubmenu class
 * Handles all heading submenu interactions
 */
export class HeadingSubmenu {
  constructor(options = {}) {
    this.headingSubmenu = options.headingSubmenu || null;
    this.headingButton = options.headingButton || null;
    this.selectionManager = options.selectionManager || null;
    this.buttonStateManager = options.buttonStateManager || null;
    this.currentBookId = options.currentBookId || null;
    this.formatBlockCallback = options.formatBlockCallback || null;
    this.saveToIndexedDBCallback = options.saveToIndexedDBCallback || null;

    // Flag to prevent double-firing on mobile (when submenu button is clicked)
    this.submenuButtonJustClicked = false;

    // Bind methods
    this.toggleHeadingSubmenu = this.toggleHeadingSubmenu.bind(this);
    this.openHeadingSubmenu = this.openHeadingSubmenu.bind(this);
    this.closeHeadingSubmenu = this.closeHeadingSubmenu.bind(this);
    this.handleClickOutsideSubmenu = this.handleClickOutsideSubmenu.bind(this);
    this.handleHeadingSelection = this.handleHeadingSelection.bind(this);
    this.handleRemoveHeading = this.handleRemoveHeading.bind(this);
    this.convertHeadingToParagraph = this.convertHeadingToParagraph.bind(this);
  }

  /**
   * Check if submenu button was just clicked (for mobile event handling)
   */
  wasSubmenuButtonJustClicked() {
    return this.submenuButtonJustClicked;
  }

  /**
   * Toggle the heading level submenu
   */
  toggleHeadingSubmenu() {
    if (!this.headingSubmenu) return;

    const isVisible = !this.headingSubmenu.classList.contains("hidden");

    if (isVisible) {
      this.closeHeadingSubmenu();
    } else {
      this.openHeadingSubmenu();
    }
  }

  /**
   * Open the heading level submenu
   */
  openHeadingSubmenu() {
    if (!this.headingSubmenu) return;

    // Check if currently in a heading and STORE the heading element
    const parentElement = this.selectionManager.getSelectionParentElement();
    const isInHeading = parentElement && (
      hasParentWithTag(parentElement, "H1") ||
      hasParentWithTag(parentElement, "H2") ||
      hasParentWithTag(parentElement, "H3") ||
      hasParentWithTag(parentElement, "H4") ||
      hasParentWithTag(parentElement, "H5") ||
      hasParentWithTag(parentElement, "H6")
    );

    // Double-check: Store the heading element reference for Firefox (selection gets lost)
    // This is a backup in case updateButtonStates didn't catch it
    if (isInHeading && parentElement && !this.buttonStateManager.storedHeadingElement) {
      const blockParent = findClosestBlockParent(parentElement);
      if (blockParent && /^H[1-6]$/.test(blockParent.tagName)) {
        this.buttonStateManager.setStoredHeadingElement(blockParent);
      }
    }

    // Show/hide the X (remove) button based on whether we're in a heading
    const removeBtn = this.headingSubmenu.querySelector("[data-action='remove-heading']");
    if (removeBtn) {
      if (isInHeading) {
        removeBtn.classList.add("visible");
      } else {
        removeBtn.classList.remove("visible");
      }
    }

    this.headingSubmenu.classList.remove("hidden");

    // Attach click-outside listener after a small delay to prevent immediate closure
    setTimeout(() => {
      document.addEventListener("click", this.handleClickOutsideSubmenu);
    }, 0);

    // Remove old event listeners before adding new ones
    const levelButtons = this.headingSubmenu.querySelectorAll("[data-heading]");
    levelButtons.forEach(btn => {
      // Clone and replace to remove all old listeners
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      // Desktop: prevent focus moving to button on mousedown (preserves selection)
      newBtn.addEventListener("mousedown", (e) => { e.preventDefault(); });

      // Add click listener
      newBtn.addEventListener("click", this.handleHeadingSelection);

      // Mobile touch handlers
      newBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });

      newBtn.addEventListener("touchend", (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Set flag to prevent heading button from firing
        console.log("🚩 Setting submenuButtonJustClicked to true");
        this.submenuButtonJustClicked = true;
        console.log("🚩 Flag is now:", this.submenuButtonJustClicked);

        const level = e.currentTarget.dataset.heading;
        if (this.formatBlockCallback) {
          this.formatBlockCallback("heading", level);
        }
        this.closeHeadingSubmenu();

        // Clear flag after delay (longer timeout to catch delayed touchend)
        setTimeout(() => {
          console.log("🚩 Clearing submenuButtonJustClicked");
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

      newRemoveBtn.addEventListener("click", this.handleRemoveHeading);

      // Mobile touch handlers for X button
      newRemoveBtn.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, { passive: false });

      newRemoveBtn.addEventListener("touchend", (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Set flag to prevent heading button from firing
        console.log("🚩 [X button] Setting submenuButtonJustClicked to true");
        this.submenuButtonJustClicked = true;
        console.log("🚩 [X button] Flag is now:", this.submenuButtonJustClicked);

        this.convertHeadingToParagraph();
        this.closeHeadingSubmenu();

        // Clear flag after delay (longer timeout to catch delayed touchend)
        setTimeout(() => {
          console.log("🚩 [X button] Clearing submenuButtonJustClicked");
          this.submenuButtonJustClicked = false;
        }, 1000);
      }, { passive: false });
    }
  }

  /**
   * Close the heading level submenu
   */
  closeHeadingSubmenu() {
    if (!this.headingSubmenu) return;

    this.headingSubmenu.classList.add("hidden");
    document.removeEventListener("click", this.handleClickOutsideSubmenu);
    this.buttonStateManager.setStoredHeadingElement(null); // Clear stored element
  }

  /**
   * Handle clicks outside the submenu to close it
   */
  handleClickOutsideSubmenu(e) {
    const submenu = this.headingSubmenu;
    const headingBtn = this.headingButton;

    if (!submenu || !headingBtn) return;

    // Close if click is outside both submenu and heading button
    if (!submenu.contains(e.target) && !headingBtn.contains(e.target)) {
      this.closeHeadingSubmenu();
    }
  }

  /**
   * Handle selection of a heading level
   */
  handleHeadingSelection(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation(); // Firefox compatibility

    const level = e.currentTarget.dataset.heading; // "h1", "h2", "h3", "h4"
    if (this.formatBlockCallback) {
      this.formatBlockCallback("heading", level);
    }
    this.closeHeadingSubmenu();
  }

  /**
   * Handle removing heading (convert to paragraph)
   */
  handleRemoveHeading(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation(); // Firefox compatibility

    // Convert heading to paragraph
    this.convertHeadingToParagraph();
    this.closeHeadingSubmenu();
  }

  /**
   * Convert current heading to paragraph
   */
  async convertHeadingToParagraph() {
    // Use stored heading element (Firefox-safe) instead of current selection
    const blockParent = this.buttonStateManager.getStoredHeadingElement();

    if (!blockParent || !/^H[1-6]$/.test(blockParent.tagName)) {
      console.warn("Not currently in a heading");
      return;
    }

    // Save references for ID reassignment after formatBlock
    const oldId = blockParent.id;
    const oldNodeId = blockParent.getAttribute('data-node-id');
    const prevSib = blockParent.previousElementSibling;
    const nextSib = blockParent.nextElementSibling;

    // Place cursor inside the heading so formatBlock targets it
    const firstTextNode = getFirstTextNode(blockParent);
    if (firstTextNode) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(firstTextNode, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // Use native formatBlock for undoable heading→paragraph conversion
    document.execCommand('formatBlock', false, 'p');

    // Find the new element and reassign id + data-node-id if the browser dropped them
    let newEl = oldId ? document.getElementById(oldId) : null;
    if (!newEl) {
      newEl = prevSib ? prevSib.nextElementSibling
                      : (nextSib ? nextSib.previousElementSibling : null);
    }
    if (newEl) {
      if (oldId && newEl.id !== oldId) newEl.id = oldId;
      if (oldNodeId && !newEl.getAttribute('data-node-id')) {
        newEl.setAttribute('data-node-id', oldNodeId);
      }
    }

    const insertedP = newEl || blockParent;
    setCursorAtTextOffset(insertedP, 0);

    // Update button states after cursor is set
    this.selectionManager.currentSelection = window.getSelection();
    this.buttonStateManager.updateButtonStates();

    // Save to IndexedDB
    if (this.currentBookId && insertedP.id && this.saveToIndexedDBCallback) {
      await this.saveToIndexedDBCallback(insertedP.id, insertedP.outerHTML);
    }
  }

  /**
   * Update the currentBookId (called when book changes)
   */
  setBookId(bookId) {
    this.currentBookId = bookId;
  }
}
