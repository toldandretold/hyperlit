/**
 * Hypercites Operations Module
 * Handles hypercite (two-way citation) operations in IndexedDB
 */

import { parseNodeId } from '../core/utilities';
import { resolveHypercite } from './helpers';
import type { BookId, HyperciteRecord, NodeRecord, QueueForSyncFn, RelationshipStatus } from '../types';

interface HypercitesDeps {
  updateBookTimestamp: (bookId: BookId) => Promise<unknown>;
  queueForSync: QueueForSyncFn;
  withPending: <T>(fn: () => Promise<T>) => Promise<T>;
  getNodeChunksFromIndexedDB: (bookId: BookId) => Promise<NodeRecord[]>;
}

// Injected dependencies (crash-if-uninitialized, same as the pre-TS module)
let updateBookTimestamp: HypercitesDeps['updateBookTimestamp'];
let queueForSync: HypercitesDeps['queueForSync'];
let withPending: HypercitesDeps['withPending'];
let getNodeChunksFromIndexedDB: HypercitesDeps['getNodeChunksFromIndexedDB'];

// Initialization function to inject dependencies
export function initHypercitesDependencies(deps: HypercitesDeps): void {
  updateBookTimestamp = deps.updateBookTimestamp;
  queueForSync = deps.queueForSync;
  withPending = deps.withPending;
  getNodeChunksFromIndexedDB = deps.getNodeChunksFromIndexedDB;
}

/**
 * Get a hypercite from IndexedDB
 * (raw versionless connection, like nodes/read — missing key → undefined, errors → null)
 */
export async function getHyperciteFromIndexedDB(book: BookId, hyperciteId: string): Promise<HyperciteRecord | null | undefined> {
  return new Promise((resolve) => {
    const dbName = "MarkdownDB";
    const storeName = "hypercites";

    const request = indexedDB.open(dbName);

    request.onerror = () => {
      console.error(`IndexedDB error: ${request.error}`);
      resolve(null);
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      try {
        const transaction = db.transaction([storeName], "readonly");
        const objectStore = transaction.objectStore(storeName);

        // Create the composite key [book, hyperciteId]
        const key = [book, hyperciteId];

        // Get the record using the composite key
        const getRequest = objectStore.get(key);

        getRequest.onsuccess = () => {
          resolve(getRequest.result);
        };

        getRequest.onerror = () => {
          console.error(`Error getting hypercite record:`, getRequest.error);
          resolve(null);
        };

        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("Transaction error:", error);
        resolve(null);
      }
    };
  });
}

/**
 * Update a hypercite in IndexedDB
 * This is a CORE operation - used in read mode for citation linking
 *
 * @param skipQueue - Skip sync queue (for batched operations)
 */
export async function updateHyperciteInIndexedDB(
  book: BookId,
  hyperciteId: string,
  updatedFields: Partial<HyperciteRecord>,
  skipQueue = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    const dbName = "MarkdownDB";
    const storeName = "hypercites";

    console.log(`Updating in hypercites store: ${dbName}, key: [${book}, ${hyperciteId}], skipQueue: ${skipQueue}`);

    const request = indexedDB.open(dbName);

    request.onerror = () => {
      console.error(`IndexedDB error: ${request.error}`);
      resolve(false);
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);

        // Create the composite key [book, hyperciteId]
        const key = [book, hyperciteId];

        // Get the record using the composite key
        const getRequest = objectStore.get(key);

        getRequest.onsuccess = () => {
          const existingRecord = getRequest.result as HyperciteRecord | undefined;

          if (!existingRecord) {
            console.error(`Hypercite record not found for key: [${book}, ${hyperciteId}]`);
            resolve(false);
            return;
          }

          console.log("Found existing hypercite record:", existingRecord);

          // Update the fields in the existing record
          Object.assign(existingRecord, updatedFields);

          // Put the updated record back
          const updateRequest = objectStore.put(existingRecord);

          updateRequest.onsuccess = async () => {
            console.log(`Successfully updated hypercite for key: [${book}, ${hyperciteId}]`);
            console.log(`🔍 Queuing hypercite with citedIN:`, existingRecord.citedIN, `status:`, existingRecord.relationshipStatus);
            await updateBookTimestamp(book);
            if (!skipQueue) {
              queueForSync("hypercites", hyperciteId, "update", existingRecord);
            } else {
              console.log(`⏭️ Skipping queue for hypercite ${hyperciteId} (batched sync)`);
            }
            resolve(true);
          };

          updateRequest.onerror = () => {
            console.error(`Error updating hypercite record:`, updateRequest.error);
            resolve(false);
          };
        };

        getRequest.onerror = () => {
          console.error(`Error getting hypercite record:`, getRequest.error);
          resolve(false);
        };

        transaction.oncomplete = () => {
          db.close();
        };
      } catch (error) {
        console.error("Transaction error:", error);
        resolve(false);
      }
    };
  });
}

/**
 * Add a citation to a hypercite's citedIN array
 * Updates the EMBEDDED hypercites array on the node record
 * (state machine: 1 citation → "couple", ≥2 → "poly")
 */
export async function addCitationToHypercite(
  book: BookId,
  startLine: string | number,
  hyperciteId: string,
  newCitation: string,
): Promise<{ success: boolean; relationshipStatus?: RelationshipStatus }> {
  return new Promise((resolve) => {
    const dbName = "MarkdownDB";
    const storeName = "nodes";

    const numericStartLine = parseNodeId(startLine);

    console.log(`Adding citation to hypercite in nodeChunk: book=${book}, startLine=${numericStartLine}, hyperciteId=${hyperciteId}, citation=${newCitation}`);

    const request = indexedDB.open(dbName);

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      try {
        const transaction = db.transaction([storeName], "readwrite");
        const objectStore = transaction.objectStore(storeName);

        const key = [book, numericStartLine];
        console.log("Using key for update:", key);

        const getRequest = objectStore.get(key);

        getRequest.onsuccess = () => {
          const record = getRequest.result as NodeRecord | undefined;

          if (!record) {
            console.error(`Record not found for key: [${book}, ${numericStartLine}]`);
            resolve({ success: false });
            return;
          }

          console.log("Existing nodeChunk before update:", JSON.stringify(record));

          // Ensure hypercites array exists and is an array
          if (!Array.isArray(record.hypercites)) {
            record.hypercites = [];
          }

          // Find the specific hypercite to update
          const hyperciteIndex = record.hypercites.findIndex(h => h.hyperciteId === hyperciteId);

          if (hyperciteIndex === -1) {
            console.error(`Hypercite ${hyperciteId} not found in nodeChunk [${book}, ${numericStartLine}]`);
            resolve({ success: false });
            return;
          }

          // Get a reference to the existing hypercite object within the array
          const hyperciteToUpdate = record.hypercites[hyperciteIndex]!;

          // Ensure citedIN array exists for the hypercite being updated
          if (!Array.isArray(hyperciteToUpdate.citedIN)) {
            hyperciteToUpdate.citedIN = [];
          }

          // Add the citation if it doesn't already exist
          if (!hyperciteToUpdate.citedIN.includes(newCitation)) {
            hyperciteToUpdate.citedIN.push(newCitation);
            console.log(`Added citation ${newCitation} to hypercite ${hyperciteId}`);
          } else {
             console.log(`Citation ${newCitation} already exists for hypercite ${hyperciteId}`);
          }

          // Update relationshipStatus based on citedIN length
          hyperciteToUpdate.relationshipStatus =
            hyperciteToUpdate.citedIN.length === 1 ? "couple" :
            hyperciteToUpdate.citedIN.length >= 2 ? "poly" : "single";

          console.log("Updated hypercite object:", JSON.stringify(hyperciteToUpdate));
          console.log("NodeChunk after modifying hypercite:", JSON.stringify(record));

          // Put the *entire* updated record back
          const updateRequest = objectStore.put(record);

          updateRequest.onsuccess = async () => {
            console.log(`✅ Successfully updated nodeChunk [${book}, ${numericStartLine}]`);

            // IMMEDIATE verification within the same function
            const immediateVerify = objectStore.get(key);
            immediateVerify.onsuccess = () => {
              const verifyRecord = immediateVerify.result as NodeRecord | undefined;
              const verifyHypercite = verifyRecord?.hypercites?.find(h => h.hyperciteId === hyperciteId);
              console.log('🔍 IMMEDIATE VERIFY - hypercite after put:', verifyHypercite);
              console.log('🔍 IMMEDIATE VERIFY - citedIN:', verifyHypercite?.citedIN);
            };

            await updateBookTimestamp(book);
            resolve({
              success: true,
              relationshipStatus: hyperciteToUpdate.relationshipStatus
            });
          };

          updateRequest.onerror = () => {
            console.error(`❌ Error updating nodeChunk record:`, updateRequest.error);
            resolve({ success: false });
          };
        };

        getRequest.onerror = () => {
          console.error(`❌ Error getting nodeChunk record:`, getRequest.error);
          resolve({ success: false });
        };
      } catch (error) {
        console.error("❌ Transaction error:", error);
        resolve({ success: false });
      }
    };

    request.onerror = () => {
      console.error(`❌ IndexedDB error: ${request.error}`);
      resolve({ success: false });
    };
  });
}

/**
 * Update citation for an existing hypercite
 * This is a CORE operation - handles bidirectional citation linking in read mode
 */
export function updateCitationForExistingHypercite(
  booka: BookId,
  hyperciteIDa: string,
  citationIDb: string,
): Promise<{ success: boolean; startLine: number | null; newStatus: RelationshipStatus | null }> {
  return withPending(async () => {
    console.log(
      `✅ NEW SYSTEM: Updating citation: book=${booka}, hyperciteID=${hyperciteIDa}, citationIDb=${citationIDb}`,
    );

    // ✅ Ensure the hypercite exists in our local IndexedDB, fetching
    // it from the server if necessary.
    const resolvedHypercite = await resolveHypercite(booka, hyperciteIDa);

    // If it's not found anywhere (local or server), we cannot proceed.
    if (!resolvedHypercite) {
      console.error(
        `❌ NEW SYSTEM: Could not resolve hypercite ${hyperciteIDa} from any source. Aborting link.`,
      );
      return { success: false, startLine: null, newStatus: null };
    }

    // ✅ NEW SYSTEM: Update the normalized hypercites table directly
    const existingHypercite = await getHyperciteFromIndexedDB(
      booka,
      hyperciteIDa,
    );

    if (!existingHypercite) {
      console.error(
        `❌ NEW SYSTEM: Hypercite ${hyperciteIDa} not found in normalized hypercites table`,
      );
      return { success: false, startLine: null, newStatus: null };
    }

    // Update citedIN array
    if (!Array.isArray(existingHypercite.citedIN)) {
      existingHypercite.citedIN = [];
    }
    if (!existingHypercite.citedIN.includes(citationIDb)) {
      existingHypercite.citedIN.push(citationIDb);
    }

    // Update relationship status based on citedIN length
    const updatedRelationshipStatus: RelationshipStatus =
      existingHypercite.citedIN.length === 0 ? "single" :
      existingHypercite.citedIN.length === 1 ? "couple" :
      "poly";

    existingHypercite.relationshipStatus = updatedRelationshipStatus;

    // Save to normalized hypercites table
    await updateHyperciteInIndexedDB(
      booka,
      hyperciteIDa,
      existingHypercite,
      false,
    );

    console.log(`✅ NEW SYSTEM: Updated hypercite ${hyperciteIDa} in normalized table with status: ${updatedRelationshipStatus}`);

    // ✅ NEW SYSTEM: Rebuild affected node arrays from normalized tables
    const affectedDataNodeIDs = existingHypercite.node_id || [];
    if (affectedDataNodeIDs.length > 0) {
      const { getNodesByDataNodeIDs, rebuildNodeArrays } = await import('../hydration/rebuild');
      const allNodes = await getNodesByDataNodeIDs(affectedDataNodeIDs);
      // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
      // node when the same node_id exists in both parent and sub-book.
      const affectedNodes = allNodes.filter(n => n.book === booka);
      await rebuildNodeArrays(affectedNodes);
      console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${affectedNodes.length} affected nodes`);
    }

    // Determine startLine for broadcasting (use first affected node)
    let affectedStartLine: number | null = null;
    if (affectedDataNodeIDs.length > 0) {
      const nodes = await getNodeChunksFromIndexedDB(booka);
      const affectedNode = nodes.find(n => n.node_id && affectedDataNodeIDs.includes(n.node_id));
      affectedStartLine = affectedNode?.startLine || null;
    }

    return {
      success: true,
      startLine: affectedStartLine,
      newStatus: updatedRelationshipStatus,
    };
  });
}

// PostgreSQL Sync
export {
  syncHyperciteToPostgreSQL,
  syncHyperciteUpdateImmediately,
  syncHyperciteWithNodeChunkImmediately,
} from './syncHypercitesToPostgreSQL';
