/**
 * supEscapeHandler — beforeinput handler that prevents typing INSIDE a <sup>
 * (footnote numbers) or hypercite <a> anchor. Generated content there must never
 * be user-editable, so any inserted text is redirected to a text node OUTSIDE the
 * element (before or after, depending on cursor position). Extracted from
 * supTagHandler.js.
 *
 * Pure: operates on the live selection/DOM, no `this`, no module state.
 */
export function supEscapeHandler(e: any): void {
  if (!(window as any).isEditing) return;

  // Only handle text insertion events
  if (!e.inputType || !e.inputType.startsWith('insert')) return;

  // Don't intercept Enter/line break - let enterKeyHandler.js handle these
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') return;

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;

  // Use anchorNode which is more reliable for cursor position
  let node: any = selection.anchorNode;
  if (!node) return;

  // Get the element (if text node, get parent)
  let element: Element | null = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!element) return;

  // Check if we're inside a <sup> tag
  let supElement: any = element.closest('sup');

  // Also check if we're inside a hypercite <a> tag
  // Structure: <a href="...#hypercite_xxx" class="open-icon">↗</a>
  let hyperciteAnchor: any = element.closest('a[href*="#hypercite_"]');

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
  let insertionReference: any; // The element to insert relative to

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
        void supText;
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
  if (textToInsert === '\u0020') {
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
}
