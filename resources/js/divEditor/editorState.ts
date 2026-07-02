/**
 * editorState — shared editor state + the SaveQueue enqueue API.
 *
 * Extracted from index.js to BREAK the index ↔ handler circular import. The
 * handlers (chunkMutationHandler / enterKeyHandler / supTagHandler) need
 * `movedNodesByOverflow` and `queueNodeForSave` / `queueNodeForDeletion`, which
 * used to live in the index barrel — importing them from index created a cycle
 * (and a load-order TDZ class, see the saveQueue↔index debounce fix).
 *
 * This is a LEAF for the cycle: it imports nothing that statically loops back to
 * divEditor (IDfunctions' only divEditor reference is a dynamic import; the
 * SaveQueue import is type-only and erased), so both index AND the handlers can
 * import from here without re-forming the cycle.
 */
import { NUMERICAL_ID_PATTERN, asLineId, type BookId } from '../utilities/idHelpers';
import { glowCloudOrange } from '../components/cloudRef/editIndicator';
import type { SaveQueue } from './saveQueue';

/** Nodes relocated during chunk-overflow handling; consumed by chunkMutationHandler. */
export const movedNodesByOverflow = new Set<string>();

/**
 * The active SaveQueue instance. index.js wires it in via setActiveSaveQueue()
 * when it starts/stops observing, so the enqueue API below delegates to the
 * same instance index.js holds.
 */
let saveQueue: SaveQueue | null = null;
export function setActiveSaveQueue(sq: SaveQueue | null): void { saveQueue = sq; }
export function getActiveSaveQueue(): SaveQueue | null { return saveQueue; }

export function queueNodeForSave(IDnumerical: string, action: string = 'update', bookId: BookId | null = null): void {
  // Only numeric (or decimal) startLine ids are real content nodes / DB rows.
  // Inline markers — footnote-refs (`Fn…`), hypercites (`hypercite_…`) — live INSIDE
  // their parent node's HTML and are persisted when that parent is saved; they must
  // never be queued by their own id. If one slips through (e.g. an attribute mutation
  // on a `<sup class="footnote-ref">` while typing), batch.ts rejects it as an invalid
  // node id and escalates it to a scary `batch-invalid-id` integrity report — even
  // though nothing is wrong. Drop it quietly here, at the single enqueue chokepoint.
  if (!NUMERICAL_ID_PATTERN.test(String(IDnumerical))) {
    return;
  }
  if (!saveQueue) {
    console.warn('⚠️ SaveQueue not initialized, cannot queue node', IDnumerical);
    return;
  }
  glowCloudOrange();
  // Branded here: this is the validated chokepoint (the guard above guarantees a numerical id).
  saveQueue.queueNode(asLineId(IDnumerical), action, bookId);
}

export function queueNodeForDeletion(IDnumerical: string, nodeElement: HTMLElement | null = null, bookId: BookId | null = null): void {
  if (!saveQueue) {
    console.warn('⚠️ SaveQueue not initialized, cannot queue deletion', IDnumerical);
    return;
  }
  glowCloudOrange();
  saveQueue.queueDeletion(asLineId(IDnumerical), nodeElement, bookId);
}
