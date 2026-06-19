/**
 * Nodes PostgreSQL Sync Module
 * Syncs node chunk operations from IndexedDB to PostgreSQL
 */

import type { BookId, PublicNode } from '../types';

/**
 * Response shape of POST /api/db/node-chunks/targeted-upsert.
 * Matches DbNodeChunkController::targetedUpsert exactly:
 *   200 { success: true,  message: 'Node chunks updated successfully (targeted)' }
 *   422 { success: false, message: 'Invalid data format' }
 *   500 { success: false, message: 'Failed to sync data (targeted)', error: <string> }
 */
interface NodeSyncResult {
  success: boolean;
  message?: string;
  /** Only present on a server-side (500) failure. */
  error?: string;
}

/**
 * Sync node chunks to PostgreSQL
 * NOTE: reports failure as a return VALUE ({success: false}), it does not throw
 * — unlike the footnote/reference endpoint modules.
 */
export async function syncNodeChunksToPostgreSQL(bookId: BookId, nodes: PublicNode[] = []): Promise<NodeSyncResult> {
  if (!nodes.length) {
    console.log("ℹ️ Sync nodes from nodes object store in IndexedDB to node_chunks table in PostgreSQL: nothing to sync");
    return { success: true };
  }

  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: bookId,
    data: nodes
  };

  const res = await fetch("/api/db/node-chunks/targeted-upsert", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "Accept":          "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN":
        document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? ''
    },
    credentials: "include", // ← ensures cookies are sent
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ Error syncing nodes from nodes object store in IndexedDB to node_chunks table in PostgreSQL:", txt);
    return { success: false, message: txt };
  }

  // res.json() is typed `any` — pin it to the characterized response shape so the
  // any doesn't silently flow out as the (declared) NodeSyncResult return.
  const out = await res.json() as NodeSyncResult;
  console.log("✅ Nodes synced from nodes object store in IndexedDB to node_chunks table in PostgreSQL:", out);
  return out;
}
