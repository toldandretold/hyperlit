/**
 * Node Delete Operations Module
 * Handles deletion of individual node records with all associations
 */

import { openDatabase } from '../core/connection.js';
import { parseNodeId } from '../core/utilities.js';

// Dependencies
let withPending, book, updateBookTimestamp, queueForSync;

// Initialization function to inject dependencies
export function initNodeDeleteDependencies(deps) {
  withPending = deps.withPending;
  book = deps.book;
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
}

/**
 * Delete a single IndexedDB record and all its associations
 * Deletes the node chunk plus all associated hyperlights and hypercites
 *
 * @param {string|number} id - Node ID to delete
 * @returns {Promise<boolean>} Success status
 */
export async function deleteIndexedDBRecord(id) {
  return withPending(async () => {
    // Only process numeric IDs
    if (!id || !/^\d+(\.\d+)?$/.test(id)) {
      console.log(`Skipping deletion for non-numeric ID: ${id}`);
      return false;
    }

    // ✅ FIX: Get book ID from DOM — check sub-book container first
    const mainContent = document.querySelector('.main-content');
    const element = document.getElementById(id);
    const subBookFromDom = element?.closest('[data-book-id]');
    const bookId = subBookFromDom?.dataset?.bookId || mainContent?.id || book || "latest";
    const numericId = parseNodeId(id);

    const db = await openDatabase();
    // ✅ CHANGE 1: The transaction now includes all relevant stores.
    const tx = db.transaction(
      ["nodes", "hyperlights", "hypercites"],
      "readwrite"
    );
    const chunksStore = tx.objectStore("nodes");
    const lightsStore = tx.objectStore("hyperlights");
    const citesStore = tx.objectStore("hypercites");
    const key = [bookId, numericId];

    // Collect all records to be deleted for the history log
    const deletedHistoryPayload = {
        nodes: [],
        hyperlights: [],
        hypercites: []
    };

    return new Promise((resolve, reject) => {
      const getRequest = chunksStore.get(key);

      getRequest.onsuccess = () => {
        const recordToDelete = getRequest.result;

        if (recordToDelete) {
          deletedHistoryPayload.nodes.push(recordToDelete); // Add for history

          // Now, delete the main record
          chunksStore.delete(key);

          try {
            // ✅ NEW: Get node_id (UUID) from DOM before deletion
            const deletedElement = document.getElementById(numericId);
            const deletedNodeUUID = deletedElement?.getAttribute('data-node-id');

            // ✅ NEW: Update hyperlights - remove this node from multi-node highlights
            // We need to scan ALL highlights for this book to find ones affecting this node
            const bookIndex = lightsStore.index("book");
            const bookRange = IDBKeyRange.only(bookId);
            const lightReq = bookIndex.openCursor(bookRange);

            let affectedHighlights = 0;

            lightReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                const highlight = cursor.value;

                // Check if this highlight affects the deleted node
                const affectsDeletedNode =
                  highlight.startLine === numericId || // OLD schema check
                  (highlight.node_id && Array.isArray(highlight.node_id) &&
                   deletedNodeUUID && highlight.node_id.includes(deletedNodeUUID)); // NEW schema check

                if (affectsDeletedNode) {
                  affectedHighlights++;

                  // Check if multi-node highlight
                  if (highlight.node_id && highlight.node_id.length > 1) {
                    // Multi-node highlight - mark node for deletion cleanup
                    // ✅ Track deleted node for cleanup during next save
                    if (!highlight._deleted_nodes) {
                      highlight._deleted_nodes = [];
                    }
                    if (deletedNodeUUID && !highlight._deleted_nodes.includes(deletedNodeUUID)) {
                      highlight._deleted_nodes.push(deletedNodeUUID);
                    }

                    // DON'T remove from node_id or charData yet - cleanup happens during update
                    // This prevents losing track of other nodes in multi-node highlights

                    // Save updated highlight
                    cursor.update(highlight);
                  } else {
                    // Single-node highlight - mark as orphaned (might migrate to another node)
                    highlight._orphaned_at = Date.now();
                    highlight._orphaned_from_node = deletedNodeUUID || numericId.toString();

                    // ✅ Track deleted node for cleanup during next save
                    if (!highlight._deleted_nodes) {
                      highlight._deleted_nodes = [];
                    }
                    if (deletedNodeUUID && !highlight._deleted_nodes.includes(deletedNodeUUID)) {
                      highlight._deleted_nodes.push(deletedNodeUUID);
                    }

                    // ✅ KEEP node_id and charData for now - needed for rendering during migration window
                    // They'll be updated when the highlight is recovered in the new node
                    cursor.update(highlight);
                    // Don't add to deletedHistoryPayload yet - might be recovered
                  }
                }

                cursor.continue();
              } else if (affectedHighlights > 0) {
                console.log(`✅ Updated ${affectedHighlights} highlights for deleted node ${numericId}`);
              }
            };

            // ✅ NEW: Update hypercites - same logic
            const citeIndex = citesStore.index("book");
            const citeReq = citeIndex.openCursor(bookRange);

            let affectedHypercites = 0;

            citeReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                const hypercite = cursor.value;

                // Check if this hypercite affects the deleted node
                const affectsDeletedNode =
                  (hypercite.node_id && Array.isArray(hypercite.node_id) &&
                   deletedNodeUUID && hypercite.node_id.includes(deletedNodeUUID));

                if (affectsDeletedNode) {
                  affectedHypercites++;

                  // Check if multi-node hypercite
                  if (hypercite.node_id && hypercite.node_id.length > 1) {
                    // Multi-node hypercite - mark node for deletion cleanup
                    // ✅ Track deleted node for cleanup during next save
                    if (!hypercite._deleted_nodes) {
                      hypercite._deleted_nodes = [];
                    }
                    if (deletedNodeUUID && !hypercite._deleted_nodes.includes(deletedNodeUUID)) {
                      hypercite._deleted_nodes.push(deletedNodeUUID);
                    }

                    // DON'T remove from node_id or charData yet - cleanup happens during update
                    // This prevents losing track of other nodes in multi-node hypercites

                    // Save updated hypercite
                    cursor.update(hypercite);
                  } else {
                    // Single-node hypercite - mark as orphaned (might migrate to another node)
                    hypercite._orphaned_at = Date.now();
                    hypercite._orphaned_from_node = deletedNodeUUID || numericId.toString();

                    // ✅ Track deleted node for cleanup during next save
                    if (!hypercite._deleted_nodes) {
                      hypercite._deleted_nodes = [];
                    }
                    if (deletedNodeUUID && !hypercite._deleted_nodes.includes(deletedNodeUUID)) {
                      hypercite._deleted_nodes.push(deletedNodeUUID);
                    }

                    // ✅ KEEP node_id and charData for now - needed for rendering during migration window
                    // They'll be updated when the hypercite is recovered in the new node
                    cursor.update(hypercite);
                    // Don't add to deletedHistoryPayload yet - might be recovered
                  }
                }

                cursor.continue();
              } else if (affectedHypercites > 0) {
                console.log(`✅ Updated ${affectedHypercites} hypercites for deleted node ${numericId}`);
              }
            };
          } catch (error) {
            console.error(`❌ Error finding associated records for node ${numericId}:`, error);
          }
        }
        // Silently skip if no record found
      };

      getRequest.onerror = (e) => reject(e.target.error);

      tx.oncomplete = async () => {
        await updateBookTimestamp(bookId);

        // Now, queue for sync to PostgreSQL
        deletedHistoryPayload.nodes.forEach((record) => {
          queueForSync("nodes", record.startLine, "delete", record);
        });
        deletedHistoryPayload.hyperlights.forEach((record) => {
          queueForSync("hyperlights", record.hyperlight_id, "delete", record);
        });
        deletedHistoryPayload.hypercites.forEach((record) => {
          queueForSync("hypercites", record.hyperciteId, "delete", record);
        });

        // ✅ Dynamically import toolbar (only exists when editing)
        try {
          const { getEditToolbar } = await import('../../editToolbar/index.js');
          const toolbar = getEditToolbar();
          if (toolbar) {
              await toolbar.updateHistoryButtonStates();
          }
        } catch (e) {
          // Toolbar not loaded (not in edit mode)
        }

        resolve(true);
      };

      tx.onerror = (e) => reject(e.target.error);
    });
  });
}
