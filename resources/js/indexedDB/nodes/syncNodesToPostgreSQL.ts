/**
 * Nodes PostgreSQL Sync Module
 * Syncs node operations from IndexedDB to PostgreSQL
 */

import type { BookId, PublicNode } from '../types';
// E2EE seam (docs/e2ee.md): cheap sync flag check; transform loads on demand.
import { isBookEncrypted } from '../../e2ee/registry';

/**
 * Response shape of POST /api/db/nodes/targeted-upsert.
 * Matches DbNodeController::targetedUpsert exactly:
 *   200 { success: true,  message: 'Nodes updated successfully (targeted)' }
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
 * Sync nodes to PostgreSQL
 * NOTE: reports failure as a return VALUE ({success: false}), it does not throw
 * — unlike the footnote/reference endpoint modules.
 */
export async function syncNodesToPostgreSQL(bookId: BookId, nodes: PublicNode[] = []): Promise<NodeSyncResult> {
  if (!nodes.length) {
    console.log("ℹ️ Sync nodes from nodes object store in IndexedDB to node_chunks table in PostgreSQL: nothing to sync");
    return { success: true };
  }

  // E2EE seam: encrypted books leave the client as ciphertext. Throws
  // VaultLockedError when locked — callers treat it like any sync failure.
  const wireNodes = isBookEncrypted(bookId)
    ? await (await import('../../e2ee/transform')).encryptNodes(bookId, nodes)
    : nodes;

  // ✅ SIMPLIFIED: Just send the data - auth is handled by middleware
  const payload = {
    book: bookId,
    data: wireNodes
  };

  const res = await fetch("/api/db/nodes/targeted-upsert", {
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
