/**
 * Hypercites PostgreSQL Sync Module
 * Syncs hypercite operations from IndexedDB to PostgreSQL
 */

/**
 * Sync hypercites to PostgreSQL
 *
 * @param {Array} hypercites - Array of hypercite records to upsert
 * @returns {Promise<Object>} Sync result
 */
export async function syncHyperciteToPostgreSQL(hypercites) {
  if (!hypercites || hypercites.length === 0) return { success: true };

  // All hypercites in a batch should be from the same book
  const bookId = hypercites[0].book;

  const payload = {
    book: bookId,
    data: hypercites.map(hc => ({
      ...hc,
      hypercitedHTML: `<u id="${hc.hyperciteId}" class="${hc.relationshipStatus}">${hc.hypercitedText}</u>`
    }))
  };

  console.log(`🔄 Syncing ${hypercites.length} hypercites…`);
  console.log('🔍 Payload being sent:', JSON.stringify(payload, null, 2));

  const res = await fetch("/api/db/hypercites/upsert", {
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
    console.error("❌ Hypercite sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ Hypercite synced:", out);
  return out;
}

/**
 * Sync a single hypercite update immediately (bypass queue)
 * Used for critical updates that need immediate persistence
 *
 * @param {string} book - Book identifier
 * @param {string} hyperciteId - Hypercite identifier
 * @param {Object} updatedFields - Fields to update
 * @returns {Promise<Object>} Sync result
 */
export async function syncHyperciteUpdateImmediately(book, hyperciteId, updatedFields) {
  console.log(`🚀 IMMEDIATE sync for hypercite ${hyperciteId}...`);

  const payload = {
    book,
    data: [{
      ...updatedFields,
      hyperciteId,
      book,
      hypercitedHTML: updatedFields.hypercitedHTML || `<u id="${hyperciteId}" class="${updatedFields.relationshipStatus}">${updatedFields.hypercitedText}</u>`
    }]
  };

  const res = await fetch("/api/db/hypercites/upsert", {
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
    console.error("❌ Immediate hypercite sync error:", txt);
    return { success: false, message: txt };
  }

  const out = await res.json();
  console.log("✅ Immediate hypercite sync completed:", out);
  return out;
}
