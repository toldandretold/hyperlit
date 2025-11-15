/**
 * Hypercites Helper Functions
 * Supporting functions for hypercite operations
 */

import { openDatabase } from '../core/connection.js';
import { getHyperciteFromIndexedDB } from './index.js';

/**
 * Resolve a hypercite from local IndexedDB or fetch from server
 * Ensures hypercite exists before performing operations
 *
 * @param {string} bookId - Book identifier
 * @param {string} hyperciteId - Hypercite identifier
 * @returns {Promise<Object|null>} Hypercite record or null if not found
 */
export async function resolveHypercite(bookId, hyperciteId) {
  // Path 1: Check local IndexedDB first
  const localHypercite = await getHyperciteFromIndexedDB(bookId, hyperciteId);
  if (localHypercite) {
    console.log("✅ Resolved hypercite from local IndexedDB.");
    return localHypercite;
  }

  // Path 2: If not found locally, check the server
  console.log(
    "🤔 Hypercite not in local DB. Fetching hypercite and its entire parent book...",
  );
  try {
    const response = await fetch(
      `/api/db/hypercites/find/${bookId}/${hyperciteId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN":
            document.querySelector('meta[name="csrf-token"]')?.content || "",
        },
        credentials: "include",
      }
    );

    if (!response.ok) {
      console.error(`❌ Server error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    const serverHypercite = data.hypercite;
    const serverNodeChunks = data.nodes; // Note the plural

    if (!serverHypercite || !serverNodeChunks || serverNodeChunks.length === 0) {
      console.error("❌ Server response was missing hypercite or nodes data from PostgreSQL.");
      return null;
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

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    console.log("✅ Successfully cached hypercite and nodes into IndexedDB object stores.");

    // Return just the hypercite, as the calling function expects.
    return serverHypercite;

  } catch (error) {
    console.error("❌ Network error while fetching hypercite and book content:", error);
    return null;
  }
}
