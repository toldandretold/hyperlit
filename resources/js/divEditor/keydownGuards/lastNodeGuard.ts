// The "book can never end up with zero nodes" invariant, enforced at the
// delete boundary with a runtime check — the replacement for the retired
// `no-delete-id="please"` marker system, which stored app state inside user
// content (permanent local-vs-server drift), only guarded this one pathway,
// and leaked markers across books because its lookups were document-wide.
//
// Cost note (why the marker existed): an earlier implementation counted every
// node in the document on EVERY keydown, which was O(n) per keystroke and
// slow. This guard is not that: it bails instantly for non-content targets and
// for mid-node edits, and only when a keypress would clear an entire node does
// it count — scoped to the target's own book root, over the windowed DOM
// (a few hundred elements at most), with an early exit at the second hit.
import { isLineId } from '../../utilities/idHelpers';

/**
 * Decide what to do when a Backspace/Delete would clear an entire content
 * node. Returns `true` when the caller must `event.preventDefault()` + return:
 * the target is the LAST content node of its book, and instead of letting the
 * browser destroy it this guard has already emptied it in place (`<br>` body,
 * caret seated inside) — "delete everything" visibly works, but the book keeps
 * one editable node and can never hit the fatal empty-book state. Returns
 * `false` otherwise — not a content node, not a full-clear edit, or siblings
 * exist so normal deletion may proceed.
 */
export function handleLastNodeGuard(range: Range, elementWithId: Element): boolean {
  // Only positional content nodes are guarded (sentinels, hypercite anchors,
  // footnote sups etc. are never "the last node of the book").
  if (!isLineId(elementWithId.id)) return false;

  // Only intervene when the edit would clear the entire node — mid-node
  // backspacing is none of our business.
  const textContent = elementWithId.textContent || '';
  const isSelectingAll = !range.collapsed &&
    range.toString().trim() === textContent.trim();
  const isAtStartAndEmpty = range.collapsed &&
    range.startOffset === 0 &&
    textContent.trim().length <= 1;
  if (!(isSelectingAll || isAtStartAndEmpty)) return false;

  // Scope to the target's own book: a sub-book's last node is guarded even
  // though the main book has plenty, and vice versa. (Sub-book containers are
  // siblings of .main-content in the reader layout; the closest() exclusion
  // below is belt-and-braces in case one is ever nested.)
  const bookRoot =
    elementWithId.closest('.sub-book-content[data-book-id]') ||
    document.querySelector('.main-content');
  if (!bookRoot) return false;

  const isMainRoot = !bookRoot.classList.contains('sub-book-content');
  let contentNodes = 0;
  for (const el of bookRoot.querySelectorAll('.chunk [id]')) {
    if (isMainRoot && el.closest('.sub-book-content')) continue;
    if (!isLineId(el.id)) continue;
    contentNodes++;
    if (contentNodes >= 2) return false; // siblings exist — normal delete
  }

  // Last content node of this book: keep the ELEMENT, clear the CONTENT. The
  // <br> body matches the seed shape new books use, so the caret has a home
  // and the node keeps rendering with height. The divEditor MutationObserver
  // sees this programmatic mutation and queues the save through the normal
  // ingestion path — no hand-queuing here.
  elementWithId.innerHTML = '<br>';
  const selection = window.getSelection();
  if (selection) {
    const r = document.createRange();
    r.selectNodeContents(elementWithId);
    r.collapse(true);
    selection.removeAllRanges();
    selection.addRange(r);
  }
  return true;
}
