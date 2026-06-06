/**
 * Thin wrappers around the temporal version endpoints (nodes_history). Extracted so both the
 * version-history UI (sourceButton.js) and the vibe-convert review use one place.
 *   - loadSnapshots(book)            → GET  /api/books/{book}/snapshots
 *   - restoreBookToTimestamp(book,t) → POST /api/books/{book}/restore  (rebuild nodes at timestamp t)
 */

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content;
}

export async function loadSnapshots(book) {
  const resp = await fetch(`/api/books/${encodeURIComponent(book)}/snapshots`, { credentials: 'include' });
  if (!resp.ok) throw new Error(`snapshots ${resp.status}`);
  const data = await resp.json();
  return data.snapshots || [];
}

export async function restoreBookToTimestamp(book, timestamp) {
  const resp = await fetch(`/api/books/${encodeURIComponent(book)}/restore`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken() },
    body: JSON.stringify({ timestamp }),
  });
  return resp.json();
}
