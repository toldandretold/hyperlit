/**
 * Highlights PostgreSQL Sync Module
 * Syncs highlight operations from IndexedDB to PostgreSQL
 */

/**
 * Sync highlight upserts to PostgreSQL
 *
 * @param {Array} hyperlights - Array of hyperlight records to upsert
 * @returns {Promise<void>}
 */
export async function syncHyperlightToPostgreSQL(hyperlights) {
  if (!hyperlights || hyperlights.length === 0) return;
  const bookId = hyperlights[0].book;

  console.log(`🔄 Syncing ${hyperlights.length} hyperlight upserts...`);
  const res = await fetch("/api/db/hyperlights/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-TOKEN":
        document.querySelector('meta[name="csrf-token"]')?.content,
    },
    credentials: "include",
    body: JSON.stringify({
      book: bookId,
      data: hyperlights,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Hyperlight sync failed (${res.status}): ${await res.text()}`
    );
  }
  console.log("✅ Hyperlights synced");
}

/**
 * Sync hyperlight deletions to PostgreSQL
 * Handles both delete and hide operations
 *
 * @param {Array} deletedHyperlights - Array of deleted/hidden highlight records
 * @returns {Promise<void>}
 */
export async function syncHyperlightDeletionsToPostgreSQL(deletedHyperlights) {
  if (!deletedHyperlights || deletedHyperlights.length === 0) return;
  const bookId = deletedHyperlights[0].book;

  // Separate hide operations from delete operations
  const deleteOperations = deletedHyperlights.filter(h => h._action === "delete");
  const hideOperations = deletedHyperlights.filter(h => h._action === "hide");

  console.log(`🔄 Syncing ${deleteOperations.length} hyperlight deletions and ${hideOperations.length} hide operations...`);

  // Send delete operations
  if (deleteOperations.length > 0) {
    const deleteRes = await fetch("/api/db/hyperlights/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.content,
      },
      credentials: "include",
      body: JSON.stringify({
        book: bookId,
        data: deleteOperations.map(h => ({ book: h.book, hyperlight_id: h.hyperlight_id })),
      }),
    });

    if (!deleteRes.ok) {
      throw new Error(`Hyperlight deletion sync failed (${deleteRes.status}): ${await deleteRes.text()}`);
    }
    console.log(`✅ ${deleteOperations.length} hyperlight deletions synced`);
  }

  // Send hide operations
  if (hideOperations.length > 0) {
    const hideRes = await fetch("/api/db/hyperlights/hide", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.content,
      },
      credentials: "include",
      body: JSON.stringify({
        book: bookId,
        data: hideOperations.map(h => ({ book: h.book, hyperlight_id: h.hyperlight_id })),
      }),
    });

    if (!hideRes.ok) {
      throw new Error(`Hyperlight hide sync failed (${hideRes.status}): ${await hideRes.text()}`);
    }
    console.log(`✅ ${hideOperations.length} hyperlight hide operations synced`);
  }
}
