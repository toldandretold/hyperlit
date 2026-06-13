/**
 * hyperciteArrowHandler — keydown handler that lets ArrowLeft/ArrowRight skip
 * across an entire hypercite <a> anchor in one press (so the cursor doesn't get
 * stuck stepping through the arrow glyph). Extracted from supTagHandler.js.
 *
 * Pure: operates on the live selection/DOM, no `this`, no module state.
 */
export function hyperciteArrowHandler(e: KeyboardEvent): void {
  if (!(window as any).isEditing) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed) return;

  let node: any = selection.anchorNode;
  if (!node) return;

  let element: Element | null = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!element) return;

  const offset = selection.anchorOffset;
  let hyperciteAnchor: any = element.closest('a[href*="#hypercite_"]');

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
}
