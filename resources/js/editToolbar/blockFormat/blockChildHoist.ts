/**
 * Hoisting block children out of phrasing-only elements (<p>, <h1>–<h6>).
 *
 * A heading or paragraph may not contain block-level content: converting a
 * node that holds a nested list by copying its innerHTML produced
 * `<h3>Warning<ol>…</ol></h3>`, which survives in the live DOM but collapses
 * to an empty node on its next parse. Worse, every id minted INSIDE such a
 * wrapper sees no numeric siblings, so numbering restarts at "1" — a later
 * list-escape inside the trapped <ol> minted ids 1/101/201 mid-book and the
 * nodes could never be found by the save queue (terms, 2026-10-16).
 *
 * The converted element keeps its inline content; every top-level block child
 * is re-seated as a FOLLOWING SIBLING in document order, with an id bounded by
 * its real neighbours (per the "a node's id is its position" review gate).
 */
import { setElementIds, findNextElementId } from "../../utilities/idHelpers";
import type { BookId } from "../../utilities/idHelpers";
import { PHRASING_ILLEGAL_CHILD_SELECTOR } from "../../utilities/blockElements";

/** Does this element hold content that is illegal inside a <p>/<h*>? */
export function hasIllegalBlockChildren(el: Element): boolean {
  return el.querySelector(PHRASING_ILLEGAL_CHILD_SELECTOR) !== null;
}

/**
 * Move every top-level block child OUT of `el`, inserting each as a following
 * sibling with a freshly minted bounded id. `el` must already sit in the DOM
 * with a valid numeric id. Consecutive bare <li> children are gathered into
 * one <ul> (a bare <li> is legal nowhere outside a list).
 * Returns the hoisted elements — callers are responsible for persisting them.
 */
export function hoistIllegalBlockChildren(
  el: HTMLElement,
  bookId: BookId | null,
): HTMLElement[] {
  const hoisted: HTMLElement[] = [];
  let anchor: HTMLElement = el;
  let openOrphanList: HTMLElement | null = null;

  const blocks = Array.from(el.children).filter((c): c is HTMLElement =>
    c.matches(PHRASING_ILLEGAL_CHILD_SELECTOR)
  );

  for (const block of blocks) {
    if (block.tagName === "LI") {
      if (openOrphanList) {
        // Adjacent orphan <li>s share one synthesized list node.
        block.remove();
        openOrphanList.appendChild(block);
        continue;
      }
      const ul = document.createElement("ul");
      block.remove();
      ul.appendChild(block);
      openOrphanList = ul;
      // Bound captured BEFORE insertion moves anything (id-position gate).
      setElementIds(ul, anchor.id, findNextElementId(anchor), bookId);
      anchor.after(ul);
      anchor = ul;
      hoisted.push(ul);
      continue;
    }

    openOrphanList = null;
    block.remove();
    setElementIds(block, anchor.id, findNextElementId(anchor), bookId);
    anchor.after(block);
    anchor = block;
    hoisted.push(block);
  }

  return hoisted;
}
