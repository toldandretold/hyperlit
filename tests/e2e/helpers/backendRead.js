/**
 * Backend read-back helpers — assert what actually reached Postgres.
 *
 * These run the GET via `page.evaluate(fetch …)` (NOT `page.request`) ON PURPOSE:
 * the read endpoints authorise via Sanctum **stateful** session auth, which 401s
 * unless the request carries a matching Origin/Referer + session cookie. An in-page
 * fetch inherits the app's exact session + Origin automatically; `page.request` does
 * not send an Origin by default (see MEMORY: sanctum-stateful-needs-origin-header).
 *
 * Each helper returns `{ ok, status, body }`. The controller 404s with
 * `{ error, book_id }` when a book has no rows yet — callers distinguish "synced"
 * (200 + rows) from "not there" (404) without a thrown error.
 *
 * Response shapes (DatabaseToIndexedDBController):
 *   /books/{id}/data        → { nodes:[{book,chunk_id,startLine,node_id,content,…}],
 *                               footnotes, hyperlights, hypercites, library, metadata:{
 *                               total_hyperlights, total_hypercites, total_footnotes, …} }
 *   /books/{id}/annotations → { hyperlights:[…], hypercites:[…],
 *                               metadata:{ total_hyperlights, total_hypercites } }
 *   /books/{id}/library     → library row
 *   /books/{parent}/{sub}/data → sub-book node data (same node shape)
 */

async function getJson(page, url) {
  return page.evaluate(async (u) => {
    try {
      const res = await fetch(u, { headers: { Accept: 'application/json' } });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: { error: String(e && e.message || e) } };
    }
  }, url);
}

const base = (bookId) => `/api/database-to-indexeddb/books/${bookId}`;

/** Full book data (nodes + footnotes + annotations + library + metadata). */
export function readBookData(page, bookId) {
  return getJson(page, `${base(bookId)}/data`);
}

/** Just the annotations (hyperlights + hypercites + counts). */
export function readAnnotations(page, bookId) {
  return getJson(page, `${base(bookId)}/annotations`);
}

/** Just the library row for a (sub-)book. */
export function readLibrary(page, bookId) {
  return getJson(page, `${base(bookId)}/library`);
}

/**
 * Sub-book node data. `subBookId` is the FULL id (e.g. `book_123/Fn456`); we split
 * it at the FIRST slash into parentBook + subId, exactly like the app's own loader
 * (emergencyBackup.ts:136, backgroundDownload.ts:214).
 */
export function readSubBookData(page, subBookId) {
  const slashIdx = String(subBookId).indexOf('/');
  if (slashIdx < 0) {
    // Not actually a sub-book id — fall back to the plain book-data route.
    return readBookData(page, subBookId);
  }
  const parentBook = String(subBookId).substring(0, slashIdx);
  const subId = String(subBookId).substring(slashIdx + 1);
  return getJson(page, `/api/database-to-indexeddb/books/${parentBook}/${subId}/data`);
}
