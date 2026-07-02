/**
 * Hypercites Helper Functions
 * Supporting functions for hypercite operations
 */

import { openDatabase } from '../core/connection';
import { getHyperciteFromIndexedDB } from './read';
import { log } from '../../utilities/logger';
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
    const { getNodesFromIndexedDB } = await import('../nodes/read');
    const localNodes = await getNodesFromIndexedDB(bookId);
    if (localNodes.length > 0) {
      return localHypercite;
    }
    // Nodes not cached — fall through to server fetch
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
      log.error(`Server error: ${response.status} ${response.statusText}`, '/indexedDB/hypercites/helpers.ts');
      return localHypercite || null;
    }

    const data = await response.json();
    const serverHypercite: HyperciteRecord | undefined = data.hypercite;
    const serverNodes: NodeRecord[] | undefined = data.nodes; // Note the plural

    if (!serverHypercite || !serverNodes || serverNodes.length === 0) {
      log.error('Server response was missing hypercite or nodes data from PostgreSQL', '/indexedDB/hypercites/helpers.ts');
      return localHypercite || null;
    }

    // ✅ CACHE BOTH THE HYPERCITE AND ALL THE NODES
    const db = await openDatabase();
    const tx = db.transaction(["hypercites", "nodes"], "readwrite");
    const hypercitesStore = tx.objectStore("hypercites");
    const nodesStore = tx.objectStore("nodes");

    // Put the single hypercite record
    hypercitesStore.put(serverHypercite);

    // Bulk-write all the nodes to nodes object store
    for (const chunk of serverNodes) {
      nodesStore.put(chunk);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Return just the hypercite, as the calling function expects.
    return serverHypercite;

  } catch (error) {
    log.error('Network error while fetching hypercite and book content', '/indexedDB/hypercites/helpers.ts', error);
    return localHypercite || null;
  }
}
