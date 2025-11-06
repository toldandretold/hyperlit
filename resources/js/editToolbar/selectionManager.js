/**
 * Selection Manager for EditToolbar
 *
 * Manages selection tracking, restoration, and mobile selection backup.
 * Handles the complexities of maintaining valid selections across toolbar interactions.
 */

/**
 * SelectionManager class
 * Tracks and manages text selections within editable content
 */
export class SelectionManager {
  constructor(options = {}) {
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
   * @param {Function} updateButtonStatesCallback - Callback to update button states
   */
  handleSelectionChange(updateButtonStatesCallback) {
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
   * @returns {Element|null}
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
   * Restore the last valid selection
   * Used before formatting operations to ensure we have a valid selection
   * @returns {boolean} - True if selection was restored successfully
   */
  restoreSelection() {
    const editableContent = document.querySelector(this.editableSelector);
    if (!editableContent) return false;

    if (
      this.lastValidRange &&
      editableContent.contains(this.lastValidRange.commonAncestorContainer)
    ) {
      try {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(this.lastValidRange.cloneRange());
        this.currentSelection = selection;
        console.log(
          "🔄 Restored valid selection to:",
          this.lastValidRange.commonAncestorContainer
        );
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
   * @param {string} buttonName - Name of button for logging
   */
  storeSelectionForTouch(buttonName) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      this.lastValidRange = selection.getRangeAt(0).cloneRange();
      console.log(
        `📱 ${buttonName} touchstart - stored selection:`,
        this.lastValidRange.toString()
      );
    }
  }

  /**
   * Get the current selection or restore if needed
   * @returns {{selection: Selection|null, range: Range|null}}
   */
  getWorkingSelection() {
    let workingSelection = this.currentSelection;
    let workingRange = null;

    // Try to restore from lastValidRange
    if (this.restoreSelection()) {
      workingSelection = this.currentSelection;
      workingRange = this.lastValidRange.cloneRange();
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
   * @param {boolean} isVisible - Whether the toolbar is visible
   */
  setVisible(isVisible) {
    this.isVisible = isVisible;
  }

  /**
   * Attach the selection change listener
   * @param {Function} updateButtonStatesCallback - Callback to update button states
   */
  attachListener(updateButtonStatesCallback) {
    document.addEventListener("selectionchange", () =>
      this.handleSelectionChange(updateButtonStatesCallback)
    );
  }

  /**
   * Remove the selection change listener
   */
  detachListener() {
    document.removeEventListener("selectionchange", this.handleSelectionChange);
  }
}
