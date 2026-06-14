/**
 * Node Delete Operations Module
 * Handles deletion of individual node records with all associations
 */

import { openDatabase } from '../core/connection';
import { parseNodeId } from '../core/utilities';
import type { BookId, HyperciteRecord, HyperlightRecord, NodeRecord, QueueForSyncFn } from '../types';

interface DeleteDeps {
  withPending: <T>(fn: () => Promise<T>) => Promise<T>;
  book: BookId | null | undefined;
  updateBookTimestamp: (bookId: BookId) => Promise<unknown>;
  queueForSync: QueueForSyncFn;
}

// Injected dependencies (crash-if-uninitialized, same as the pre-TS module)
let withPending: DeleteDeps['withPending'];
let book: DeleteDeps['book'];
let updateBookTimestamp: DeleteDeps['updateBookTimestamp'];
let queueForSync: DeleteDeps['queueForSync'];

// Initialization function to inject dependencies
export function initNodeDeleteDependencies(deps: DeleteDeps): void {
  withPending = deps.withPending;
  book = deps.book;
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
}

/**
 * Delete a single IndexedDB record and all its associations
 * Deletes the node chunk plus all associated hyperlights and hypercites
 *
 * @returns Success status (false for non-numeric ids)
 */
export async function deleteIndexedDBRecord(id: string | number): Promise<boolean> {
  return withPending(async () => {
    // Only process numeric IDs
    if (!id || !/^\d+(\.\d+)?$/.test(String(id))) {
      console.log(`Skipping deletion for non-numeric ID: ${id}`);
      return false;
    }

    // ✅ FIX: Get book ID from DOM — check sub-book container first
    const mainContent = document.querySelector('.main-content');
    const element = document.getElementById(String(id));
    const subBookFromDom = element?.closest('[data-book-id]') as HTMLElement | null | undefined;
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
    const deletedHistoryPayload: {
      nodes: NodeRecord[];
      hyperlights: HyperlightRecord[];
      hypercites: HyperciteRecord[];
    } = {
        nodes: [],
        hyperlights: [],
        hypercites: []
    };

    return new Promise<boolean>((resolve, reject) => {
      const getRequest = chunksStore.get(key);

      getRequest.onsuccess = () => {
        const recordToDelete = getRequest.result as NodeRecord | undefined;

        if (recordToDelete) {
          deletedHistoryPayload.nodes.push(recordToDelete); // Add for history

          // Now, delete the main record
          chunksStore.delete(key);

          try {
            // ✅ NEW: Get data-node-id from DOM before deletion
            const deletedElement = document.getElementById(String(numericId));
            const deletedDataNodeID = deletedElement?.getAttribute('data-node-id');

            // ✅ NEW: Update hyperlights - remove this node from multi-node highlights
            // We need to scan ALL highlights for this book to find ones affecting this node
            const bookIndex = lightsStore.index("book");
            const bookRange = IDBKeyRange.only(bookId);
            const lightReq = bookIndex.openCursor(bookRange);

            let affectedHighlights = 0;

            lightReq.onsuccess = () => {
              const cursor = lightReq.result;
              if (cursor) {
                const highlight = cursor.value as HyperlightRecord;

                // Check if this highlight affects the deleted node
                const affectsDeletedNode =
                  highlight.startLine === numericId || // OLD schema check
                  (highlight.node_id && Array.isArray(highlight.node_id) &&
                   deletedDataNodeID && highlight.node_id.includes(deletedDataNodeID)); // NEW schema check

                if (affectsDeletedNode) {
                  affectedHighlights++;

                  // Check if multi-node highlight
                  if (highlight.node_id && highlight.node_id.length > 1) {
                    // Multi-node highlight - mark node for deletion cleanup
                    // ✅ Track deleted node for cleanup during next save
                    if (!highlight._deleted_nodes) {
                      highlight._deleted_nodes = [];
                    }
                    if (deletedDataNodeID && !highlight._deleted_nodes.includes(deletedDataNodeID)) {
                      highlight._deleted_nodes.push(deletedDataNodeID);
                    }

                    // DON'T remove from node_id or charData yet - cleanup happens during update
                    // This prevents losing track of other nodes in multi-node highlights

                    // Save updated highlight
                    cursor.update(highlight);
                  } else {
                    // Single-node highlight - mark as orphaned (might migrate to another node)
                    highlight._orphaned_at = Date.now();
                    highlight._orphaned_from_node = deletedDataNodeID || numericId.toString();

                    // ✅ Track deleted node for cleanup during next save
                    if (!highlight._deleted_nodes) {
                      highlight._deleted_nodes = [];
                    }
                    if (deletedDataNodeID && !highlight._deleted_nodes.includes(deletedDataNodeID)) {
                      highlight._deleted_nodes.push(deletedDataNodeID);
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

            citeReq.onsuccess = () => {
              const cursor = citeReq.result;
              if (cursor) {
                const hypercite = cursor.value as HyperciteRecord;

                // Check if this hypercite affects the deleted node
                const affectsDeletedNode =
                  (hypercite.node_id && Array.isArray(hypercite.node_id) &&
                   deletedDataNodeID && hypercite.node_id.includes(deletedDataNodeID));

                if (affectsDeletedNode) {
                  affectedHypercites++;

                  // Check if multi-node hypercite
                  if (hypercite.node_id && hypercite.node_id.length > 1) {
                    // Multi-node hypercite - mark node for deletion cleanup
                    // ✅ Track deleted node for cleanup during next save
                    if (!hypercite._deleted_nodes) {
                      hypercite._deleted_nodes = [];
                    }
                    if (deletedDataNodeID && !hypercite._deleted_nodes.includes(deletedDataNodeID)) {
                      hypercite._deleted_nodes.push(deletedDataNodeID);
                    }

                    // DON'T remove from node_id or charData yet - cleanup happens during update
                    // This prevents losing track of other nodes in multi-node hypercites

                    // Save updated hypercite
                    cursor.update(hypercite);
                  } else {
                    // Single-node hypercite - mark as orphaned (might migrate to another node)
                    hypercite._orphaned_at = Date.now();
                    hypercite._orphaned_from_node = deletedDataNodeID || numericId.toString();

                    // ✅ Track deleted node for cleanup during next save
                    if (!hypercite._deleted_nodes) {
                      hypercite._deleted_nodes = [];
                    }
                    if (deletedDataNodeID && !hypercite._deleted_nodes.includes(deletedDataNodeID)) {
                      hypercite._deleted_nodes.push(deletedDataNodeID);
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

      getRequest.onerror = () => reject(getRequest.error);

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
          const { getEditToolbar } = await import('../../editToolbar/index');
          const toolbar = getEditToolbar();
          if (toolbar) {
              await toolbar.updateHistoryButtonStates();
          }
        } catch (e) {
          // Toolbar not loaded (not in edit mode)
        }

        resolve(true);
      };

      tx.onerror = () => reject(tx.error);
    });
  });
}
