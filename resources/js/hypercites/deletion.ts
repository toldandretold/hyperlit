/**
 * Hypercite Deletion & Delink Workflow
 *
 * Handles the deletion of hypercites and the bidirectional delink process.
 * When a hypercite citation is deleted, it updates the source hypercite's citedIN array.
 */

import { openDatabase, updateBookTimestamp, getHyperciteFromIndexedDB, syncHyperciteWithNodeImmediately, getNodesByDataNodeIDs, rebuildNodeArrays, queueForSync, debouncedMasterSync } from '../indexedDB/index';
import { getActiveBook } from '../hyperlitContainer/utilities/activeContext';
import { extractHyperciteIdFromHref, determineRelationshipStatus, removeCitedINEntry } from './utils';
import { getHyperciteById } from './database';

/**
 * Delink a hypercite when it's deleted
 * Removes the citation from the source hypercite's citedIN array and updates relationship status
 */
export async function delinkHypercite(hyperciteElementId: string, hrefUrl: string): Promise<void> {
  try {
    console.log("🔗 Starting delink process for:", hyperciteElementId);
    console.log("📍 Href URL:", hrefUrl);

    // Step 1: Extract the target hypercite ID from the href
    const targetHyperciteId = extractHyperciteIdFromHref(hrefUrl);
    if (!targetHyperciteId) {
      console.error("❌ Could not extract hypercite ID from href:", hrefUrl);
      return;
    }

    console.log("🎯 Target hypercite ID to delink from:", targetHyperciteId);

    // Step 2: Look up the target hypercite in IndexedDB
    const db = await openDatabase();
    const targetHypercite = await getHyperciteById(db, targetHyperciteId);

    if (!targetHypercite) {
      console.error("❌ Target hypercite not found in database:", targetHyperciteId);
      return;
    }

    console.log("📋 Found target hypercite:", targetHypercite);

    // Step 3: Remove the current hypercite from the target's citedIN array
    const originalCitedIN = [...targetHypercite.citedIN];
    const updatedCitedIN = removeCitedINEntry(targetHypercite.citedIN, hyperciteElementId);

    if (originalCitedIN.length === updatedCitedIN.length) {
      console.warn("⚠️ No matching citedIN entry found to remove");
      return;
    }

    console.log("✂️ Removed citedIN entry. New array:", updatedCitedIN);

    // Step 4: Update the target hypercite's relationship status
    const newRelationshipStatus = determineRelationshipStatus(updatedCitedIN.length);

    // Step 5: Update IndexedDB
    const updatedHypercite = {
      ...targetHypercite,
      citedIN: updatedCitedIN,
      relationshipStatus: newRelationshipStatus
    };

    await updateHyperciteInIndexedDB(db, updatedHypercite);
    console.log("💾 Updated hypercite in IndexedDB");

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

    console.log(`🔍 Searching ${allNodes.length} nodes for hypercite ${targetHyperciteId}`);

    // Find the node that contains this hypercite
    let foundNode: any = null;
    let foundHyperciteIndex = -1;

    for (const node of allNodes) {
      if (node.hypercites && Array.isArray(node.hypercites)) {
        const index = node.hypercites.findIndex((hc: any) => hc.hyperciteId === targetHyperciteId);
        if (index !== -1) {
          foundNode = node;
          foundHyperciteIndex = index;
          console.log(`✅ Found hypercite in node at startLine ${node.startLine}, index ${index}`);
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

      console.log(`✅ Updated node hypercites array for startLine ${foundNode.startLine}`);
    } else {
      console.warn(`⚠️ Hypercite ${targetHyperciteId} not found in any node`);
    }

    await new Promise<void>((resolve, reject) => {
      nodesTx.oncomplete = () => resolve();
      nodesTx.onerror = () => reject(nodesTx.error);
    });

    // Step 8: Sync BOTH hypercite AND node immediately in ONE atomic transaction
    if (foundNode) {
      console.log("🚀 Syncing hypercite + node deletion in unified transaction...");

      // Fetch the updated hypercite from IndexedDB
      const hyperciteToSync = await getHyperciteFromIndexedDB(targetHypercite.book, targetHyperciteId);

      if (hyperciteToSync) {
        await syncHyperciteWithNodeImmediately(
          targetHypercite.book,
          hyperciteToSync,
          foundNode
        );
        console.log("✅ Hypercite + node deletion synced to server in one transaction.");
      } else {
        console.error("❌ Failed to fetch hypercite from IndexedDB for sync");
      }
    }

    // Step 9: Update book timestamps for BOTH affected books
    const affectedBooks = new Set([targetHypercite.book]); // Book A (where cited text lives)

    // Also update the book where the deletion occurred (Book B)
    const currentBook = getActiveBook();
    if (currentBook && currentBook !== targetHypercite.book) {
      affectedBooks.add(currentBook);
    }

    console.log(`📝 Updating timestamps for affected books:`, Array.from(affectedBooks));

    for (const bookId of affectedBooks) {
      await updateBookTimestamp(bookId);
    }

    console.log("✅ Delink process completed successfully");

    // 🔥 NEW: Broadcast the update to other tabs so they can refresh the hypercite's appearance
    if (foundNode) {
      const { broadcastToOpenTabs } = await import('../utilities/BroadcastListener');
      broadcastToOpenTabs(targetHypercite.book, foundNode.startLine);
      console.log(`📡 Broadcasted delink update for node ${foundNode.startLine} to other tabs`);
    }
  } catch (error) {
    console.error("❌ Error in delinkHypercite:", error);
  }
}

/**
 * Helper function to handle hypercite deletion from DOM
 * Call this when you detect a hypercite element is being deleted
 */
export async function handleHyperciteDeletion(hyperciteElement: HTMLAnchorElement | null): Promise<void> {
  if (!hyperciteElement || !hyperciteElement.href || !hyperciteElement.id) {
    console.warn("⚠️ Invalid hypercite element for deletion");
    return;
  }

  const hyperciteElementId = hyperciteElement.id;
  const hrefUrl = hyperciteElement.href;

  console.log("🗑️ Handling deletion of hypercite:", hyperciteElementId);

  await delinkHypercite(hyperciteElementId, hrefUrl);
}

/**
 * Mark a hypercite as a ghost (tombstone state)
 * Called when the source <u> tag is deleted but citedIN references still exist.
 * The hypercite record is kept with status 'ghost' so citing books can show ghost UX.
 */
export async function markHyperciteAsGhost(hyperciteId: string): Promise<boolean> {
  try {
    console.log("👻 Marking hypercite as ghost:", hyperciteId);

    const db = await openDatabase();
    const hypercite = await getHyperciteById(db, hyperciteId);

    if (!hypercite) {
      console.error("❌ Hypercite not found for ghost marking:", hyperciteId);
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

    console.log("💾 Updated hypercite status to ghost in IndexedDB");

    // Rebuild affected node arrays so embedded hypercites reflect ghost status
    const affectedDataNodeIDs = hypercite.node_id || [];
    if (affectedDataNodeIDs.length > 0) {
      const allNodes = await getNodesByDataNodeIDs(affectedDataNodeIDs);
      const affectedNodes = allNodes.filter((n: any) => n.book === hypercite.book);
      await rebuildNodeArrays(affectedNodes);
      console.log(`✅ Rebuilt arrays for ${affectedNodes.length} affected nodes`);
    }

    // Queue for sync and flush immediately
    await updateBookTimestamp(hypercite.book);
    queueForSync("hypercites", hyperciteId, "update", hypercite);
    await debouncedMasterSync.flush();

    console.log("✅ Ghost hypercite synced to server");
    return true;
  } catch (error) {
    console.error("❌ Error marking hypercite as ghost:", error);
    return false;
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
    console.log(`🎨 Updated DOM element ${hyperciteId} class to: ${relationshipStatus}`);
  }
}

// NOTE (TS migration 2026-06): removed the dead `syncDelinkWithPostgreSQL` helper.
// It was never called AND referenced an unimported `getLibraryObjectFromIndexedDB`,
// so it would have thrown a ReferenceError if it ever had been — delinkHypercite
// uses syncHyperciteWithNodeImmediately (step 8) instead.
