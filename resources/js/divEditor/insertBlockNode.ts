/**
 * Insert a prepared block element as a NEW node next to an existing one — the
 * canonical id-mint-and-save recipe generalized from createAndInsertParagraph
 * (enterKeyHandler/caretHelpers.ts), for callers that bring their own element
 * (image drop / toolbar image insert). Steps: ensure the anchor has a valid
 * id → find the neighbouring numeric-id sibling → setElementIds (fractional
 * LineId + data-node-id) → insert inside the anchor's `.chunk` → queue an
 * explicit 'add' save (never rely solely on the MutationObserver — its batch
 * is dropped during chunk overflow / paste; double-queueing dedupes by id) →
 * honour a flagged renumbering.
 */
import { ensureNodeHasValidId, setElementIds, NUMERICAL_ID_PATTERN, type BookId } from '../utilities/idHelpers';
import { queueNodeForSave } from './editorState';
import { log, verbose } from '../utilities/logger';

function finalizeInsert(newBlock: HTMLElement, bookId: BookId): HTMLElement | null {
  queueNodeForSave(newBlock.id, 'add', bookId);

  if ((window as unknown as { __pendingRenumbering?: boolean }).__pendingRenumbering) {
    void import('../utilities/IDfunctions').then(({ triggerRenumberingWithModal }) => {
      triggerRenumberingWithModal(0).catch((err: unknown) => {
        log.error(`Background renumbering failed: ${String(err)}`, 'divEditor/insertBlockNode');
      });
    });
    (window as unknown as { __pendingRenumbering?: boolean }).__pendingRenumbering = false;
  }

  verbose.content(`Inserted new block node ${newBlock.id}`, 'divEditor/insertBlockNode');
  return newBlock;
}

/** Walk siblings for the nearest element with a numeric (LineId-shaped) id. */
function nearestNumericSibling(from: HTMLElement, direction: 'next' | 'previous'): Element | null {
  let el = direction === 'next' ? from.nextElementSibling : from.previousElementSibling;
  while (el && (!el.id || !NUMERICAL_ID_PATTERN.test(el.id))) {
    el = direction === 'next' ? el.nextElementSibling : el.previousElementSibling;
  }
  return el;
}

/**
 * Insert `newBlock` as a new node directly AFTER `anchorNode`. Returns the
 * inserted element (with its minted LineId) or null when the anchor can't be
 * given a valid id.
 */
export function insertBlockNodeAfter(anchorNode: HTMLElement, newBlock: HTMLElement, bookId: BookId): HTMLElement | null {
  ensureNodeHasValidId(anchorNode);
  if (!anchorNode.id || !NUMERICAL_ID_PATTERN.test(anchorNode.id)) {
    log.error('insertBlockNodeAfter: anchor has no valid numeric id — aborting insert', 'divEditor/insertBlockNode');
    return null;
  }

  const container = anchorNode.closest('.chunk') ?? anchorNode.parentNode;
  if (!container) return null;

  const nextElement = nearestNumericSibling(anchorNode, 'next');
  setElementIds(newBlock, anchorNode.id, nextElement ? nextElement.id : null, bookId);

  if (anchorNode.nextSibling) {
    container.insertBefore(newBlock, anchorNode.nextSibling);
  } else {
    container.appendChild(newBlock);
  }

  return finalizeInsert(newBlock, bookId);
}

/**
 * Insert `newBlock` as a new node directly BEFORE `anchorNode`. The previous
 * numeric sibling (when present) becomes the "before" bound so the minted id
 * lands strictly between the two neighbours.
 */
export function insertBlockNodeBefore(anchorNode: HTMLElement, newBlock: HTMLElement, bookId: BookId): HTMLElement | null {
  ensureNodeHasValidId(anchorNode);
  if (!anchorNode.id || !NUMERICAL_ID_PATTERN.test(anchorNode.id)) {
    log.error('insertBlockNodeBefore: anchor has no valid numeric id — aborting insert', 'divEditor/insertBlockNode');
    return null;
  }

  const container = anchorNode.closest('.chunk') ?? anchorNode.parentNode;
  if (!container) return null;

  const previousElement = nearestNumericSibling(anchorNode, 'previous');
  setElementIds(newBlock, previousElement ? previousElement.id : null, anchorNode.id, bookId);

  container.insertBefore(newBlock, anchorNode);

  return finalizeInsert(newBlock, bookId);
}
