/**
 * Pure helper for choosing which node records to put in a sync payload after
 * re-reading them from IndexedDB.
 *
 * Lives in its own module (no IndexedDB / editor imports) so it can be unit-tested
 * without dragging in the rest of the app.
 *
 * getNodesByDataNodeIDs uses a node_id index — when the same node_id exists in both
 * parent and sub-book it may return whichever primary key sorts first. We must drop
 * foreign-book rows before substituting fresh data. If nothing matches the current
 * book, fall back to the original sync payload rather than wiping it out.
 *
 * Unit tests: tests/javascript/indexedDB/master.test.js
 */
export function filterFreshNodesForBook(freshNodes, fallbackNodes, bookId) {
  const correctFreshNodes = freshNodes.filter(n => n.book === bookId);
  return correctFreshNodes.length > 0 ? correctFreshNodes : fallbackNodes;
}
