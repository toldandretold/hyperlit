// Extracted from divEditor/index.ts's keydown listener — Backspace handling inside a
// list item. Backspace at the start of an <li> (or on an empty bullet) either removes
// the bullet and drops the caret at the end of the previous one, or outdents the item
// to a paragraph (with four positional cases: empty-list replace / first / last /
// middle-split). Pulled out of the anonymous document-level listener so it is testable.
import { listItemIsEmpty, placeCaretAtEndOfListItem } from '../../utilities/listItemCaret';
import {
  ensureNodeHasValidId,
  setElementIds,
  findPreviousElementId,
  findNextElementId,
} from '../../utilities/idHelpers';
import { queueNodeForSave } from '../editorState';
import { book } from '../../app';

/**
 * Handle Backspace inside a list item. Returns `true` when it consumed the key
 * (it has already called `event.preventDefault()` and mutated the DOM/queue), so the
 * caller should stop. Returns `false` when the key is not a collapsed Backspace inside
 * an <li>, or the caret is not at the item's start — the caller continues normally.
 */
export function handleListItemBackspace(
  event: KeyboardEvent,
  range: Range,
  selection: Selection,
  targetElement: Element | null,
): boolean {
  if (event.key !== 'Backspace' || !range.collapsed) return false;

  const liElement = targetElement?.closest('li');
  if (!liElement) return false;

  // EMPTY bullet + Backspace: don't outdent to a paragraph. If there's a previous
  // bullet, just remove this one and drop the caret at the end of that previous bullet
  // — the caret stays in the list (intuitive backward-delete). Only an empty FIRST
  // bullet (no previous sibling) falls through to the outdent-to-paragraph path below.
  // NOTE: an empty bullet holds a zero-width-space caret anchor (see listItemCaret.js),
  // so listItemIsEmpty — not a raw offset check — is what reliably detects "empty" here.
  if (listItemIsEmpty(liElement)) {
    const prevLi = liElement.previousElementSibling;
    if (prevLi && prevLi.tagName === 'LI') {
      event.preventDefault();
      const parentList = liElement.closest('ul, ol');
      if (parentList) {
        ensureNodeHasValidId(parentList);
        liElement.remove();
        placeCaretAtEndOfListItem(prevLi);
        queueNodeForSave(parentList.id, 'update');
        return true;
      }
    }
  }

  // Check if cursor is at the very start of the LI
  let isAtStart = false;
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    isAtStart = range.startOffset === 0 &&
      (range.startContainer === liElement.firstChild ||
       range.startContainer.parentNode === liElement.firstChild ||
       !(liElement.textContent ?? '').substring(0, (range.startContainer.textContent ?? '').length).trim());
  } else if (range.startContainer === liElement) {
    isAtStart = range.startOffset === 0;
  }

  // An empty FIRST bullet (no previous sibling, so not handled above) holds a
  // zero-width-space anchor → caret at offset 1, not 0. Treat it as "at start" so a
  // single Backspace still outdents it to a paragraph.
  if (listItemIsEmpty(liElement)) {
    isAtStart = true;
  }

  if (!isAtStart) return false;

  event.preventDefault();

  const parentList = liElement.closest('ul, ol');
  if (!parentList) return true;

  // Ensure parent list has ID
  ensureNodeHasValidId(parentList);
  if (!parentList.id) {
    console.error("Could not assign ID to parent list");
    return true;
  }

  // Get position of this LI
  const allItems = Array.from(parentList.children);
  const itemIndex = allItems.indexOf(liElement);
  const itemsBefore = allItems.slice(0, itemIndex);
  const itemsAfter = allItems.slice(itemIndex + 1);

  // Create paragraph with LI content. An empty bullet may hold a zero-width-space caret
  // anchor — normalise that to a <br> so the new paragraph isn't seeded with a stray ZWSP.
  const newParagraph = document.createElement('p');
  newParagraph.innerHTML = listItemIsEmpty(liElement) ? '<br>' : (liElement.innerHTML || '<br>');

  // Remove the LI
  liElement.remove();

  if (parentList.children.length === 0) {
    // List is now empty - replace it with the paragraph
    setElementIds(newParagraph, findPreviousElementId(parentList), findNextElementId(parentList), book);
    parentList.replaceWith(newParagraph);
    queueNodeForSave(newParagraph.id, 'add');
  } else if (itemsBefore.length === 0) {
    // Was first item - put paragraph before list
    setElementIds(newParagraph, findPreviousElementId(parentList), parentList.id, book);
    parentList.before(newParagraph);
    queueNodeForSave(newParagraph.id, 'add');
    queueNodeForSave(parentList.id, 'update');
  } else if (itemsAfter.length === 0) {
    // Was last item - put paragraph after list
    setElementIds(newParagraph, parentList.id, findNextElementId(parentList), book);
    parentList.after(newParagraph);
    queueNodeForSave(parentList.id, 'update');
    queueNodeForSave(newParagraph.id, 'add');
  } else {
    // Was in the middle - split the list
    const newList = document.createElement(parentList.tagName);
    itemsAfter.forEach(item => newList.appendChild(item));

    setElementIds(newParagraph, parentList.id, null, book);
    parentList.after(newParagraph);

    setElementIds(newList, newParagraph.id, findNextElementId(newParagraph), book);
    newParagraph.after(newList);

    queueNodeForSave(parentList.id, 'update');
    queueNodeForSave(newParagraph.id, 'add');
    queueNodeForSave(newList.id, 'add');
  }

  // Move cursor to start of new paragraph
  const target = newParagraph.firstChild?.nodeType === Node.TEXT_NODE
    ? newParagraph.firstChild
    : newParagraph;
  const newRange = document.createRange();
  newRange.setStart(target, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);

  return true;
}
