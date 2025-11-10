/**
 * Nodes PostgreSQL Sync Module
 * Syncs node chunk operations from IndexedDB to PostgreSQL
 */

/**
 * Sync node chunks to PostgreSQL
 *
 * @param {string} bookId - Book identifier
 * @param {Array} nodeChunks - Array of node chunk records to sync
 * @returns {Promise<Object>} Sync result
 */
export async function syncNodeChunksToPostgreSQL(bookId, nodeChunks = []) {
  if (!nodeChunks.length) {
    console.log("ℹ️ Sync nodes from nodeChunks object store in IndexedDB to node_chunks table in PostgreSQL: nothing to sync");
    return { success: true };
  }

  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: bookId,
    data: nodeChunks
  };

  const res = await fetch("/api/db/node-chunks/targeted-upsert", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "Accept":          "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include", // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Error syncing nodes from nodeChunks object store in IndexedDB to node_chunks table in PostgreSQL:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ Nodes synced from nodeChunks object store in IndexedDB to node_chunks table in PostgreSQL:", out);
  return out;
}

