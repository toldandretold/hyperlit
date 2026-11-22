import type { BookId } from "../../indexedDB/types";
/**
 * Code Block Paste Handler
 *
 * A paste whose selection lies entirely inside a code block (`<pre>`) inserts
 * the clipboard's PLAIN TEXT as a text node — never HTML, whatever the
 * clipboard's text/html side holds. Code is its characters: rich editor HTML
 * (VS Code's per-line divs, coloured spans) would otherwise land as structure,
 * and pasted markup must stay visible source, never become live elements.
 *
 * Called SYNCHRONOUSLY at the top of handlePaste, before any `await`: Firefox
 * empties `event.clipboardData` once the handler yields, so a check made after
 * the format processors ran would read an empty clipboard and fall through.
 */

import { queueNodeForSave } from '../../divEditor/index';
import { normaliseNewlines } from '../codePaste';

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

/**
 * Handle paste into code blocks.
 * @param event - the paste event (only `clipboardData` is read, unless `plainTextOverride` is given)
 * @param _chunk - unused (kept for signature compatibility)
 * @param book - target book for the save queue
 * @param plainTextOverride - the clipboard text captured synchronously by the caller
 * @returns true if handled as a code-block paste
 */
export function handleCodeBlockPaste(
  event: ClipboardEvent,
  _chunk: Element | null = null,
  book: BookId | null = null,
  plainTextOverride: string | null = null,
): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);

  const startPre = elementOf(range.startContainer)?.closest('pre') ?? null;
  const endPre = elementOf(range.endContainer)?.closest('pre') ?? null;
  // Only a selection wholly inside ONE code block; a selection that straddles
  // out of it is an ordinary (structural) paste.
  if (!startPre || startPre !== endPre) return false;
  // Never paste into render-only furniture (the code block header).
  if (elementOf(range.startContainer)?.closest('[data-render-only]')) return false;

  const raw = plainTextOverride ?? event.clipboardData?.getData('text/plain') ?? '';
  if (!raw) return false;
  event.preventDefault();

  const text = normaliseNewlines(raw);

  // Insert inside the <code> when the block has one, even if the caret sits on
  // the <pre> boundary (e.g. right after the header).
  const code = startPre.querySelector(':scope > code');
  if (code && !code.contains(range.startContainer)) {
    range.selectNodeContents(code);
    range.collapse(false);
  }

  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);

  // Caret after the inserted text.
  const after = document.createRange();
  after.setStartAfter(textNode);
  after.collapse(true);
  selection.removeAllRanges();
  selection.addRange(after);
  (code ?? startPre).normalize();

  if (startPre.id) queueNodeForSave(startPre.id, 'update', book);
  return true;
}
