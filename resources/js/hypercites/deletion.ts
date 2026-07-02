/**
 * Hypercite Deletion & Delink Workflow
 *
 * Handles the deletion of hypercites and the bidirectional delink process.
 * When a hypercite citation is deleted, it updates the source hypercite's citedIN array.
 */

import { openDatabase, updateBookTimestamp, getHyperciteFromIndexedDB, syncHyperciteWithNodeImmediately, getNodesByDataNodeIDs, rebuildNodeArrays, queueForSync, debouncedMasterSync } from '../indexedDB/index';
import { getActiveBook } from '../hyperlitContainer/utilities/activeContext';
import { log } from '../utilities/logger';
import { extractHyperciteIdFromHref, determineRelationshipStatus, removeCitedINEntry } from './utils';
import { getHyperciteById } from './database';

/**
 * Delink a hypercite when it's deleted
 * Removes the citation from the source hypercite's citedIN array and updates relationship status
 */
export async function delinkHypercite(hyperciteElementId: string, hrefUrl: string): Promise<void> {
  try {
    // Step 1: Extract the target hypercite ID from the href
    const targetHyperciteId = extractHyperciteIdFromHref(hrefUrl);
    if (!targetHyperciteId) {
      log.error('Could not extract hypercite ID from href', '/hypercites/deletion.ts', hrefUrl);
      return;
    }

    // Step 2: Look up the target hypercite in IndexedDB
    const db = await openDatabase();
    const targetHypercite = await getHyperciteById(db, targetHyperciteId);

    if (!targetHypercite) {
      log.error('Target hypercite not found in database', '/hypercites/deletion.ts', targetHyperciteId);
      return;
    }

    // Step 3: Remove the current hypercite from the target's citedIN array
    const originalCitedIN = [...targetHypercite.citedIN];
    const updatedCitedIN = removeCitedINEntry(targetHypercite.citedIN, hyperciteElementId);

    if (originalCitedIN.length === updatedCitedIN.length) {
      return;
    }

    // Step 4: Update the target hypercite's relationship status
    const newRelationshipStatus = determineRelationshipStatus(updatedCitedIN.length);

    // Step 5: Update IndexedDB
    const updatedHypercite = {
      ...targetHypercite,
      citedIN: updatedCitedIN,
      relationshipStatus: newRelationshipStatus
    };

    await updateHyperciteInIndexedDB(db, updatedHypercite);

    // Step 6: Update the DOM element's class if it exists
    updateDOMElementClass(targetHyperciteId, newRelationshipStatus);

    // Step 7: Update the node's hypercites array
    // Since hypercite records don't store startLine, we need to search all nodes
    const nodesTx = db.transaction(['nodes'], 'readwrite');
    const nodesStore = nodesTx.objectStore('nodes');
    const bookIndex = nodesStore.index('book');

    // Get all nodes for this book
    const allNodes: any[] = await new Promise((resolve, reject) => {
      const request = bookIndex.getAll(targetHypercite.book);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    // Find the node that contains this hypercite
    let foundNode: any = null;
    let foundHyperciteIndex = -1;

    for (const node of allNodes) {
      if (node.hypercites && Array.isArray(node.hypercites)) {
        const index = node.hypercites.findIndex((hc: any) => hc.hyperciteId === targetHyperciteId);
        if (index !== -1) {
          foundNode = node;
          foundHyperciteIndex = index;
          break;
        }
      }
    }

    if (foundNode && foundHyperciteIndex !== -1) {
      // Update the hypercite in the node's array
      foundNode.hypercites[foundHyperciteIndex] = {
        ...foundNode.hypercites[foundHyperciteIndex],
        citedIN: updatedCitedIN,
        relationshipStatus: newRelationshipStatus
      };

      // Update the node in IndexedDB
      const updateRequest = nodesStore.put(foundNode);
      await new Promise<void>((resolve, reject) => {
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = () => reject(updateRequest.error);
      });
    }

    await new Promise<void>((resolve, reject) => {
      nodesTx.oncomplete = () => resolve();
      nodesTx.onerror = () => reject(nodesTx.error);
    });

    // Step 8: Sync BOTH hypercite AND node immediately in ONE atomic transaction
    if (foundNode) {
      // Fetch the updated hypercite from IndexedDB
      const hyperciteToSync = await getHyperciteFromIndexedDB(targetHypercite.book, targetHyperciteId);

      if (hyperciteToSync) {
        await syncHyperciteWithNodeImmediately(
          targetHypercite.book,
          hyperciteToSync,
          foundNode
        );
      } else {
        log.error('Failed to fetch hypercite from IndexedDB for sync', '/hypercites/deletion.ts');
      }
    }

    // Step 9: Update book timestamps for BOTH affected books
    const affectedBooks = new Set([targetHypercite.book]); // Book A (where cited text lives)

    // Also update the book where the deletion occurred (Book B)
    const currentBook = getActiveBook();
    if (currentBook && currentBook !== targetHypercite.book) {
      affectedBooks.add(currentBook);
    }

    for (const bookId of affectedBooks) {
      await updateBookTimestamp(bookId);
    }

    // 🔥 NEW: Broadcast the update to other tabs so they can refresh the hypercite's appearance
    if (foundNode) {
      const { broadcastToOpenTabs } = await import('../utilities/BroadcastListener');
      broadcastToOpenTabs(targetHypercite.book, foundNode.startLine);
    }
  } catch (error) {
    log.error('Error in delinkHypercite', '/hypercites/deletion.ts', error);
  }
}

/**
 * Helper function to handle hypercite deletion from DOM
 * Call this when you detect a hypercite element is being deleted
 */
export async function handleHyperciteDeletion(hyperciteElement: HTMLAnchorElement | null): Promise<void> {
  if (!hyperciteElement || !hyperciteElement.href || !hyperciteElement.id) {
    return;
  }

  const hyperciteElementId = hyperciteElement.id;
  const hrefUrl = hyperciteElement.href;

  await delinkHypercite(hyperciteElementId, hrefUrl);
}

/**
 * Mark a hypercite as a ghost (tombstone state)
 * Called when the source <u> tag is deleted but citedIN references still exist.
 * The hypercite record is kept with status 'ghost' so citing books can show ghost UX.
 */
export async function markHyperciteAsGhost(hyperciteId: string): Promise<boolean> {
  try {
    const db = await openDatabase();
    const hypercite = await getHyperciteById(db, hyperciteId);

    if (!hypercite) {
      log.error('Hypercite not found for ghost marking', '/hypercites/deletion.ts', hyperciteId);
      return false;
    }

    // Update status to ghost
    hypercite.relationshipStatus = 'ghost';

    // Write back to IndexedDB hypercites store
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("hypercites", "readwrite");
      const store = tx.objectStore("hypercites");
      const request = store.put(hypercite);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error("Error updating hypercite to ghost"));
    });

    // Rebuild affected node arrays so embedded hypercites reflect ghost status
    const affectedDataNodeIDs = hypercite.node_id || [];
    if (affectedDataNodeIDs.length > 0) {
      const allNodes = await getNodesByDataNodeIDs(affectedDataNodeIDs);
      const affectedNodes = allNodes.filter((n: any) => n.book === hypercite.book);
      await rebuildNodeArrays(affectedNodes);
    }

    // Queue for sync and flush immediately
    await updateBookTimestamp(hypercite.book);
    queueForSync("hypercites", hyperciteId, "update", hypercite);
    await debouncedMasterSync.flush();

    return true;
  } catch (error) {
    log.error('Error marking hypercite as ghost', '/hypercites/deletion.ts', error);
    return false;
  }
}

/**
 * Remove specific broken citations from a hypercite's citedIN array.
 * The "manage citations" panel calls this for the citations a health-check flagged as broken
 * (batch of URLs). Sibling of delinkHypercite (single entry, immediate sync); this one
 * queues + flushes and reprocesses the affected nodes' highlight rendering.
 * @param sourceBook - The book containing the source hypercite
 * @param sourceHyperciteIds - Array of source hypercite IDs
 * @param brokenCitations - Citations to remove (`{ url }`)
 */
export async function removeSpecificCitations(sourceBook: any, sourceHyperciteIds: any, brokenCitations: any) {
  const db: any = await openDatabase();

  const brokenUrls = brokenCitations.map((c: any) => c.url);

  const updatedNodes = [];

  for (const sourceHyperciteId of sourceHyperciteIds) {
    // Read hypercite from IndexedDB
    const readTx = db.transaction('hypercites', 'readonly');
    const readStore = readTx.objectStore('hypercites');
    const hyperciteRequest = readStore.get([sourceBook, sourceHyperciteId]);

    const hypercite: any = await new Promise((resolve: any, reject: any) => {
      hyperciteRequest.onsuccess = () => resolve(hyperciteRequest.result);
      hyperciteRequest.onerror = () => reject(hyperciteRequest.error);
    });

    await new Promise((resolve: any, reject: any) => {
      readTx.oncomplete = () => resolve(undefined);
      readTx.onerror = () => reject(readTx.error);
    });

    if (!hypercite) {
      continue;
    }

    // Filter out broken citations from citedIN array
    hypercite.citedIN = (hypercite.citedIN || []).filter((url: any) => !brokenUrls.includes(url));
    const newLength = hypercite.citedIN.length;

    // Update relationship status based on new citedIN length
    hypercite.relationshipStatus = determineRelationshipStatus(newLength);

    // Save updated hypercite to IndexedDB
    const writeTx = db.transaction('hypercites', 'readwrite');
    const writeStore = writeTx.objectStore('hypercites');
    const putRequest = writeStore.put(hypercite);

    await new Promise((resolve: any, reject: any) => {
      putRequest.onsuccess = () => {
        resolve(undefined);
      };
      putRequest.onerror = () => reject(putRequest.error);
    });

    await new Promise((resolve: any, reject: any) => {
      writeTx.oncomplete = () => resolve(undefined);
      writeTx.onerror = () => reject(writeTx.error);
    });

    // Queue for sync to PostgreSQL
    queueForSync('hypercites', sourceHyperciteId, 'update', hypercite);

    // Update DOM if element exists
    const uElement = document.getElementById(sourceHyperciteId);
    if (uElement) {
      // Update class to reflect new relationship status
      uElement.classList.remove('single', 'couple', 'poly');
      uElement.classList.add(hypercite.relationshipStatus);
    }

    // Update nodeRecord's hypercites array (like delinkHypercite does) so the embedded
    // hypercite data in nodes stays in sync.
    const nodesTx = db.transaction(['nodes'], 'readwrite');
    const nodesStore = nodesTx.objectStore('nodes');
    const bookIndex = nodesStore.index('book');

    // Get all nodes for this book
    const allNodes: any = await new Promise((resolve: any, reject: any) => {
      const request = bookIndex.getAll(sourceBook);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    // Find the nodeRecord that contains this hypercite
    let foundNode: any = null;
    let foundHyperciteIndex = -1;

    for (const nodeRecord of allNodes) {
      if (nodeRecord.hypercites && Array.isArray(nodeRecord.hypercites)) {
        const index = nodeRecord.hypercites.findIndex((hc: any) => hc.hyperciteId === sourceHyperciteId);
        if (index !== -1) {
          foundNode = nodeRecord;
          foundHyperciteIndex = index;
          break;
        }
      }
    }

    if (foundNode && foundHyperciteIndex !== -1) {
      // Update the hypercite in the nodeRecord's array
      foundNode.hypercites[foundHyperciteIndex] = {
        ...foundNode.hypercites[foundHyperciteIndex],
        citedIN: hypercite.citedIN,
        relationshipStatus: hypercite.relationshipStatus
      };

      // Update the nodeRecord in IndexedDB
      const updateRequest = nodesStore.put(foundNode);
      await new Promise((resolve: any, reject: any) => {
        updateRequest.onsuccess = () => resolve(undefined);
        updateRequest.onerror = () => reject(updateRequest.error);
      });

      // Queue the nodeRecord for sync to PostgreSQL
      queueForSync('nodes', foundNode.startLine, 'update', foundNode);
      updatedNodes.push(foundNode);
    }

    await new Promise((resolve: any, reject: any) => {
      nodesTx.oncomplete = () => resolve(undefined);
      nodesTx.onerror = () => reject(nodesTx.error);
    });
  }

  // Update book timestamp
  await updateBookTimestamp(sourceBook);

  // Flush sync immediately
  await debouncedMasterSync.flush();

  // Broadcast changes to other tabs
  const { broadcastToOpenTabs }: any = await import('../utilities/BroadcastListener');
  updatedNodes.forEach((chunk: any) => {
    broadcastToOpenTabs(sourceBook, chunk.startLine);
  });

  // Re-render affected nodes so <u> tags reflect updated relationship status
  if (updatedNodes.length > 0) {
    const { reprocessHighlightsForNodes }: any = await import('../hyperlights/index');
    const affectedStartLines = updatedNodes.map((chunk: any) => chunk.startLine);
    await reprocessHighlightsForNodes(sourceBook, affectedStartLines);
  }
}

// ========== Internal Helper Functions (not exported) ==========

/**
 * Update hypercite in IndexedDB
 */
async function updateHyperciteInIndexedDB(db: IDBDatabase, hyperciteData: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("hypercites", "readwrite");
    const store = tx.objectStore("hypercites");
    const request = store.put(hyperciteData);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("Error updating hypercite"));
  });
}

/**
 * Update DOM element class based on relationship status
 */
function updateDOMElementClass(hyperciteId: string, relationshipStatus: string): void {
  const element = document.getElementById(hyperciteId);
  if (element && element.tagName.toLowerCase() === 'u') {
    // Remove existing relationship classes
    element.classList.remove('single', 'couple', 'poly');
    // Add new class
    element.classList.add(relationshipStatus);
  }
}

// NOTE (TS migration 2026-06): removed the dead `syncDelinkWithPostgreSQL` helper.
// It was never called AND referenced an unimported `getLibraryObjectFromIndexedDB`,
// so it would have thrown a ReferenceError if it ever had been — delinkHypercite
// uses syncHyperciteWithNodeImmediately (step 8) instead.
