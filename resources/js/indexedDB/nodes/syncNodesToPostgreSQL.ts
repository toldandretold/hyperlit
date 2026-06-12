/**
 * Nodes PostgreSQL Sync Module
 * Syncs node chunk operations from IndexedDB to PostgreSQL
 */

import type { BookId, PublicChunk } from '../types';

interface NodeSyncResult {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

/**
 * Sync node chunks to PostgreSQL
 * NOTE: reports failure as a return VALUE ({success: false}), it does not throw
 * — unlike the footnote/reference endpoint modules.
 */
export async function syncNodeChunksToPostgreSQL(bookId: BookId, nodes: PublicChunk[] = []): Promise<NodeSyncResult> {
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

  const out = await res.json();
  console.log("✅ Nodes synced from nodes object store in IndexedDB to node_chunks table in PostgreSQL:", out);
  return out;
}
