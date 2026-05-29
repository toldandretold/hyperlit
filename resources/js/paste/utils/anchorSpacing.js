/**
 * Ensure an inserted hypercite anchor is followed by whitespace.
 *
 * When a hypercite is pasted as a replacement for selected text, the inserted
 * fragment ends with `</a>` and the visible space between the citation arrow
 * and the next word depends on the surviving text node retaining its leading
 * space. On Safari 26.4 the surviving text node was observed to lose that
 * space between insertion and the next IDB flush, producing a DOM↔IDB integrity
 * mismatch. This helper fills the gap deterministically so correctness no
 * longer depends on browser-specific range behaviour.
 *
 * Idempotent: if the next sibling already starts with whitespace, a word
 * joiner / zero-width marker, or a closing/punctuation character, this is a
 * no-op. If the anchor is the last child of its block, no space is needed.
 *
 * @param {Element} anchor - The just-inserted hypercite anchor element.
 * @returns {boolean} true if the DOM was mutated, false otherwise.
 */
export function ensureSpaceAfterAnchor(anchor) {
  if (!anchor || !anchor.parentNode) return false;
  const next = anchor.nextSibling;
  if (!next) return false;
  if (next.nodeType === Node.TEXT_NODE) {
    const text = next.textContent;
    if (!text) return false;
    if (/^[\s.,;:!?)\]'"`⁠​ ]/.test(text)) return false;
    next.textContent = ' ' + text;
    return true;
  }
  anchor.parentNode.insertBefore(document.createTextNode(' '), next);
  return true;
}
