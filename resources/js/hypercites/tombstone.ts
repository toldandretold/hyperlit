/**
 * Hypercite tombstone DOM helpers.
 *
 * A tombstone is an invisible zero-width `<u id="hypercite_…" class="hypercite-tombstone"
 * data-ghost="true">` left behind when a cited source `<u>` is deleted: it keeps the id
 * navigable (scroll target for citing books) and is the gate the paste handler uses to
 * restore a cut hypercite. Shared by the MutationObserver path (divEditor/domUtilities
 * CHECK 2), the cut handler, and the save-time absence reconciler — all three are
 * idempotent through the existing-element guard here.
 */
import { BLOCK_ELEMENT_SELECTOR } from '../utilities/blockElements';
import { verbose } from '../utilities/logger';

export function createTombstoneElement(hyperciteId: string): HTMLElement {
  const tombstone = document.createElement('u');
  tombstone.id = hyperciteId;
  tombstone.className = 'hypercite-tombstone';
  tombstone.setAttribute('data-ghost', 'true');
  return tombstone;
}

/**
 * Insert a tombstone for `hyperciteId` into the nearest surviving block.
 *
 * - If ANY element with that id is already in the document (live <u>, or a tombstone
 *   another path already created), it is returned untouched — no duplicate.
 * - `preferredHost` is walked up to the nearest block element; if it is detached or
 *   missing, falls back to the last element of its closest `.chunk`.
 * - Returns null when no attached host could be found (caller decides whether the
 *   record-side ghosting still proceeds — it should).
 */
export function insertTombstone(hyperciteId: string, preferredHost: Node | null): HTMLElement | null {
  const existing = document.getElementById(hyperciteId);
  if (existing) return existing;

  const hostElement: Element | null = preferredHost
    ? (preferredHost.nodeType === Node.ELEMENT_NODE
        ? (preferredHost as Element)
        : preferredHost.parentElement)
    : null;

  let insertionParent: Element | null = hostElement;
  if (insertionParent && !insertionParent.matches(BLOCK_ELEMENT_SELECTOR)) {
    insertionParent = insertionParent.closest(BLOCK_ELEMENT_SELECTOR);
  }

  if (!insertionParent || !document.contains(insertionParent)) {
    const chunk = hostElement?.closest('.chunk') ?? null;
    insertionParent = chunk?.lastElementChild ?? null;
  }

  if (!insertionParent || !document.contains(insertionParent)) {
    verbose.content(`No surviving host for tombstone ${hyperciteId}`, '/hypercites/tombstone.ts');
    return null;
  }

  const tombstone = createTombstoneElement(hyperciteId);
  insertionParent.appendChild(tombstone);
  verbose.content(`Tombstone ${hyperciteId} inserted into ${insertionParent.tagName}#${insertionParent.id}`, '/hypercites/tombstone.ts');
  return tombstone;
}
