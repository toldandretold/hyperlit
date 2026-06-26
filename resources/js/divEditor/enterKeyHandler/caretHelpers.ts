/**
 * Caret/paragraph helpers for the Enter-key handler — caret scrolling and the
 * "create a new paragraph after this block" routine. Extracted from
 * enterKeyHandler.js (module-level functions; no `this`).
 */
import { book } from '../../app';
import { ensureNodeHasValidId, setElementIds } from '../../utilities/idHelpers';
import { queueNodeForSave } from '../editorState';
import { verbose } from '../../utilities/logger';

/**
 * Helper: Check if element is in viewport
 */
export function isElementInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

/**
 * Helper: Scroll caret into view
 * Uses .reader-content-wrapper as the scroll container (not window)
 */
export function scrollCaretIntoView(): void {
  verbose.content("scrollCaretIntoView start", 'divEditor/enterKeyHandler.js');
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) {
    verbose.content("no selection range → abort", 'divEditor/enterKeyHandler.js');
    return;
  }

  const range = sel.getRangeAt(0);
  let rect: any = range.getBoundingClientRect();

  // If caret rect has no height (empty paragraph with <br>), use parent element's rect
  if (!rect || rect.height === 0) {
    const node: any = range.startContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (element) {
      rect = element.getBoundingClientRect();
      verbose.content(`caret rect was empty, using parent element rect`, 'divEditor/enterKeyHandler.js');
    }
  }

  if (!rect || rect.height === 0) {
    verbose.content("no valid rect found → abort", 'divEditor/enterKeyHandler.js');
    return;
  }

  verbose.content(`caret rect: top=${Math.round(rect.top)} bottom=${Math.round(rect.bottom)} height=${Math.round(rect.height)}`, 'divEditor/enterKeyHandler.js');

  // Find the scroll container (not window)
  const scrollContainer = document.querySelector('.reader-content-wrapper');
  if (!scrollContainer) {
    verbose.content("no scroll container found", 'divEditor/enterKeyHandler.js');
    return;
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  const clipBottom = 40; // clip-path: inset(15px 0 40px 0) clips 40px from bottom
  const clipTop = 15;    // clip-path clips 15px from top
  const padding = 20;    // Extra buffer space

  // Visible area is smaller than containerRect due to clip-path
  const visibleBottom = containerRect.bottom - clipBottom;
  const visibleTop = containerRect.top + clipTop;

  // Check if caret is below visible area
  if (rect.bottom > visibleBottom - padding) {
    const delta = rect.bottom - (visibleBottom - padding);
    verbose.content(`scrolling container down by ${delta}px`, 'divEditor/enterKeyHandler.js');
    scrollContainer.scrollBy({ top: delta, behavior: "smooth" });
  }
  // Check if caret is above visible area
  else if (rect.top < visibleTop + padding) {
    const delta = rect.top - (visibleTop + padding);
    verbose.content(`scrolling container up by ${delta}px`, 'divEditor/enterKeyHandler.js');
    scrollContainer.scrollBy({ top: delta, behavior: "smooth" });
  } else {
    verbose.content("caret in view, no scroll", 'divEditor/enterKeyHandler.js');
  }
}

/**
 * Helper: Move the caret to (node, offset), then scroll it into view
 */
export function moveCaretTo(node: Node, offset = 0): void {
  const sel = document.getSelection()!;
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  // Delay scroll to ensure DOM has settled
  setTimeout(scrollCaretIntoView, 50);
}

/**
 * Helper: Create and insert a new paragraph after blockElement
 */
export function createAndInsertParagraph(blockElement: HTMLElement, chunkContainer: any, content: any, selection: any): HTMLElement | null {
  // 1. PROACTIVELY FIX THE SOURCE ELEMENT
  ensureNodeHasValidId(blockElement);
  if (!blockElement.id) {
    console.error("FATAL: Could not assign an ID to the source block element. Aborting paragraph creation.", blockElement);
    return null;
  }

  // 2. Create the new paragraph
  const newParagraph = document.createElement('p');

  // 3. Handle content
  if (content) {
    const nodes = content.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      ? Array.from(content.childNodes)
      : [content];

    // MOVE the extracted nodes into the new paragraph — do NOT clone them.
    // cloneNode(true) copies a <mark>/<u> highlight's attributes (including the
    // data-listener-attached / data-hypercite-listener guard flags) but NOT its
    // event listeners, leaving a highlight that LOOKS wired up yet is unclickable.
    // These nodes came from extractContents() and are referenced nowhere else, so
    // moving them is safe and preserves their real click/hover listeners.
    nodes.forEach((node: any) => {
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'P') {
        // Unwrap a nested <p> (extractContents clones the partially-selected
        // source paragraph) by moving its children, not the wrapper.
        Array.from(node.childNodes).forEach((child: any) => {
          newParagraph.appendChild(child);
        });
      } else {
        newParagraph.appendChild(node);
      }
    });
  } else {
    const br = document.createElement('br');
    newParagraph.appendChild(br);
  }

  // 4. SIMPLIFIED AND UNIFIED ID GENERATION
  const container = blockElement.closest('.chunk') || blockElement.parentNode!;

  // Find the next element with a numeric ID
  let nextElement = blockElement.nextElementSibling;
  while (nextElement && (!nextElement.id || !/^\d+(\.\d+)?$/.test(nextElement.id))) {
    nextElement = nextElement.nextElementSibling;
  }

  // ALWAYS use setElementIds to set both id and data-node-id
  const nextElementId = nextElement ? nextElement.id : null;
  setElementIds(newParagraph, blockElement.id, nextElementId, book);

  // 5. Insert the paragraph at the correct position in the DOM
  if (blockElement.nextSibling) {
    container.insertBefore(newParagraph, blockElement.nextSibling);
  } else {
    container.appendChild(newParagraph);
  }

  // Always queue new paragraph for save — don't rely solely on MutationObserver,
  // which gets blocked during chunk overflow
  queueNodeForSave(newParagraph.id, 'add');

  // Check if renumbering was flagged during ID generation
  if ((window as any).__pendingRenumbering) {
    console.log('🔄 Renumbering flagged - triggering renumbering');

    // Import and trigger renumbering
    import('../../utilities/IDfunctions').then(({ triggerRenumberingWithModal }) => {
      triggerRenumberingWithModal(0).catch((err: any) => {
        console.error('Background renumbering failed:', err);
      });
    });

    // Clear the flag
    (window as any).__pendingRenumbering = false;
  }

  verbose.content(`Created new paragraph with ID ${newParagraph.id} after ${blockElement.id}`, 'divEditor/enterKeyHandler.js');

  // 6. Move cursor and scroll
  const target = newParagraph.firstChild?.nodeType === Node.TEXT_NODE
    ? newParagraph.firstChild
    : newParagraph;
  moveCaretTo(target, 0);

  return newParagraph;
}
