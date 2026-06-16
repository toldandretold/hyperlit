/**
 * SPAN destruction — replace a <span> with a plain text node while preserving
 * the caret position. Extracted from chunkMutationHandler (no `this` — a pure
 * DOM operation). NO SPANS ALLOWED in the document; the MutationObserver path
 * funnels styled/created spans through here.
 */
import { verbose } from '../../utilities/logger';

export function destroySpan(element: any) {
  const selection: any = window.getSelection();
  let savedRange = null;
  let cursorWasInSpan = false;
  let cursorOffset = 0;

  if (selection.rangeCount > 0) {
    savedRange = selection.getRangeAt(0);
    if (element.contains(savedRange.startContainer)) {
      cursorWasInSpan = true;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
      let textNode: any;
      let offset = 0;
      while (textNode = walker.nextNode()) {
        if (textNode === savedRange.startContainer) {
          cursorOffset = offset + savedRange.startOffset;
          break;
        }
        offset += textNode.length;
      }
    }
  }

  let replacementTextNode = null;
  if (element.textContent.trim()) {
    replacementTextNode = document.createTextNode(element.textContent);
    if (element.parentNode && document.contains(element.parentNode)) {
      element.parentNode.insertBefore(replacementTextNode, element);
    }
  }

  if (document.contains(element)) {
    element.remove();
  }

  if (cursorWasInSpan && replacementTextNode) {
    const newRange = document.createRange();
    const safeOffset = Math.min(cursorOffset, replacementTextNode.length);
    newRange.setStart(replacementTextNode, safeOffset);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
    verbose.content(`Cursor restored at offset ${safeOffset} after SPAN destruction`, 'divEditor/chunkMutationHandler.js');
  }

  return { replacementNode: replacementTextNode, cursorInfo: { cursorWasInSpan, cursorOffset } };
}
