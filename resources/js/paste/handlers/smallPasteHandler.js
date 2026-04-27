/**
 * Small Paste Handler
 *
 * Handles paste operations with ≤10 nodes using direct DOM manipulation.
 * Integrates with UndoManager for undo/redo support.
 */

import { setElementIds } from '../../utilities/IDfunctions.js';
import { queueNodeForSave } from '../../divEditor/index.js';
import { sanitizeHtml } from '../../utilities/sanitizeConfig.js';
import { setProgrammaticUpdateInProgress } from '../../utilities/operationState.js';
import { getEditToolbar } from '../../editToolbar/index.js';
import { getTextOffsetInElement, setCursorAtTextOffset } from '../../editToolbar/toolbarDOMUtils.js';
import { BLOCK_ELEMENT_SELECTOR } from '../../utilities/blockElements.js';

const SMALL_NODE_LIMIT = 10;

/**
 * Handle small paste operations (≤ SMALL_NODE_LIMIT nodes)
 * @param {Event} event - The paste event
 * @param {string} htmlContent - Processed HTML content (from markdown or sanitized)
 * @param {string} plainText - Original plain text
 * @param {number} nodeCount - Estimated node count
 * @param {string} book - Current book ID
 * @returns {boolean} - True if handled, false if should continue to large paste handler
 */
export function handleSmallPaste(event, htmlContent, plainText, nodeCount, book) {
  if (nodeCount > SMALL_NODE_LIMIT) {
    return false; // Not a small paste, continue to large paste handler
  }

  // CRITICAL: Prevent default IMMEDIATELY to stop browser's unsanitized paste
  event.preventDefault();

  console.log(
    `Small paste (≈${nodeCount} nodes); handling with direct DOM insertion.`
  );

  // --- 1. PREPARE THE CONTENT (initial) ---
  // SECURITY: Sanitize HTML content to prevent XSS
  let finalHtmlToInsert = htmlContent ? sanitizeHtml(htmlContent) : null;

  // --- 2. GET INSERTION CONTEXT (BEFORE PASTING) ---
  const selection = window.getSelection();
  if (!selection.rangeCount) return true;

  const range = selection.getRangeAt(0);
  let currentElement = range.startContainer;
  if (currentElement.nodeType === Node.TEXT_NODE) {
    currentElement = currentElement.parentElement;
  }

  let currentBlock = currentElement.closest(BLOCK_ELEMENT_SELECTOR);

  if (
    !currentBlock ||
    !currentBlock.id ||
    !/^\d+(\.\d+)*$/.test(currentBlock.id)
  ) {
    console.warn(
      "Small paste aborted: Could not find a valid anchor block with a numerical ID."
    );
    // Allow native paste as a fallback in this edge case.
    return false;
  }

  // --- 2.5. FINALIZE CONTENT PREPARATION (now that we have currentBlock) ---

  // If we only have plain text, convert it to structured HTML.
  if (!finalHtmlToInsert && plainText) {
    const parts = plainText
      .split(/\n\s*\n/) // Split on blank lines
      .filter((p) => p.trim());

    // Don't wrap in <p> if we're already inside a block element
    if (parts.length === 1 && currentBlock) {
      finalHtmlToInsert = parts[0];
    } else {
      finalHtmlToInsert = parts.map((p) => `<p>${p}</p>`).join("");
    }
  }

  // If there's nothing to insert, we're done.
  if (!finalHtmlToInsert) {
    return true;
  }

  // SECURITY: Sanitize BEFORE any innerHTML assignment to prevent XSS
  // This MUST happen before the unwrap check below, because setting innerHTML
  // on even a detached element will execute onerror/onload handlers!
  finalHtmlToInsert = sanitizeHtml(finalHtmlToInsert);

  // Convert <h1> tags to <p> (prevents duplicate H1 titles when pasting from another book)
  finalHtmlToInsert = finalHtmlToInsert.replace(/<h1(\s[^>]*)?>/gi, '<p$1>').replace(/<\/h1>/gi, '</p>');

  // Strip id, data-node-id, no-delete-id attributes (fix-up phase assigns fresh ones)
  finalHtmlToInsert = finalHtmlToInsert.replace(/\s(?:id|data-node-id|no-delete-id)="[^"]*"/gi, '');

  // Strip style attributes — browser bakes computed CSS (e.g. font-family: var(--font-family-base))
  // into clipboard HTML when copying from contenteditable; these are visual noise, not user intent
  finalHtmlToInsert = finalHtmlToInsert.replace(/\sstyle="[^"]*"/gi, '');

  // If pasting HTML with a single <p> wrapper into an existing <p>, unwrap it
  // SAFE: Content is already sanitized above
  if (finalHtmlToInsert && currentBlock) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = finalHtmlToInsert;

    // Check if content is a single <p> tag
    if (tempDiv.children.length === 1 && tempDiv.children[0].tagName === 'P') {
      // Unwrap: use innerHTML of the <p> instead of the entire <p>
      finalHtmlToInsert = tempDiv.children[0].innerHTML;
      console.log(`Unwrapped <p> tag to prevent nesting in paste`);
    }
  }

  // --- 3. DETECT BLOCK ELEMENTS ---

  // Detect if pasted content contains block-level elements
  let hasBlockElements = false;
  if (finalHtmlToInsert) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(finalHtmlToInsert, 'text/html');
    hasBlockElements = doc.body.querySelector(BLOCK_ELEMENT_SELECTOR) !== null;
  }

  // --- 4. SEAL UNDO GROUP + CAPTURE CURSOR (before any cursor moves) ---

  const undoManager = getEditToolbar()?.undoManager;
  if (undoManager) undoManager.sealGroup();

  let cursorBefore = { elementId: currentBlock.id, offset: 0 };
  {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      try {
        cursorBefore.offset = getTextOffsetInElement(currentBlock, sel.focusNode, sel.focusOffset);
      } catch (e) { /* cursor may not be inside block (will be moved for H1) */ }
    }
  }

  // Protect H1 from being split by block-level paste:
  // Move cursor to just after the H1 so blocks are inserted after it, not inside it
  if (currentBlock && currentBlock.tagName === 'H1' && hasBlockElements) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStartAfter(currentBlock);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    console.log('Moved cursor after H1 to prevent splitting');
  }

  // --- 5. PERFORM THE PASTE ---

  setProgrammaticUpdateInProgress(true);
  try {
    if (!hasBlockElements) {
      _inlinePaste(currentBlock, finalHtmlToInsert, book, undoManager, cursorBefore);
    } else {
      _blockPaste(currentBlock, finalHtmlToInsert, book, undoManager, cursorBefore);
    }
  } finally {
    setTimeout(() => setProgrammaticUpdateInProgress(false), 0);
  }

  return true; // We handled it.
}

/**
 * Path A: Inline paste — content goes inside the current block at cursor position.
 */
function _inlinePaste(currentBlock, html, book, undoManager, cursorBefore) {
  const oldHTML = currentBlock.innerHTML;

  // Get fresh selection/range
  const selection = window.getSelection();
  const range = selection.getRangeAt(0);

  // Delete any selected content
  range.deleteContents();

  // Measure text before cursor position (after deletion) for cursor restoration
  let textBeforeCursor = 0;
  try {
    const beforeRange = document.createRange();
    beforeRange.setStart(currentBlock, 0);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    textBeforeCursor = beforeRange.toString().length;
  } catch (e) { /* ignore */ }

  // Create fragment from HTML via <template>
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  const pastedTextLength = fragment.textContent.length;

  // Insert at cursor position
  range.insertNode(fragment);
  currentBlock.normalize();

  // Place cursor after pasted content
  setCursorAtTextOffset(currentBlock, textBeforeCursor + pastedTextLength);

  // Record undo entry
  const newHTML = currentBlock.innerHTML;
  if (undoManager && oldHTML !== newHTML) {
    let cursorAfter = 0;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        cursorAfter = getTextOffsetInElement(currentBlock, sel.focusNode, sel.focusOffset);
      }
    } catch (e) { /* ignore */ }

    undoManager._pushUndo(book, {
      type: 'input',
      elementId: currentBlock.id,
      oldHTML,
      newHTML,
      bookId: book,
      cursorBefore: cursorBefore.offset,
      cursorAfter,
    });
    console.log(`[Paste] Recorded inline paste undo for #${currentBlock.id}`);
  }

  // Queue for save
  queueNodeForSave(currentBlock.id, 'update', book);
}

/**
 * Path B: Block paste — current block is split at cursor; new blocks inserted between halves.
 */
function _blockPaste(currentBlock, html, book, undoManager, cursorBefore) {
  const oldHTML = currentBlock.innerHTML;

  // Check if cursor is inside currentBlock (false when cursor was moved after H1)
  const cursorInsideBlock = currentBlock.contains(
    window.getSelection().getRangeAt(0).startContainer
  );

  // Editable container for structural undo entry
  const editable = currentBlock.closest('[contenteditable="true"]');
  const editableSelector = editable?.getAttribute('data-book-id')
    ? `[data-book-id="${editable.getAttribute('data-book-id')}"]`
    : editable?.id ? `#${editable.id}` : null;

  // Get fresh selection/range
  const selection = window.getSelection();
  const range = selection.getRangeAt(0);

  // Delete any selected content
  range.deleteContents();

  // Extract tail content (content after cursor in currentBlock)
  let tailFragment = null;
  if (cursorInsideBlock && currentBlock.childNodes.length > 0) {
    try {
      const tailRange = document.createRange();
      tailRange.setStart(range.startContainer, range.startOffset);
      tailRange.setEnd(currentBlock, currentBlock.childNodes.length);

      // Check if there's meaningful content to extract
      const cloned = tailRange.cloneContents();
      const tempCheck = document.createElement('div');
      tempCheck.appendChild(cloned);
      if (tempCheck.textContent.trim() || tempCheck.querySelector('img, sup')) {
        tailFragment = tailRange.extractContents();
      }
    } catch (e) {
      console.warn('[Paste] Could not extract tail content:', e.message);
    }
  }

  // Parse pasted HTML, separate leading inline nodes from block elements
  const tempContainer = document.createElement('div');
  tempContainer.innerHTML = html;

  const leadingInlines = [];
  const blockNodes = [];
  for (const child of Array.from(tempContainer.childNodes)) {
    if (blockNodes.length === 0 &&
        (child.nodeType === Node.TEXT_NODE ||
         (child.nodeType === Node.ELEMENT_NODE &&
          !child.matches(BLOCK_ELEMENT_SELECTOR)))) {
      leadingInlines.push(child);
    } else {
      blockNodes.push(child);
    }
  }

  // Merge leading inline content into currentBlock (normal case)
  if (cursorInsideBlock && leadingInlines.length > 0) {
    for (const node of leadingInlines) {
      currentBlock.appendChild(node);
    }
  }

  // Ensure currentBlock has content if it was emptied by tail extraction
  if (cursorInsideBlock && !currentBlock.textContent.trim() &&
      !currentBlock.querySelector('img, sup, br')) {
    currentBlock.innerHTML = '<br>';
  }

  // Insert new block elements as siblings after currentBlock
  const container = currentBlock.closest('.chunk') || currentBlock.parentNode;
  let insertAfter = currentBlock;
  const insertedElements = [];

  // H1 case: cursor was moved outside block, wrap leading inlines in a <p>
  if (!cursorInsideBlock && leadingInlines.length > 0) {
    const p = document.createElement('p');
    for (const node of leadingInlines) {
      p.appendChild(node);
    }
    if (insertAfter.nextSibling) {
      container.insertBefore(p, insertAfter.nextSibling);
    } else {
      container.appendChild(p);
    }
    insertedElements.push(p);
    insertAfter = p;
  }

  // Insert block-level elements
  for (const blockNode of blockNodes) {
    let elementToInsert;
    if (blockNode.nodeType === Node.ELEMENT_NODE &&
        blockNode.matches(BLOCK_ELEMENT_SELECTOR)) {
      elementToInsert = blockNode;
    } else {
      // Skip whitespace-only text nodes
      if (blockNode.nodeType === Node.TEXT_NODE && !blockNode.textContent.trim()) continue;
      // Wrap inline/text content in a <p>
      const p = document.createElement('p');
      p.appendChild(blockNode);
      elementToInsert = p;
    }

    if (insertAfter.nextSibling) {
      container.insertBefore(elementToInsert, insertAfter.nextSibling);
    } else {
      container.appendChild(elementToInsert);
    }
    insertedElements.push(elementToInsert);
    insertAfter = elementToInsert;
  }

  // Create tail <p> from extracted content (if non-empty)
  if (tailFragment) {
    const tailP = document.createElement('p');
    tailP.appendChild(tailFragment);
    if (tailP.textContent.trim() || tailP.querySelector('img, sup')) {
      if (insertAfter.nextSibling) {
        container.insertBefore(tailP, insertAfter.nextSibling);
      } else {
        container.appendChild(tailP);
      }
      insertedElements.push(tailP);
    }
  }

  // --- ID ASSIGNMENT ---
  // Find the next stable element (already has a valid ID, beyond all pasted elements)
  let nextStableElement = (insertedElements.length > 0
    ? insertedElements[insertedElements.length - 1]
    : currentBlock
  ).nextElementSibling;
  while (nextStableElement &&
         (!nextStableElement.id || !/^\d+(\.\d+)*$/.test(nextStableElement.id))) {
    nextStableElement = nextStableElement.nextElementSibling;
  }
  const nextStableId = nextStableElement ? nextStableElement.id : null;

  let lastKnownId = currentBlock.id;
  for (const element of insertedElements) {
    if (element.matches(BLOCK_ELEMENT_SELECTOR)) {
      setElementIds(element, lastKnownId, nextStableId, book);
      console.log(`Assigned ID ${element.id} to pasted block element`);
      queueNodeForSave(element.id, 'add', book);
      lastKnownId = element.id;
    }
  }

  // Queue currentBlock for save if it was modified
  if (cursorInsideBlock) {
    queueNodeForSave(currentBlock.id, 'update', book);
  }

  // --- CURSOR PLACEMENT ---
  const lastElement = insertedElements.length > 0
    ? insertedElements[insertedElements.length - 1]
    : currentBlock;

  const editableEl = lastElement.closest('[contenteditable="true"]');
  if (editableEl && document.activeElement !== editableEl) editableEl.focus();
  setCursorAtTextOffset(lastElement, lastElement.textContent.length);

  // --- STRUCTURAL UNDO ENTRY ---
  if (undoManager && editableSelector) {
    const modified = [];
    if (cursorInsideBlock && oldHTML !== currentBlock.innerHTML) {
      modified.push({
        id: currentBlock.id,
        oldHTML,
        newHTML: currentBlock.innerHTML,
        oldTag: currentBlock.tagName.toLowerCase(),
        newTag: currentBlock.tagName.toLowerCase(),
      });
    }

    const added = insertedElements
      .filter(el => el.id && /^\d+(\.\d+)*$/.test(el.id))
      .map(el => ({
        id: el.id,
        html: el.innerHTML,
        tag: el.tagName.toLowerCase(),
        nodeId: el.getAttribute('data-node-id'),
        afterId: el.previousElementSibling?.id || null,
      }));

    let cursorAfter = { elementId: lastElement.id, offset: 0 };
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        cursorAfter.offset = getTextOffsetInElement(lastElement, sel.focusNode, sel.focusOffset);
      }
    } catch (e) { /* ignore */ }

    undoManager._pushUndo(book, {
      type: 'structural',
      bookId: book,
      modified,
      added,
      removed: [],
      editableSelector,
      cursorBefore,
      cursorAfter,
    });
    console.log(`[Paste] Recorded block paste undo: ${modified.length} modified, ${added.length} added`);
  }
}
