/**
 * listItemCaret.js — zero-import leaf
 *
 * Fixes a Chrome/WebKit quirk: with `list-style-position: inside` (the list
 * style this app uses — see `li`/`ol` rules in resources/css/app.css), a caret
 * placed at element-offset 0 of an EMPTY <li> renders to the LEFT of the
 * bullet/number instead of after it. An empty <li> (even one holding only a
 * <br> placeholder) has no text node for the caret to anchor to, so the browser
 * draws it before the marker — the "cursor sits to the left of the dot/digit"
 * symptom. As soon as a real character exists the caret renders correctly.
 *
 * The fix is to give the caret a real (zero-width) character to sit after: a
 * zero-width-space text node. This is the same trick the editor already uses
 * for shift+enter (resources/js/divEditor/enterKeyHandler.js) and is
 * integrity-safe — the integrity verifier strips ​ from both sides before
 * comparing (resources/js/integrity/verifier), and the conversion/save paths
 * never treat ​ as meaningful content.
 *
 * Kept as a zero-import leaf so both the toolbar (editToolbar/toolbarDOMUtils)
 * and the divEditor (divEditor/enterKeyHandler) can import it without risking
 * the circular-import TDZ issues that bite this module graph.
 */

const ZWSP = "​";

/**
 * Returns true when the list item has no real text the caret could anchor to
 * (treats a lone <br> placeholder or stray zero-width spaces as "empty").
 * @param {HTMLElement} li
 * @returns {boolean}
 */
export function listItemIsEmpty(li: any) {
  if (!li) return false;
  return (li.textContent || "").replace(/​/g, "").trim() === "";
}

/**
 * Place the caret at the END of a list item's content (after its last text
 * node, so it renders correctly under list-style-position: inside — never at
 * element-offset 0, which sits left of the marker). Falls back to the empty
 * anchor when the item has no text node.
 * @param {HTMLElement} li - the <li> element
 * @param {Selection} [selection] - optional selection (defaults to window.getSelection())
 */
export function placeCaretAtEndOfListItem(li: any, selection: any = null) {
  if (!li) return;
  if (listItemIsEmpty(li)) {
    placeCaretInEmptyListItem(li, selection);
    return;
  }
  const sel: any = selection || window.getSelection();
  const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, null);
  let lastText: any = null;
  while (walker.nextNode()) lastText = walker.currentNode;

  const range = document.createRange();
  if (lastText) {
    range.setStart(lastText, lastText.textContent.length);
  } else {
    range.selectNodeContents(li);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Place the caret inside an empty list item so it renders AFTER the marker.
 * Clears any <br>/zero-width placeholder, inserts a single ZWSP text node, and
 * collapses the caret just after it. No-op-ish for non-empty items: if the item
 * already has text, the caller should use the normal text-offset cursor logic
 * instead — this only handles the empty case.
 * @param {HTMLElement} li - the <li> element
 * @param {Selection} [selection] - optional selection (defaults to window.getSelection())
 */
export function placeCaretInEmptyListItem(li: any, selection: any = null) {
  if (!li) return;
  const sel: any = selection || window.getSelection();

  // Replace any placeholder (<br> or stray ZWSP) with a single ZWSP anchor.
  li.innerHTML = "";
  const anchor = document.createTextNode(ZWSP);
  li.appendChild(anchor);

  const range = document.createRange();
  range.setStart(anchor, 1); // after the zero-width space → right of the marker
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
