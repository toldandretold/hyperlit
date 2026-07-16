// scrollAnchor.js — Lightweight scroll position preservation during text reflow
//
// Usage:
//   const anchor = captureScrollAnchor(scrollableParent);
//   // ... change font-size, max-width, toggle class, etc. ...
//   restoreScrollAnchor(scrollableParent, anchor);

import { setNavigatingState } from '../scrolling/index';
import { nextScrollReason } from '../scrolling/scrollTrace';

/**
 * Capture a visual anchor: the first element with an id that is partially
 * or fully visible inside the scrollable container.
 *
 * @param {HTMLElement} scrollableParent - The scrollable container (e.g. .reader-content-wrapper)
 * @returns {{ element: HTMLElement, offsetFromContainer: number } | null}
 */
export function captureScrollAnchor(scrollableParent: any) {
  if (!scrollableParent) return null;

  const containerRect = scrollableParent.getBoundingClientRect();
  const elements = scrollableParent.querySelectorAll('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');

  for (const el of elements) {
    const rect = el.getBoundingClientRect();
    // First element whose bottom edge is below the container's top edge
    // (i.e. at least partially visible)
    if (rect.bottom > containerRect.top) {
      return {
        element: el,
        offsetFromContainer: rect.top - containerRect.top,
      };
    }
  }

  return null;
}

/**
 * After a layout change, correct scrollTop so the anchored element stays
 * at the same visual position it was before the change.
 *
 * @param {HTMLElement} scrollableParent - The scrollable container
 * @param {{ element: HTMLElement, offsetFromContainer: number }} anchor - From captureScrollAnchor
 */
export function restoreScrollAnchor(scrollableParent: any, anchor: any) {
  if (!scrollableParent || !anchor?.element?.isConnected) return;
  // Paginated reading mode: the wrapper is overflow:hidden and vertical drift
  // math is meaningless — the paginator re-anchors horizontally itself. A
  // scrollTop write here would corrupt the page geometry.
  if (scrollableParent.classList?.contains('paginated-active')) return;

  const containerRect = scrollableParent.getBoundingClientRect();
  const currentOffset = anchor.element.getBoundingClientRect().top - containerRect.top;
  const drift = currentOffset - anchor.offsetFromContainer;

  // Only correct if drift is meaningful (avoid sub-pixel jitter)
  if (Math.abs(drift) > 1) {
    // Briefly mark as navigating so the scroll adjustment isn't detected
    // as a user scroll (which would save a wrong position)
    setNavigatingState(true);
    nextScrollReason('anchor-drift');
    scrollableParent.scrollTop += drift;
    // Release after a microtask so the scroll event from the adjustment is swallowed
    requestAnimationFrame(() => {
      setNavigatingState(false);
    });
  }
}
