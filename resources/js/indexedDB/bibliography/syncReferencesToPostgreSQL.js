/**
 * References PostgreSQL Sync Module
 * Syncs bibliography/reference operations from IndexedDB to PostgreSQL
 */

/**
 * Sync references/bibliography to PostgreSQL
 *
 * @param {string} bookId - Book identifier
 * @param {Array} references - Array of reference records to sync
 * @returns {Promise<void>}
 */
export async function syncReferencesToPostgreSQL(bookId, references) {
  if (!references || references.length === 0) {
    console.log("ℹ️ No references to sync");
    return;
  }

  console.log(`🔄 Syncing ${references.length} references to PostgreSQL...`);

  const payload = {
    book: bookId,
    data: references
  };

  const res = await fetch("/api/db/references/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.content
    },
    credentials: "include",
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ References sync error:", txt);
    throw new Error(`References sync failed: ${txt}`);
  }

  const out = await res.json();
  console.log("✅ References synced:", out);
  return out;
}
