// Extracted from divEditor/index.ts's keydown listener — the "no-delete" guard.
// Exactly one node per book carries `no-delete-id="please"` (the invariant that the
// document can never be fully emptied). When the user's Backspace/Delete would clear
// that protected node, the marker must MOVE to a genuinely different node so the
// original can still be deleted; only when it is the LAST content node is the deletion
// refused. Pulled out of the anonymous document-level listener so it is unit-testable.
import { findNextNoDeleteNode, transferNoDeleteMarker } from '../domUtilities';

/**
 * Decide what to do when a Backspace/Delete lands on the `no-delete-id` node.
 * Returns `true` when the caller must `event.preventDefault()` + return (this is the
 * genuine last node). Returns `false` otherwise — not protected, not a full-clear, or
 * the marker was transferred to another node so deletion may proceed.
 */
export function handleNoDeleteGuard(range: Range, elementWithId: Element): boolean {
  // 🚀 O(1) attribute check — not the protected node, nothing to do.
  if (elementWithId.getAttribute('no-delete-id') !== 'please') return false;

  console.log(`🚨 [NO-DELETE] Attempting to delete protected node ${elementWithId.id}`);

  // Only intervene when the edit would clear the entire node.
  const textContent = elementWithId.textContent || '';
  const isSelectingAll = !range.collapsed &&
    range.toString().trim() === textContent.trim();
  const isAtStartAndEmpty = range.collapsed &&
    range.startOffset === 0 &&
    textContent.trim().length <= 1;

  if (!(isSelectingAll || isAtStartAndEmpty)) return false;

  // Try to transfer the marker to a DIFFERENT node (excludeNode skips the current one,
  // which is what let the marker sit on the first node and wrongly refuse deletion).
  const el = elementWithId as HTMLElement;
  const nextNode = findNextNoDeleteNode(null, el);
  if (nextNode && nextNode !== elementWithId) {
    console.log(`🔄 [NO-DELETE] Transferring marker from ${elementWithId.id} to ${nextNode.id}`);
    transferNoDeleteMarker(el, nextNode);
    return false; // marker moved — let the deletion proceed
  }

  // This is the LAST node — refuse deletion (document must never go empty).
  console.log(`🛑 [NO-DELETE] Refusing deletion - this is the last node`);
  return true;
}
