/**
 * Highlights PostgreSQL Sync Module
 * Syncs highlight operations from IndexedDB to PostgreSQL
 */

import type { HyperlightRecord } from '../types';

type DeletedHyperlight = Partial<HyperlightRecord> & {
  book: string;
  hyperlight_id: string;
  _action?: 'delete' | 'hide';
};

function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
}

/**
 * Sync highlight upserts to PostgreSQL
 * (book is taken from the FIRST record — callers group per book upstream)
 * @throws on a non-OK response
 */
export async function syncHyperlightToPostgreSQL(hyperlights: HyperlightRecord[]): Promise<void> {
  if (!hyperlights || hyperlights.length === 0) return;
  const bookId = hyperlights[0]!.book;

  console.log(`🔄 Syncing ${hyperlights.length} hyperlight upserts...`);
  const res = await fetch("/api/db/hyperlights/upsert", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-TOKEN": csrfToken(),
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
 * Handles both delete and hide operations (separate endpoints);
 * payloads carry ONLY {book, hyperlight_id}.
 * @throws on a non-OK response
 */
export async function syncHyperlightDeletionsToPostgreSQL(deletedHyperlights: DeletedHyperlight[]): Promise<void> {
  if (!deletedHyperlights || deletedHyperlights.length === 0) return;
  const bookId = deletedHyperlights[0]!.book;

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
        "X-CSRF-TOKEN": csrfToken(),
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
        "X-CSRF-TOKEN": csrfToken(),
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
