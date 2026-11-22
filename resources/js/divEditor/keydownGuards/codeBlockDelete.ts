// Backspace at the START of a code block / Delete at its END.
//
// A rendered code block's first child is its header (language label, copy,
// expand): a contenteditable=false span with no text. The browser's native
// Backspace with the caret at the start of the code deletes "the thing before
// the caret" — that header — so joining two code blocks deleted the second
// block's furniture and merged nothing. These keys are now explicit:
//
//   - Backspace at the start, previous block is code → the two blocks JOIN
//     (one newline between), the lower block's node is deleted.
//   - Delete at the end, next block is code → the same join.
//   - Backspace at the start of an EMPTY block → it becomes an empty paragraph.
//   - Backspace at the start otherwise → the caret moves to the end of the
//     previous block; nothing is destroyed.
//
// Live child nodes are MOVED, never re-parsed, so highlight <mark>s and
// hypercite anchors keep their identity across a join.
import { queueNodeForSave } from '../editorState';

const RENDER_ONLY = '[data-render-only]';

function codeOf(pre: Element): Element {
  return pre.querySelector(':scope > code') ?? pre;
}

function textNodesOf(code: Element): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (!t.parentElement?.closest(RENDER_ONLY)) out.push(t);
  }
  return out;
}

/** The caret's offset in the code's text, or null if it isn't inside the code text. */
function caretOffset(code: Element, range: Range): number | null {
  const start = range.startContainer;
  if (start instanceof Element && start.closest(RENDER_ONLY)) return null;
  if (start.parentElement?.closest(RENDER_ONLY)) return null;
  if (!code.contains(start) && start !== code) {
    // Caret on the <pre> itself (e.g. offset after the header): treat as start.
    const pre = code.parentElement;
    if (pre && start === pre) return range.startOffset <= 1 ? 0 : null;
    return null;
  }
  const r = document.createRange();
  r.setStart(code, 0);
  r.setEnd(start, range.startOffset);
  const frag = r.cloneContents();
  frag.querySelectorAll(RENDER_ONLY).forEach((e) => e.remove());
  return (frag.textContent ?? '').replace(/​/g, '').length;
}

function codeTextLength(code: Element): number {
  return textNodesOf(code).reduce((n, t) => n + t.data.replace(/​/g, '').length, 0);
}

function placeCaret(code: Element, offset: number): void {
  let remaining = offset;
  const sel = window.getSelection();
  if (!sel) return;
  for (const t of textNodesOf(code)) {
    if (remaining <= t.data.length) {
      sel.collapse(t, remaining);
      return;
    }
    remaining -= t.data.length;
  }
  sel.collapse(code, code.childNodes.length);
}

function placeCaretAtEnd(el: Element): void {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (!t.parentElement?.closest(RENDER_ONLY)) last = t;
  }
  if (last) sel.collapse(last, last.data.length);
  else sel.collapse(el, el.childNodes.length);
}

/** Join `lower` into `upper` (both <pre>): one newline between, caret at the seam. */
function joinCodeBlocks(upper: HTMLElement, lower: HTMLElement): void {
  const upperCode = codeOf(upper);
  const lowerCode = codeOf(lower);
  // Trailing newlines on the upper block would become blank lines at the seam.
  const texts = textNodesOf(upperCode);
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!;
    const trimmed = t.data.replace(/[\n​]+$/, '');
    if (trimmed === t.data) break;
    t.data = trimmed;
    if (trimmed !== '') break;
  }
  const seam = codeTextLength(upperCode);
  upperCode.appendChild(document.createTextNode('\n'));
  for (const child of Array.from(lowerCode.childNodes)) {
    if (child instanceof Element && child.matches(RENDER_ONLY)) continue;
    upperCode.appendChild(child);
  }
  upperCode.normalize();
  const lowerId = lower.id;
  lower.remove();
  placeCaret(upperCode, seam);
  if (lowerId) queueNodeForSave(lowerId, 'delete');
  if (upper.id) queueNodeForSave(upper.id, 'update');
}

/**
 * Returns `true` when it consumed the key (preventDefault already called).
 * Only acts on a collapsed caret inside a <pre>.
 */
export function handleCodeBlockDelete(event: KeyboardEvent, range: Range): boolean {
  if (!range.collapsed || (event.key !== 'Backspace' && event.key !== 'Delete')) return false;
  const host = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const pre = host?.closest('pre') as HTMLElement | null;
  if (!pre) return false;
  const code = codeOf(pre);
  const offset = caretOffset(code, range);
  if (offset === null) return false;

  if (event.key === 'Backspace') {
    if (offset !== 0) return false;
    event.preventDefault();
    const prev = pre.previousElementSibling as HTMLElement | null;
    if (prev && prev.tagName === 'PRE') {
      joinCodeBlocks(prev, pre);
      return true;
    }
    if (codeTextLength(code) === 0) {
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      p.id = pre.id;
      const nodeId = pre.getAttribute('data-node-id');
      if (nodeId) p.setAttribute('data-node-id', nodeId);
      pre.replaceWith(p);
      window.getSelection()?.collapse(p, 0);
      if (p.id) queueNodeForSave(p.id, 'update');
      return true;
    }
    if (prev) placeCaretAtEnd(prev);
    return true;
  }

  // Delete at the very end joins the NEXT code block up.
  if (offset !== codeTextLength(code)) return false;
  const next = pre.nextElementSibling as HTMLElement | null;
  if (next && next.tagName === 'PRE') {
    event.preventDefault();
    joinCodeBlocks(pre, next);
    return true;
  }
  return false;
}
