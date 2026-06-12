/**
 * Footnotes PostgreSQL Sync Module
 * Syncs footnote operations from IndexedDB to PostgreSQL
 */

import type { BookId, FootnoteRecord } from '../types';

/**
 * Sync footnotes to PostgreSQL
 * @throws on a non-OK response
 */
export async function syncFootnotesToPostgreSQL(
  bookId: BookId,
  footnotes: FootnoteRecord[],
): Promise<Record<string, unknown> | undefined> {
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
      "X-CSRF-TOKEN": document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? ''
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
