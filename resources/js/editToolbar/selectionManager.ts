/**
 * Selection Manager for EditToolbar
 *
 * Manages selection tracking, restoration, and mobile selection backup.
 * Handles the complexities of maintaining valid selections across toolbar interactions.
 */

import { verbose } from '../utilities/logger.js';

interface SelectionManagerOptions {
  editableSelector?: string;
  isMobile?: boolean;
  isVisible?: boolean;
}

/**
 * SelectionManager class
 * Tracks and manages text selections within editable content
 */
export class SelectionManager {
  editableSelector: string;
  isMobile: boolean;
  isVisible: boolean;
  currentSelection: Selection | null;
  lastValidRange: Range | null;
  // Mobile-specific backup — only assigned when isMobile (left undefined otherwise)
  mobileBackupRange?: Range | null;
  mobileBackupText?: string;
  mobileBackupContainer?: Node | null;

  constructor(options: SelectionManagerOptions = {}) {
    this.editableSelector = options.editableSelector || ".main-content[contenteditable='true']";
    this.isMobile = options.isMobile || false;
    this.isVisible = options.isVisible || false;

    // Selection state
    this.currentSelection = null;
    this.lastValidRange = null;

    // Mobile-specific backup
    if (this.isMobile) {
      this.mobileBackupRange = null;
      this.mobileBackupText = "";
      this.mobileBackupContainer = null;
    }

    // Bind event handler
    this.handleSelectionChange = this.handleSelectionChange.bind(this);
  }

  /**
   * Handle selection changes within the document (only for button states and positioning)
   * This is called by the document's selectionchange event
   */
  handleSelectionChange(updateButtonStatesCallback?: () => void): void {
    const selection = window.getSelection();
    verbose.content(`Selection change detected: hasSelection=${!!selection}, rangeCount=${selection?.rangeCount}, isCollapsed=${selection?.isCollapsed}, toolbarVisible=${this.isVisible}`, 'editToolbar/selectionManager.js');

    if (!selection || selection.rangeCount === 0) return;

    // Only update button states and position if toolbar is visible
    if (this.isVisible) {
      const editableContent = document.querySelector(this.editableSelector);
      if (editableContent) {
        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;

        verbose.content(`Selection container: id=${(container as Element).id || container.parentElement?.id}, isInEditable=${editableContent.contains(container)}`, 'editToolbar/selectionManager.js');

        // Check if selection is coming from toolbar button click
        const isFromToolbar = (container as Element).closest && (container as Element).closest('#edit-toolbar');
        if (isFromToolbar) {
          verbose.content("Selection change from toolbar button - ignoring to preserve selection", 'editToolbar/selectionManager.js');
          return; // Don't update anything if selection changed due to toolbar button click
        }

        // Store selection if it's within the main editable content OR a sub-book element
        const containerEl = container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element);
        const inSubBook = !!containerEl?.closest('[data-book-id][contenteditable="true"]');
        if (editableContent.contains(container) || inSubBook) {
          // STORE THE VALID SELECTION
          this.currentSelection = selection;
          this.lastValidRange = range.cloneRange();

          // On mobile, also store additional backup info
          if (this.isMobile) {
            this.mobileBackupRange = range.cloneRange();
            this.mobileBackupText = selection.toString();
            this.mobileBackupContainer = container;
            verbose.content(`Mobile backup stored: text="${this.mobileBackupText}"`, 'editToolbar/selectionManager.js');
          }

          // Call the button state update callback
          if (updateButtonStatesCallback) {
            updateButtonStatesCallback();
          }
        }
      }
    }
  }

  /**
   * Get the parent element of the current selection
   */
  getSelectionParentElement(): Element | null {
    if (!this.currentSelection) return null;

    let parent: Node | null = null;
    if (this.currentSelection.rangeCount > 0) {
      parent = this.currentSelection.getRangeAt(0).commonAncestorContainer;

      // If the parent is a text node, get its parent element
      if (parent.nodeType === 3) {
        parent = parent.parentNode;
      }
    }

    return parent as Element | null;
  }

  /**
   * Restore the last valid selection
   * Used before formatting operations to ensure we have a valid selection
   * @returns True if selection was restored successfully
   */
  restoreSelection(): boolean {
    const editableContent = document.querySelector(this.editableSelector);
    if (!editableContent) return false;

    const rangeContainer = this.lastValidRange?.commonAncestorContainer;
    const rangeContainerEl = rangeContainer?.nodeType === Node.TEXT_NODE ? rangeContainer.parentElement : (rangeContainer as Element | undefined);
    const rangeInSubBook = !!rangeContainerEl?.closest('[data-book-id][contenteditable="true"]');
    if (
      this.lastValidRange &&
      (editableContent?.contains(rangeContainer ?? null) || rangeInSubBook)
    ) {
      try {
        const selection = window.getSelection();
        if (!selection) return false;
        selection.removeAllRanges();
        selection.addRange(this.lastValidRange.cloneRange());
        this.currentSelection = selection;
        verbose.content(`Restored valid selection to: ${this.lastValidRange.commonAncestorContainer}`, 'editToolbar/selectionManager.js');
        return true;
      } catch (e) {
        console.warn("Failed to restore lastValidRange:", e);
        return false;
      }
    }

    return false;
  }

  /**
   * Store the current selection for later restoration
   * Called during touchstart on mobile to preserve selection before button click
   */
  storeSelectionForTouch(buttonName: string): void {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      this.lastValidRange = selection.getRangeAt(0).cloneRange();
      verbose.content(`${buttonName} touchstart - stored selection: "${this.lastValidRange.toString()}"`, 'editToolbar/selectionManager.js');
    }
  }

  /**
   * Get the current selection or restore if needed
   */
  getWorkingSelection(): { selection: Selection | null; range: Range | null } {
    let workingSelection: Selection | null = this.currentSelection;
    let workingRange: Range | null = null;

    // Try to restore from lastValidRange
    if (this.restoreSelection()) {
      workingSelection = this.currentSelection;
      workingRange = this.lastValidRange?.cloneRange() ?? null;
    }

    // Fallback to current window selection
    if (!workingSelection || !workingRange) {
      workingSelection = window.getSelection();
      if (workingSelection && workingSelection.rangeCount > 0) {
        workingRange = workingSelection.getRangeAt(0);
      }
    }

    return { selection: workingSelection, range: workingRange };
  }

  /**
   * Set visibility state (affects whether selection changes are processed)
   */
  setVisible(isVisible: boolean): void {
    this.isVisible = isVisible;
  }

  /**
   * Attach the selection change listener
   */
  attachListener(updateButtonStatesCallback?: () => void): void {
    document.addEventListener("selectionchange", () =>
      this.handleSelectionChange(updateButtonStatesCallback)
    );
  }

  /**
   * Remove the selection change listener
   */
  detachListener(): void {
    document.removeEventListener("selectionchange", this.handleSelectionChange as unknown as EventListener);
  }
}
