/**
 * Selection scanning for "special" inline elements — source hypercite <u> tags,
 * hypercite citation anchors, and footnote sups — that need protection or
 * bookkeeping when the selection containing them is destroyed.
 *
 * Extracted from SelectionDeletionHandler.checkForSpecialElements so the cut
 * handler (cutHandler.ts) and the Delete/Backspace guard share ONE scan.
 */

const SEARCH_ROOT_SELECTOR =
  'p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id], .main-content, [data-book-id]';

export interface SpecialElementsInRange {
  /** Source hypercite <u id="hypercite_…"> wrappers (tombstones excluded). */
  sourceHypercites: HTMLElement[];
  /** Citation anchors <a href="…#hypercite_…"> pointing at a source hypercite. */
  hyperciteAnchors: HTMLAnchorElement[];
  /** Footnote reference sups (sup[fn-count-id]). */
  footnotes: HTMLElement[];
}

/** True when `range` intersects the contents of `node`. */
export function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    return range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0 &&
           nodeRange.compareBoundaryPoints(Range.END_TO_START, range) <= 0;
  } catch {
    return false;
  }
}

/**
 * Find every special element intersecting `range`. Returns null when the range
 * has no scannable root (e.g. selection outside any content container).
 */
export function findSpecialElementsInRange(range: Range): SpecialElementsInRange | null {
  const common = range.commonAncestorContainer;
  const root: Element | null = common.nodeType === Node.TEXT_NODE
    ? common.parentElement
    : (common as Element);
  const searchRoot = root?.closest(SEARCH_ROOT_SELECTOR) || root;
  if (!searchRoot || typeof searchRoot.querySelectorAll !== 'function') return null;

  const sourceHypercites: HTMLElement[] = [];
  for (const el of searchRoot.querySelectorAll<HTMLElement>('u[id^="hypercite_"]')) {
    if (el.classList.contains('hypercite-tombstone')) continue;
    if (rangeIntersectsNode(range, el)) sourceHypercites.push(el);
  }

  const hyperciteAnchors: HTMLAnchorElement[] = [];
  for (const el of searchRoot.querySelectorAll<HTMLAnchorElement>('a[href*="#hypercite_"]')) {
    if (rangeIntersectsNode(range, el)) hyperciteAnchors.push(el);
  }

  const footnotes: HTMLElement[] = [];
  for (const el of searchRoot.querySelectorAll<HTMLElement>('sup[fn-count-id]')) {
    if (rangeIntersectsNode(range, el)) footnotes.push(el);
  }

  return { sourceHypercites, hyperciteAnchors, footnotes };
}
