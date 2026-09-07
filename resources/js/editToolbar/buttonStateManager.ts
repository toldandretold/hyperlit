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
} from "./toolbarDOMUtils";
import { isContentLink } from "../utilities/contentLink";

/**
 * ButtonStateManager class
 * Handles updating button states based on selection context
 */
export class ButtonStateManager {
  boldButton: HTMLButtonElement | null;
  italicButton: HTMLButtonElement | null;
  headingButton: HTMLButtonElement | null;
  blockquoteButton: HTMLButtonElement | null;
  citationButton: HTMLButtonElement | null;
  footnoteButton: HTMLButtonElement | null;
  linkButton: HTMLButtonElement | null;
  headingSubmenu: HTMLElement | null;
  blockSubmenu: HTMLElement | null;
  selectionManager: any;
  storedHeadingElement: any = null;

  constructor(options: any = {}) {
    // Button references
    this.boldButton = options.boldButton || null;
    this.italicButton = options.italicButton || null;
    this.headingButton = options.headingButton || null;
    this.blockquoteButton = options.blockquoteButton || null;
    this.citationButton = options.citationButton || null;
    this.footnoteButton = options.footnoteButton || null;
    this.linkButton = options.linkButton || null;

    // Submenu references (option buttons are queried FRESH each update —
    // BlockSubmenu clones-and-replaces its options on every open, so a
    // stored reference would go stale)
    this.headingSubmenu = options.headingSubmenu || null;
    this.blockSubmenu = options.blockSubmenu || null;

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
        this.headingSubmenu.querySelectorAll("[data-heading]").forEach((btn: any) => {
          btn.classList.toggle("active", btn.dataset.heading === activeLevel);
        });
      }
    }

    // The caret's current block type — drives the block-picker trigger icon
    // (data-block-type swaps the visible indicator svg) and the submenu's
    // active option. List wins over blockquote (a list inside a blockquote
    // converts back via remove-list, matching _convertToParagraph's order).
    // A block outside the picker's vocabulary (heading etc.) is 'other'.
    const isInCode = hasParentWithTag(parentElement, "CODE") ||
                     hasParentWithTag(parentElement, "PRE");
    const blockParentEl = findClosestBlockParent(parentElement);
    let currentBlockType =
      isInCode ? "code" :
      hasParentWithTag(parentElement, "UL") ? "ul" :
      hasParentWithTag(parentElement, "OL") ? "ol" :
      hasParentWithTag(parentElement, "BLOCKQUOTE") ? "blockquote" : "p";
    if (currentBlockType === "p" && blockParentEl && blockParentEl.tagName !== "P") {
      currentBlockType = "other"; // heading etc. — not the picker's business
    }

    // Which conversions blockFormatter actually implements FROM each type.
    // Lists swap in place (handleListFormat) and flatten to blockquote/code
    // (handleListToBlock); a blockquote splits into a list on <br>; code can
    // only unwrap to a paragraph or re-wrap as a blockquote. Options outside
    // this matrix are disabled — an enabled-but-no-op option reads as broken.
    const SUPPORTED_TARGETS: Record<string, string[]> = {
      p: ["ul", "ol", "blockquote", "code"],
      ul: ["p", "ol", "blockquote", "code"],
      ol: ["p", "ul", "blockquote", "code"],
      blockquote: ["p", "ul", "ol", "code"],
      code: ["p", "blockquote"],
      other: [],
    };
    const supported = SUPPORTED_TARGETS[currentBlockType] ?? [];

    // A selection spanning MULTIPLE blocks only converts when they're all
    // paragraphs (the merge paths) — mixed multi-block selections disable the
    // picker. A selection inside ONE block converts like a cursor would.
    let multiBlockMixed = false;
    if (isTextSelected && this.selectionManager.currentSelection.rangeCount > 0) {
      const selectedBlocks = getBlockElementsInRange(this.selectionManager.currentSelection.getRangeAt(0));
      multiBlockMixed = selectedBlocks.length > 1 && !selectedBlocks.every((b: Element) => b.tagName === "P");
    }

    // Update block-picker trigger: indicator icon; reads as SELECTED whenever
    // it shows a real type (it reflects current state, not a pending action).
    if (this.blockquoteButton) {
      this.blockquoteButton.dataset.blockType = currentBlockType === "other" ? "p" : currentBlockType;
      const usable = currentBlockType !== "other" && !multiBlockMixed;
      this.blockquoteButton.classList.toggle("active", usable);
      this.blockquoteButton.classList.toggle("disabled", !usable);
      this.blockquoteButton.disabled = !usable;
    }

    // Update the submenu OPTIONS (queried fresh — see ctor note): the current
    // type is .active; the rest enable per the conversion matrix.
    if (this.blockSubmenu) {
      this.blockSubmenu.querySelectorAll<HTMLButtonElement>('[data-block-type]').forEach((option) => {
        const type = option.dataset.blockType ?? "";
        const isCurrent = type === currentBlockType;
        option.classList.toggle("active", isCurrent);
        const shouldDisable = !isCurrent && (multiBlockMixed || !supported.includes(type));
        option.classList.toggle("disabled", shouldDisable);
        option.disabled = shouldDisable;
      });
    }

    // Update footnote button state
    if (this.footnoteButton) {
      this.footnoteButton.classList.toggle("disabled", isTextSelected);
      this.footnoteButton.disabled = isTextSelected;
    }

    // Update citation button state
    if (this.citationButton) {
      // Check if we have a valid range in editable content
      const hasValidRange = this.selectionManager.lastValidRange &&
        this.selectionManager.lastValidRange.commonAncestorContainer;

      // Verify the range is still in the document and in editable content
      const editableContent = document.querySelector(this.selectionManager.editableSelector);
      const rangeContainer = this.selectionManager.lastValidRange?.commonAncestorContainer;
      const rangeContainerEl = rangeContainer?.nodeType === Node.TEXT_NODE
        ? rangeContainer.parentElement : rangeContainer;
      const inSubBook = !!rangeContainerEl?.closest('[data-book-id][contenteditable="true"]');
      const isRangeValid = hasValidRange &&
        (editableContent?.contains(rangeContainer) || inSubBook);

      // Disable if no valid range in editable content or text is selected
      const shouldDisable = !isRangeValid || isTextSelected;
      this.citationButton.classList.toggle("disabled", shouldDisable);
      this.citationButton.disabled = shouldDisable;
    }

    // Update link button state — the inverse of footnote/citation: it needs a
    // SELECTION to wrap. Exception: a collapsed caret inside an existing user
    // link (isContentLink) enables it for edit/remove. Multi-block selections
    // are disabled (the wrap must stay inside one node for undo/save).
    if (this.linkButton) {
      let enabled = false;
      if (isTextSelected && this.selectionManager.currentSelection.rangeCount > 0) {
        const range = this.selectionManager.currentSelection.getRangeAt(0);
        enabled = getBlockElementsInRange(range).length <= 1;
      } else {
        const anchor = parentElement?.closest?.("a") ?? null;
        enabled = !!anchor && isContentLink(anchor);
      }
      this.linkButton.classList.toggle("disabled", !enabled);
      this.linkButton.disabled = !enabled;
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
  setStoredHeadingElement(element: any) {
    this.storedHeadingElement = element;
  }
}
