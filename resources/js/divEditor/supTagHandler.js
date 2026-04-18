/**
 * SupTagHandler Module
 *
 * Handles behavior around <sup> elements (footnotes and hypercites) in the contenteditable editor.
 * - Prevents typing inside sup elements (supEscapeHandler)
 * - Handles delete/backspace with confirmation dialogs (supDeleteHandler)
 * - Arrow key navigation to skip over hypercite anchors (hyperciteArrowHandler)
 */

import { queueNodeForSave, queueNodeForDeletion } from './index.js';
import { queueForSync } from '../indexedDB/syncQueue/queue.js';

export class SupTagHandler {
  constructor(editableDiv) {
    this.editableDiv = editableDiv;
    this.supEscapeHandler = null;
    this.supDeleteHandler = null;
    this.hyperciteArrowHandler = null;
  }

  /**
   * Attach all sup tag related event listeners
   */
  startListening() {
    this._attachEscapeHandler();
    this._attachDeleteHandler();
    this._attachArrowHandler();
  }

  /**
   * Remove all sup tag related event listeners
   */
  stopListening() {
    if (this.supEscapeHandler) {
      this.editableDiv.removeEventListener('beforeinput', this.supEscapeHandler, { capture: true });
      this.supEscapeHandler = null;
    }
    if (this.supDeleteHandler) {
      this.editableDiv.removeEventListener('beforeinput', this.supDeleteHandler, { capture: true });
      this.supDeleteHandler = null;
    }
    if (this.hyperciteArrowHandler) {
      this.editableDiv.removeEventListener('keydown', this.hyperciteArrowHandler, { capture: true });
      this.hyperciteArrowHandler = null;
    }
  }

  /**
   * Prevent typing inside sup elements (footnote numbers, hypercite arrows)
   * Sup tags contain generated content that should never be user-editable
   */
  _attachEscapeHandler() {
    if (this.supEscapeHandler) {
      this.editableDiv.removeEventListener('beforeinput', this.supEscapeHandler, { capture: true });
    }

    this.supEscapeHandler = (e) => {
      if (!window.isEditing) return;

      // Only handle text insertion events
      if (!e.inputType || !e.inputType.startsWith('insert')) return;

      // Don't intercept Enter/line break - let enterKeyHandler.js handle these
      if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') return;

      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;

      // Use anchorNode which is more reliable for cursor position
      let node = selection.anchorNode;
      if (!node) return;

      // Get the element (if text node, get parent)
      let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!element) return;

      // Check if we're inside a <sup> tag
      let supElement = element.closest('sup');

      // Also check if we're inside a hypercite <a> tag
      // Structure: <a href="...#hypercite_xxx" class="open-icon">↗</a>
      let hyperciteAnchor = element.closest('a[href*="#hypercite_"]');

      // Also check if cursor is at parent level right before/after a hypercite anchor
      // This catches cases where cursor is at <p> level at offset right next to anchor
      const offset = selection.anchorOffset;
      let cursorBeforeAnchor = false; // Track if cursor is before the anchor (for insertion)
      let cursorAfterAnchor = false;  // Track if cursor is after the anchor
      let cursorBeforeFootnoteSup = false; // Track if cursor is before a footnote sup
      let cursorAfterFootnoteSup = false;  // Track if cursor is after a footnote sup

      // Check for cursor adjacent to footnote sup (has fn-count-id attribute)
      if (!supElement) {
        // Check if at end of text node and next sibling is a footnote sup
        // Also handles empty text nodes (where offset 0 === length 0)
        if (node.nodeType === Node.TEXT_NODE && offset >= node.textContent.length) {
          let nextSib = node.nextSibling;
          // Skip empty text nodes
          while (nextSib && nextSib.nodeType === Node.TEXT_NODE && nextSib.textContent === '') {
            nextSib = nextSib.nextSibling;
          }
          if (nextSib?.tagName === 'SUP' && nextSib.hasAttribute('fn-count-id')) {
            supElement = nextSib;
            cursorBeforeFootnoteSup = true;
          }
        }
        // Also check: cursor at ANY position in a text node where next sibling is footnote sup
        // and there's no visible text after cursor position (cursor is effectively "at end")
        if (!supElement && node.nodeType === Node.TEXT_NODE) {
          const textAfterCursor = node.textContent.substring(offset);
          if (textAfterCursor.trim() === '') {
            let nextSib = node.nextSibling;
            while (nextSib && nextSib.nodeType === Node.TEXT_NODE && nextSib.textContent.trim() === '') {
              nextSib = nextSib.nextSibling;
            }
            if (nextSib?.tagName === 'SUP' && nextSib.hasAttribute('fn-count-id')) {
              supElement = nextSib;
              cursorBeforeFootnoteSup = true;
            }
          }
        }
        // Check if at start of text node and previous sibling is a footnote sup
        if (!supElement && node.nodeType === Node.TEXT_NODE && offset === 0) {
          let prevSib = node.previousSibling;
          while (prevSib && prevSib.nodeType === Node.TEXT_NODE && prevSib.textContent === '') {
            prevSib = prevSib.previousSibling;
          }
          if (prevSib?.tagName === 'SUP' && prevSib.hasAttribute('fn-count-id')) {
            supElement = prevSib;
            cursorAfterFootnoteSup = true;
          }
        }
        // Check if cursor is at parent element level
        if (!supElement && node.nodeType === Node.ELEMENT_NODE) {
          // Check if next child (or next after skipping BR/empty) is a footnote sup
          let nextChild = node.childNodes[offset];
          // Skip BR and empty text nodes to find actual content
          while (nextChild && (nextChild.nodeName === 'BR' ||
                 (nextChild.nodeType === Node.TEXT_NODE && nextChild.textContent.trim() === ''))) {
            nextChild = nextChild.nextSibling;
          }
          if (nextChild?.tagName === 'SUP' && nextChild.hasAttribute('fn-count-id')) {
            supElement = nextChild;
            cursorBeforeFootnoteSup = true;
          }
          // Check if previous child is a footnote sup (cursor right after it)
          if (!supElement && offset > 0) {
            let prevChild = node.childNodes[offset - 1];
            // Skip BR and empty text nodes
            while (prevChild && (prevChild.nodeName === 'BR' ||
                   (prevChild.nodeType === Node.TEXT_NODE && prevChild.textContent.trim() === ''))) {
              prevChild = prevChild.previousSibling;
            }
            if (prevChild?.tagName === 'SUP' && prevChild.hasAttribute('fn-count-id')) {
              supElement = prevChild;
              cursorAfterFootnoteSup = true;
            }
          }
        }
      }

      if (!hyperciteAnchor && node.nodeType === Node.ELEMENT_NODE) {
        // Check if next child is a hypercite anchor (cursor right before it)
        const nextChild = node.childNodes[offset];
        if (nextChild?.tagName === 'A' && nextChild.href?.includes('#hypercite_')) {
          hyperciteAnchor = nextChild;
          cursorBeforeAnchor = true;
        }
        // Check if previous child is a hypercite anchor (cursor right after it)
        if (!hyperciteAnchor && offset > 0) {
          const prevChild = node.childNodes[offset - 1];
          if (prevChild?.tagName === 'A' && prevChild.href?.includes('#hypercite_')) {
            hyperciteAnchor = prevChild;
            cursorAfterAnchor = true;
          }
        }
      }

      // If not inside a sup AND not inside/adjacent to a hypercite anchor, nothing to do
      if (!supElement && !hyperciteAnchor) return;

      // We're inside a sup or hypercite anchor - move cursor outside before the input happens
      e.preventDefault();
      e.stopPropagation();

      // Determine insertion point based on context
      let insertBefore = false; // false = insert after, true = insert before
      let insertionReference; // The element to insert relative to

      if (supElement) {
        // Use flags if cursor was adjacent to footnote sup (detected at parent/sibling level)
        if (cursorBeforeFootnoteSup) {
          insertBefore = true;
        } else if (cursorAfterFootnoteSup) {
          insertBefore = false;
        } else {
          // Cursor is inside the sup - determine if at beginning or end
          // For footnote sups, check if cursor is before the actual number content
          if (supElement.hasAttribute('fn-count-id')) {
            // Get the sup's text content and check cursor position relative to it
            const supText = supElement.textContent || '';
            if (node === supElement) {
              // Cursor is at element level - check if before first child
              insertBefore = offset === 0;
            } else if (supElement.contains(node)) {
              // Cursor is in a text node inside the sup
              // Check if cursor is at or before the start of visible content
              const range = document.createRange();
              range.setStart(supElement, 0);
              range.setEnd(node, offset);
              const textBefore = range.toString();
              // If no visible text before cursor, we're at the "start"
              insertBefore = textBefore.trim() === '' || textBefore.length === 0;
            } else {
              insertBefore = offset === 0;
            }
          } else {
            // Non-footnote sup - use simple offset check
            insertBefore = offset === 0;
          }
        }

          insertionReference = supElement;
      } else if (hyperciteAnchor) {
        // Hypercite anchor found - determine if inserting before or after
        if (cursorBeforeAnchor) {
          insertBefore = true;
        } else if (cursorAfterAnchor) {
          insertBefore = false;
        } else {
          insertBefore = offset === 0;
        }

        insertionReference = hyperciteAnchor;
      }

      let textToInsert = e.data || '';
      // Convert regular space to non-breaking space to prevent browser from collapsing it
      if (textToInsert === ' ') {
        textToInsert = '\u00A0'; // non-breaking space
      }

      // Create text node
      const textNode = document.createTextNode(textToInsert);

      // Insert text outside the appropriate element
      if (insertBefore) {
        insertionReference.parentNode.insertBefore(textNode, insertionReference);
      } else {
        insertionReference.parentNode.insertBefore(textNode, insertionReference.nextSibling);
      }

      // Position cursor at the end of the inserted text node
      const newRange = document.createRange();
      newRange.setStart(textNode, textNode.length);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    };

    // Use capture phase to intercept before other handlers
    this.editableDiv.addEventListener('beforeinput', this.supEscapeHandler, { capture: true });
  }

  /**
   * Handle Delete/Backspace at sup boundaries
   * DELETE at position 0 → escape cursor before sup, then delete
   * Backspace at end → confirm footnote/hypercite deletion
   */
  _attachDeleteHandler() {
    if (this.supDeleteHandler) {
      this.editableDiv.removeEventListener('beforeinput', this.supDeleteHandler, { capture: true });
    }

    this.supDeleteHandler = (e) => {
      if (!window.isEditing) return;

      // Only handle delete operations
      if (e.inputType !== 'deleteContentForward' && e.inputType !== 'deleteContentBackward') return;

      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;

      if (!selection.isCollapsed) return; // Let selection deletions work normally

      let node = selection.anchorNode;
      if (!node) return;

      let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const offset = selection.anchorOffset;
      const textLength = node.textContent?.length || 0;

      // ✅ CHECK: Source hypercite <u> wrapper — confirm before deleting last character
      // The <u> tag is removed by the browser when its last character is deleted.
      // We intercept that moment to show a confirmation dialog if citedIN has entries.
      const sourceHypercite = element?.closest('u[id^="hypercite_"]');
      if (sourceHypercite) {
        const uTextLength = sourceHypercite.textContent?.length || 0;
        const isDeletingLastChar =
          (e.inputType === 'deleteContentBackward' && uTextLength === 1) ||
          (e.inputType === 'deleteContentForward' && uTextLength === 1);

        if (isDeletingLastChar) {
          // Async check — prevent default first, then decide
          e.preventDefault();
          e.stopPropagation();

          const hyperciteId = sourceHypercite.id;

          (async () => {
            try {
              const { openDatabase } = await import('../indexedDB/index.js');
              const { getHyperciteById } = await import('../hypercites/database.js');
              const db = await openDatabase();
              const hypercite = await getHyperciteById(db, hyperciteId);

              const citedINCount = (hypercite?.citedIN?.length) || 0;

              if (citedINCount > 0) {
                const confirmed = confirm(
                  `This text is cited in ${citedINCount} other book(s). Delete anyway?`
                );
                if (!confirmed) {
                  // Restore cursor position
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  const range = document.createRange();
                  if (sourceHypercite.parentNode) {
                    range.selectNodeContents(sourceHypercite);
                    range.collapse(false);
                    sel.addRange(range);
                  }
                  return;
                }
              }

              // User confirmed (or no citations) — delete the <u> content
              // Capture parent reference before removal (can't traverse after detach)
              const parentWithId = sourceHypercite.closest('p, h1, h2, h3, h4, h5, h6, div, blockquote');

              // This triggers MutationObserver Check 2 in domUtilities.js
              // which will create a tombstone if citedIN has entries.
              sourceHypercite.textContent = '';
              sourceHypercite.remove();

              // Queue parent for update
              if (parentWithId?.id) {
                queueNodeForSave(parentWithId.id, 'update');
              }
            } catch (error) {
              console.error('❌ Error checking hypercite citations:', error);
            }
          })();

          return;
        }
        // If not deleting last char, allow normal editing within <u>
      }

      let supElement = element?.closest('sup');

      // Check if cursor is INSIDE a hypercite anchor (new single-element format)
      // This catches both forward delete and backspace when cursor is within <a class="open-icon">↗</a>
      if (!supElement) {
        const insideHypercite = element?.closest('a[href*="#hypercite_"]');
        if (insideHypercite) {
          supElement = insideHypercite;
        }
      }

      // Also check if cursor is RIGHT BEFORE a sup or hypercite anchor
      if (!supElement && offset === 0) {
        // Check if we're in an empty text node before a sup or hypercite anchor
        if (node.nodeType === Node.TEXT_NODE && node.textContent === '') {
          const nextSib = node.nextSibling;
          if (nextSib && nextSib.nodeName === 'SUP') {
            supElement = nextSib;
          }
        }
        // Check if cursor is at position 0 of parent element and first real child is sup or hypercite
        if (!supElement && node.nodeType === Node.ELEMENT_NODE) {
          let firstChild = node.firstChild;
          // Skip empty text nodes and BR
          while (firstChild && ((firstChild.nodeType === Node.TEXT_NODE && firstChild.textContent === '') || firstChild.nodeName === 'BR')) {
            firstChild = firstChild.nextSibling;
          }
          if (firstChild && firstChild.nodeName === 'SUP') {
            supElement = firstChild;
          }
        }
      }

      // Also check if cursor is immediately BEFORE a hypercite anchor or footnote sup (for forward delete)
      let cursorBeforeHyperciteAnchor = false;
      let cursorBeforeFootnoteSup = false;
      if (!supElement && e.inputType === 'deleteContentForward') {
        let hyperciteAnchor = null;
        let footnoteSup = null;

        // Check if at end of text node and next sibling is hypercite anchor or footnote sup
        if (node.nodeType === Node.TEXT_NODE && offset === node.textContent.length) {
          let nextSib = node.nextSibling;
          // Skip empty/whitespace-only text nodes
          while (nextSib && nextSib.nodeType === Node.TEXT_NODE && nextSib.textContent.trim() === '') {
            nextSib = nextSib.nextSibling;
          }
          if (nextSib?.tagName === 'A' && nextSib.href?.includes('#hypercite_')) {
            hyperciteAnchor = nextSib;
          } else if (nextSib?.tagName === 'SUP' && nextSib.hasAttribute('fn-count-id')) {
            footnoteSup = nextSib;
          }
        }

        // Check if cursor is at offset in parent and next child is hypercite anchor or footnote sup
        if (!hyperciteAnchor && !footnoteSup && node.nodeType === Node.ELEMENT_NODE) {
          let nextChild = node.childNodes[offset];
          // Skip empty/whitespace text nodes
          while (nextChild && nextChild.nodeType === Node.TEXT_NODE && nextChild.textContent.trim() === '') {
            nextChild = nextChild.nextSibling;
          }
          if (nextChild?.tagName === 'A' && nextChild.href?.includes('#hypercite_')) {
            hyperciteAnchor = nextChild;
          } else if (nextChild?.tagName === 'SUP' && nextChild.hasAttribute('fn-count-id')) {
            footnoteSup = nextChild;
          }
        }

        if (hyperciteAnchor) {
          // Hypercite anchor IS the open-icon element now (no inner sup)
          // Set supElement to the anchor itself so deletion logic triggers
          supElement = hyperciteAnchor;
          cursorBeforeHyperciteAnchor = true;
        } else if (footnoteSup) {
          supElement = footnoteSup;
          cursorBeforeFootnoteSup = true;
        }
      }

      // Also check if cursor is INSIDE or immediately AFTER hypercite anchor (for backspace)
      // Structure: <a><sup>↗</sup></a>| where | is cursor (outside anchor)
      // Or: <a><sup>↗</sup>|</a> where | is cursor (inside anchor)
      let cursorAfterSupInAnchor = false;
      if (!supElement && e.inputType === 'deleteContentBackward') {
        let hyperciteAnchor = element?.closest('a[href*="#hypercite_"]');

        // Also check if cursor is immediately AFTER a hypercite anchor
        if (!hyperciteAnchor) {
          // Check previous sibling
          if (node.nodeType === Node.TEXT_NODE && offset === 0) {
            let prevNode = node.previousSibling;
            while (prevNode && prevNode.nodeType === Node.TEXT_NODE && prevNode.textContent === '') {
              prevNode = prevNode.previousSibling;
            }
            if (prevNode?.tagName === 'A' && prevNode.href?.includes('#hypercite_')) {
              hyperciteAnchor = prevNode;
            }
          }
          // Check if cursor is at offset in parent and previous child is hypercite
          if (!hyperciteAnchor && node.nodeType === Node.ELEMENT_NODE && offset > 0) {
            const prevChild = node.childNodes[offset - 1];
            if (prevChild?.tagName === 'A' && prevChild.href?.includes('#hypercite_')) {
              hyperciteAnchor = prevChild;
            }
          }
        }

        if (hyperciteAnchor) {
          // Hypercite anchor IS the open-icon element now (no inner sup)
          // Distinguish cursor at START (escape left) vs END/AFTER (deletion confirmation)
          let cursorIsAfterAnchor = false;

          if (node === hyperciteAnchor) {
            // Cursor is directly in anchor element at child-node offset
            // offset 0 = before content (escape left), offset > 0 = after content (delete)
            cursorIsAfterAnchor = offset > 0;
          } else if (hyperciteAnchor.parentNode === node) {
            // Cursor is in parent element (P) at an offset position
            const anchorIndex = Array.from(node.childNodes).indexOf(hyperciteAnchor);
            cursorIsAfterAnchor = offset > anchorIndex;
          } else if (hyperciteAnchor.contains(node)) {
            // Cursor is in a text node inside the anchor
            // offset 0 = at start of text (escape left), otherwise = at/after content (delete)
            cursorIsAfterAnchor = offset > 0;
          } else {
            // Cursor is in some other node - check document position
            const position = hyperciteAnchor.compareDocumentPosition(node);
            cursorIsAfterAnchor = (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
          }

          if (cursorIsAfterAnchor) {
            supElement = hyperciteAnchor;
            cursorAfterSupInAnchor = true;
          } else {
            // Cursor is BEFORE anchor - escape to left and delete outside anchor
            e.preventDefault();
            e.stopPropagation();

            const anchorRef = hyperciteAnchor; // Capture reference

            // Position cursor at end of previous text node
            let prevNode = hyperciteAnchor.previousSibling;
            const range = document.createRange();
            if (prevNode && prevNode.nodeType === Node.TEXT_NODE && prevNode.textContent.length > 0) {
              range.setStart(prevNode, prevNode.textContent.length);
            } else {
              range.setStartBefore(hyperciteAnchor);
            }
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);

            // Execute the delete immediately
            document.execCommand('delete', false, null);

            // After DOM settles, position cursor at end of text before anchor
            requestAnimationFrame(() => {
              if (anchorRef.parentNode) {
                let textBefore = anchorRef.previousSibling;
                const sel = window.getSelection();
                const newRange = document.createRange();
                if (textBefore && textBefore.nodeType === Node.TEXT_NODE && textBefore.textContent.length > 0) {
                  newRange.setStart(textBefore, textBefore.textContent.length);
                } else {
                  newRange.setStartBefore(anchorRef);
                }
                newRange.collapse(true);
                sel.removeAllRanges();
                sel.addRange(newRange);
              }
            });
            return;
          }
        }
      }

      // Also check if we're about to merge into a paragraph that starts with a sup
      // (cursor at end of current element, next element starts with sup)
      if (!supElement && e.inputType === 'deleteContentForward') {
        const currentBlock = element?.closest('p, h1, h2, h3, h4, h5, h6, div');
        const nextBlock = currentBlock?.nextElementSibling;
        if (nextBlock) {
          const nextFirstChild = nextBlock.firstChild;
          // Skip BR elements to find actual content
          const actualFirstChild = nextFirstChild?.nodeName === 'BR' ? nextFirstChild.nextSibling : nextFirstChild;
          if (actualFirstChild?.nodeName === 'SUP') {
            e.preventDefault();
            e.stopPropagation();

            // Capture IDs before DOM removal
            const nextBlockId = nextBlock.id;
            const currentBlockId = currentBlock.id;

            // Manual merge: move all children from next block to current block
            while (nextBlock.firstChild) {
              currentBlock.appendChild(nextBlock.firstChild);
            }
            // Remove the empty next block
            nextBlock.remove();

            // Queue deletion of removed block and update of surviving block
            if (nextBlockId) queueNodeForDeletion(nextBlockId, nextBlock);
            if (currentBlockId) queueNodeForSave(currentBlockId, 'update');
            return;
          }
        }
      }

      if (!supElement) return;

      // Use sup's text length for determining position within sup
      const supTextLength = supElement.textContent?.length || 0;

      // Forward delete (fn+Delete) at position 0 OR Backspace at end = trying to delete sup content
      // Show confirmation dialog
      const isDeletingSupContent =
        cursorAfterSupInAnchor || // Cursor after sup/anchor - always treat as deleting (backspace)
        cursorBeforeHyperciteAnchor || // Cursor before hypercite anchor - always treat as deleting (forward delete)
        cursorBeforeFootnoteSup || // Cursor before footnote sup - always treat as deleting (forward delete)
        (e.inputType === 'deleteContentForward' && offset === 0) ||
        (e.inputType === 'deleteContentBackward' && offset >= supTextLength);

      if (isDeletingSupContent) {
        if (supElement.hasAttribute('fn-count-id')) {
          const fnNum = supElement.getAttribute('fn-count-id');

          if (!confirm(`Delete footnote ${fnNum}?`)) {
            e.preventDefault();
            e.stopPropagation();

            // Use setTimeout to restore cursor after dialog fully closes
            const targetSup = supElement; // Capture reference
            const wasForwardDelete = e.inputType === 'deleteContentForward';
            setTimeout(() => {
              const sel = window.getSelection();
              sel.removeAllRanges();
              const range = document.createRange();
              if (targetSup && targetSup.parentNode) {
                // Position based on delete direction
                if (wasForwardDelete) {
                  range.setStartBefore(targetSup); // fn-delete: cursor before
                } else {
                  range.setStartAfter(targetSup); // backspace: cursor after
                }
                range.collapse(true);
                sel.addRange(range);
              }
              // If element gone, cursor stays wherever browser put it
            }, 10);
            return;
          }

          // User confirmed footnote removal — queue delink so server cleans up
          // orphaned citedIN refs. Footnote record + sub-book content are preserved
          // (user may cut+paste the footnote back).
          const footnoteId = supElement.id || supElement.getAttribute('fn-count-id');
          const fnBook = supElement.closest('[data-book-id]')?.getAttribute('data-book-id')
            || document.querySelector('.main-content')?.id;

          if (footnoteId && fnBook) {
            queueForSync('footnotes', footnoteId, 'delete', { book: fnBook, footnoteId });
          }
        }
        // HYPERCITE LINK DELETION: Handle hypercite <a> elements
        // New structure: <a href="...#hypercite_xxx" class="open-icon">↗</a>
        // Also handles old structure where supElement was inside anchor
        else if (supElement.classList?.contains('open-icon') || supElement.closest?.('a[href*="#hypercite_"]')) {
          const hyperciteAnchor = supElement.tagName === 'A' ? supElement : supElement.closest('a[href*="#hypercite_"]');
          if (hyperciteAnchor) {
            if (!confirm('Delete hypercite citation link?')) {
              e.preventDefault();
              e.stopPropagation();

              // Use setTimeout to restore cursor after dialog fully closes
              const targetAnchor = hyperciteAnchor; // Capture reference
              const wasForwardDelete = e.inputType === 'deleteContentForward';
              setTimeout(() => {
                const sel = window.getSelection();
                sel.removeAllRanges();
                const range = document.createRange();
                if (targetAnchor && targetAnchor.parentNode) {
                  if (wasForwardDelete) {
                    range.setStartBefore(targetAnchor);
                  } else {
                    range.setStartAfter(targetAnchor);
                  }
                  range.collapse(true);
                  sel.addRange(range);
                }
              }, 10);
              return;
            }

            // User confirmed - remove the entire <a> tag
            // This triggers handleHyperciteRemoval via MutationObserver
            e.preventDefault();
            e.stopPropagation();
            console.log(`User confirmed hypercite link deletion: ${hyperciteAnchor.id}`);
            hyperciteAnchor.remove();
            return;
          }
        }
        // Allow deletion to proceed if confirmed or not a special element
        return;
      }

      // Backspace at position 0 inside/before sup/anchor → escape cursor (not trying to delete it)
      if (e.inputType === 'deleteContentBackward' && offset === 0) {
        e.preventDefault();
        e.stopPropagation();

        // If cursor is INSIDE the element (sup or hypercite anchor), move it before
        const isInsideElement = element?.closest('sup') === supElement
          || element?.closest('a[href*="#hypercite_"]') === supElement
          || supElement.contains(node);

        if (isInsideElement) {
          const newRange = document.createRange();
          newRange.setStartBefore(supElement);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);

          // After escaping, execute the backspace so user gets expected behavior
          document.execCommand('delete', false, null);
        } else {
          // Cursor is already before sup (at start of paragraph)
          // Do manual merge: move all content (including sup) to previous element
          const currentP = supElement.closest('p, h1, h2, h3, h4, h5, h6, div');
          const prevP = currentP?.previousElementSibling;
          if (prevP) {
            // Capture IDs before DOM removal
            const currentPId = currentP.id;
            const prevPId = prevP.id;

            // Move all children from current paragraph to previous
            while (currentP.firstChild) {
              prevP.appendChild(currentP.firstChild);
            }

            // Remove the now-empty paragraph
            currentP.remove();

            // Queue deletion of removed paragraph and update of surviving paragraph
            if (currentPId) queueNodeForDeletion(currentPId, currentP);
            if (prevPId) queueNodeForSave(prevPId, 'update');

            // Position cursor before the sup (which is now in prevP)
            const newRange = document.createRange();
            newRange.setStartBefore(supElement);
            newRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(newRange);
          }
          // If no previous element, delete is blocked (do nothing)
        }
        return;
      }

      // Forward delete at end of sup → normal behavior (delete what's after sup)
      // No special handling needed
    };

    this.editableDiv.addEventListener('beforeinput', this.supDeleteHandler, { capture: true });
  }

  /**
   * Arrow key navigation to skip across entire hypercite anchors with one key press
   */
  _attachArrowHandler() {
    if (this.hyperciteArrowHandler) {
      this.editableDiv.removeEventListener('keydown', this.hyperciteArrowHandler, { capture: true });
    }

    this.hyperciteArrowHandler = (e) => {
      if (!window.isEditing) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !selection.isCollapsed) return;

      let node = selection.anchorNode;
      if (!node) return;

      let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!element) return;

      const offset = selection.anchorOffset;
      let hyperciteAnchor = element.closest('a[href*="#hypercite_"]');

      // Also check if cursor is immediately BEFORE a hypercite anchor (for right arrow)
      if (!hyperciteAnchor && e.key === 'ArrowRight') {
        // Check if at end of text node and next sibling is hypercite anchor
        if (node.nodeType === Node.TEXT_NODE && offset === node.textContent.length) {
          let nextNode = node.nextSibling;
          while (nextNode && nextNode.nodeType === Node.TEXT_NODE && nextNode.textContent === '') {
            nextNode = nextNode.nextSibling;
          }
          if (nextNode?.tagName === 'A' && nextNode.href?.includes('#hypercite_')) {
            hyperciteAnchor = nextNode;
          }
        }
        // Check if cursor at offset position and next child is hypercite anchor
        if (!hyperciteAnchor && node.nodeType === Node.ELEMENT_NODE) {
          const nextChild = node.childNodes[offset];
          if (nextChild?.tagName === 'A' && nextChild.href?.includes('#hypercite_')) {
            hyperciteAnchor = nextChild;
          }
        }
      }

      // Also check if cursor is immediately AFTER a hypercite anchor (for left arrow)
      if (!hyperciteAnchor && e.key === 'ArrowLeft') {
        // Check if at start of text node and previous sibling is hypercite anchor
        if (node.nodeType === Node.TEXT_NODE && offset === 0) {
          let prevNode = node.previousSibling;
          while (prevNode && prevNode.nodeType === Node.TEXT_NODE && prevNode.textContent === '') {
            prevNode = prevNode.previousSibling;
          }
          if (prevNode?.tagName === 'A' && prevNode.href?.includes('#hypercite_')) {
            hyperciteAnchor = prevNode;
          }
        }
        // Check if cursor at offset position and previous child is hypercite anchor
        if (!hyperciteAnchor && node.nodeType === Node.ELEMENT_NODE && offset > 0) {
          const prevChild = node.childNodes[offset - 1];
          if (prevChild?.tagName === 'A' && prevChild.href?.includes('#hypercite_')) {
            hyperciteAnchor = prevChild;
          }
        }
      }

      if (!hyperciteAnchor) return;

      const newRange = document.createRange();

      if (e.key === 'ArrowRight') {
        // Jump to after anchor
        e.preventDefault();
        newRange.setStartAfter(hyperciteAnchor);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      } else if (e.key === 'ArrowLeft') {
        // Jump to before anchor
        e.preventDefault();
        newRange.setStartBefore(hyperciteAnchor);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      }
    };

    this.editableDiv.addEventListener('keydown', this.hyperciteArrowHandler, { capture: true });
  }
}
