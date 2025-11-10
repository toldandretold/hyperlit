/**
 * Footnotes PostgreSQL Sync Module
 * Syncs footnote operations from IndexedDB to PostgreSQL
 */

/**
 * Sync footnotes to PostgreSQL
 *
 * @param {string} bookId - Book identifier
 * @param {Array} footnotes - Array of footnote records to sync
 * @returns {Promise<void>}
 */
export async function syncFootnotesToPostgreSQL(bookId, footnotes) {
  if (!footnotes || footnotes.length === 0) {
    console.log("ℹ️ No footnotes to sync");
    return;
  }

  console.log(`🔄 Syncing ${footnotes.length} footnotes to PostgreSQL...`);

  const payload = {
    book: bookId,
    data: footnotes
  };

  const res = await fetch("/api/db/footnotes/upsert", {
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
    console.error("❌ Footnotes sync error:", txt);
    throw new Error(`Footnotes sync failed: ${txt}`);
  }

  const out = await res.json();
  console.log("✅ Footnotes synced:", out);
  return out;
}
