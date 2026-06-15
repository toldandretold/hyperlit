/**
 * Hypercites Helper Functions
 * Supporting functions for hypercite operations
 */

import { openDatabase } from '../core/connection';
import { getHyperciteFromIndexedDB } from './read';
import type { BookId, HyperciteRecord, NodeRecord } from '../types';

/**
 * Resolve a hypercite from local IndexedDB or fetch from server
 * Ensures hypercite exists before performing operations.
 * A local hit only counts when the book's nodes are cached too — otherwise
 * the server fetch caches BOTH the hypercite and the whole parent book.
 */
export async function resolveHypercite(bookId: BookId, hyperciteId: string): Promise<HyperciteRecord | null> {
  // Path 1: Check local IndexedDB first
  const localHypercite = await getHyperciteFromIndexedDB(bookId, hyperciteId);

  if (localHypercite) {
    // Also verify nodes are cached for this book
    const { getNodeChunksFromIndexedDB } = await import('../nodes/read');
    const localNodes = await getNodeChunksFromIndexedDB(bookId);
    if (localNodes.length > 0) {
      console.log("✅ Resolved hypercite from local IndexedDB.");
      return localHypercite;
    }
    // Nodes not cached — fall through to server fetch
    console.log("⚠️ Hypercite in local IndexedDB but nodes not cached. Fetching from server...");
  } else {
    console.log(
      "🤔 Hypercite not in local DB. Fetching hypercite and its entire parent book...",
    );
  }
  try {
    const response = await fetch(
      `/api/db/hypercites/find/${bookId}/${hyperciteId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN":
            document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content || "",
        },
        credentials: "include",
      }
    );

    if (!response.ok) {
      console.error(`❌ Server error: ${response.status} ${response.statusText}`);
      return localHypercite || null;
    }

    const data = await response.json();
    const serverHypercite: HyperciteRecord | undefined = data.hypercite;
    const serverNodeChunks: NodeRecord[] | undefined = data.nodes; // Note the plural

    if (!serverHypercite || !serverNodeChunks || serverNodeChunks.length === 0) {
      console.error("❌ Server response was missing hypercite or nodes data from PostgreSQL.");
      return localHypercite || null;
    }

    console.log(`✅ Resolved hypercite and ${serverNodeChunks.length} nodes from node_chunks table in PostgreSQL. Caching all to IndexedDB...`);

    // ✅ CACHE BOTH THE HYPERCITE AND ALL THE NODES
    const db = await openDatabase();
    const tx = db.transaction(["hypercites", "nodes"], "readwrite");
    const hypercitesStore = tx.objectStore("hypercites");
    const nodesStore = tx.objectStore("nodes");

    // Put the single hypercite record
    hypercitesStore.put(serverHypercite);

    // Bulk-write all the nodes to nodes object store
    for (const chunk of serverNodeChunks) {
      nodesStore.put(chunk);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    console.log("✅ Successfully cached hypercite and nodes into IndexedDB object stores.");

    // Return just the hypercite, as the calling function expects.
    return serverHypercite;

  } catch (error) {
    console.error("❌ Network error while fetching hypercite and book content:", error);
    return localHypercite || null;
  }
}
