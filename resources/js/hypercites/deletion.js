/**
 * Hypercite Deletion & Delink Workflow
 *
 * Handles the deletion of hypercites and the bidirectional delink process.
 * When a hypercite citation is deleted, it updates the source hypercite's citedIN array.
 */

import { openDatabase, updateBookTimestamp, getHyperciteFromIndexedDB, syncHyperciteWithNodeChunkImmediately } from '../indexedDB/index.js';
import { getActiveBook } from '../utilities/activeContext.js';
import { extractHyperciteIdFromHref, determineRelationshipStatus, removeCitedINEntry } from './utils.js';
import { getHyperciteById } from './database.js';

/**
 * Delink a hypercite when it's deleted
 * Removes the citation from the source hypercite's citedIN array and updates relationship status
 *
 * @param {string} hyperciteElementId - The ID of the hypercite element being deleted (e.g., "hypercite_p0pdlbaj")
 * @param {string} hrefUrl - The href URL of the hypercite element
 */
export async function delinkHypercite(hyperciteElementId, hrefUrl) {
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

    // Step 7: Update the nodeChunk's hypercites array
    // Since hypercite records don't store startLine, we need to search all nodes
    const nodesTx = db.transaction(['nodes'], 'readwrite');
    const nodesStore = nodesTx.objectStore('nodes');
    const bookIndex = nodesStore.index('book');

    // Get all nodes for this book
    const allNodeChunks = await new Promise((resolve, reject) => {
      const request = bookIndex.getAll(targetHypercite.book);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    console.log(`🔍 Searching ${allNodeChunks.length} nodes for hypercite ${targetHyperciteId}`);

    // Find the nodeChunk that contains this hypercite
    let foundNodeChunk = null;
    let foundHyperciteIndex = -1;

    for (const nodeChunk of allNodeChunks) {
      if (nodeChunk.hypercites && Array.isArray(nodeChunk.hypercites)) {
        const index = nodeChunk.hypercites.findIndex(hc => hc.hyperciteId === targetHyperciteId);
        if (index !== -1) {
          foundNodeChunk = nodeChunk;
          foundHyperciteIndex = index;
          console.log(`✅ Found hypercite in nodeChunk at startLine ${nodeChunk.startLine}, index ${index}`);
          break;
        }
      }
    }

    if (foundNodeChunk && foundHyperciteIndex !== -1) {
      // Update the hypercite in the nodeChunk's array
      foundNodeChunk.hypercites[foundHyperciteIndex] = {
        ...foundNodeChunk.hypercites[foundHyperciteIndex],
        citedIN: updatedCitedIN,
        relationshipStatus: newRelationshipStatus
      };

      // Update the nodeChunk in IndexedDB
      const updateRequest = nodesStore.put(foundNodeChunk);
      await new Promise((resolve, reject) => {
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = () => reject(updateRequest.error);
      });

      console.log(`✅ Updated nodeChunk hypercites array for startLine ${foundNodeChunk.startLine}`);
    } else {
      console.warn(`⚠️ Hypercite ${targetHyperciteId} not found in any nodeChunk`);
    }

    await new Promise((resolve, reject) => {
      nodesTx.oncomplete = () => resolve();
      nodesTx.onerror = () => reject(nodesTx.error);
    });

    // Step 8: Sync BOTH hypercite AND nodeChunk immediately in ONE atomic transaction
    if (foundNodeChunk) {
      console.log("🚀 Syncing hypercite + nodeChunk deletion in unified transaction...");

      // Fetch the updated hypercite from IndexedDB
      const hyperciteToSync = await getHyperciteFromIndexedDB(targetHypercite.book, targetHyperciteId);

      if (hyperciteToSync) {
        await syncHyperciteWithNodeChunkImmediately(
          targetHypercite.book,
          hyperciteToSync,
          foundNodeChunk
        );
        console.log("✅ Hypercite + nodeChunk deletion synced to server in one transaction.");
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
    if (foundNodeChunk) {
      const { broadcastToOpenTabs } = await import('../utilities/BroadcastListener.js');
      broadcastToOpenTabs(targetHypercite.book, foundNodeChunk.startLine);
      console.log(`📡 Broadcasted delink update for node ${foundNodeChunk.startLine} to other tabs`);
    }
  } catch (error) {
    console.error("❌ Error in delinkHypercite:", error);
  }
}

/**
 * Helper function to handle hypercite deletion from DOM
 * Call this when you detect a hypercite element is being deleted
 *
 * @param {HTMLElement} hyperciteElement - The hypercite element being deleted
 */
export async function handleHyperciteDeletion(hyperciteElement) {
  if (!hyperciteElement || !hyperciteElement.href || !hyperciteElement.id) {
    console.warn("⚠️ Invalid hypercite element for deletion");
    return;
  }

  const hyperciteElementId = hyperciteElement.id;
  const hrefUrl = hyperciteElement.href;

  console.log("🗑️ Handling deletion of hypercite:", hyperciteElementId);

  await delinkHypercite(hyperciteElementId, hrefUrl);
}

// ========== Internal Helper Functions (not exported) ==========

/**
 * Update hypercite in IndexedDB
 * @param {IDBDatabase} db - The IndexedDB database
 * @param {Object} hyperciteData - The updated hypercite data
 * @returns {Promise<void>}
 */
async function updateHyperciteInIndexedDB(db, hyperciteData) {
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
 * @param {string} hyperciteId - The hypercite ID
 * @param {string} relationshipStatus - The new relationship status
 */
function updateDOMElementClass(hyperciteId, relationshipStatus) {
  const element = document.getElementById(hyperciteId);
  if (element && element.tagName.toLowerCase() === 'u') {
    // Remove existing relationship classes
    element.classList.remove('single', 'couple', 'poly');
    // Add new class
    element.classList.add(relationshipStatus);
    console.log(`🎨 Updated DOM element ${hyperciteId} class to: ${relationshipStatus}`);
  }
}

/**
 * Sync delink operation with PostgreSQL
 * @param {Object} updatedHypercite - The updated hypercite data
 */
async function syncDelinkWithPostgreSQL(updatedHypercite) {
  try {
    console.log("🔄 Syncing delink with PostgreSQL...");

    // Sync the hypercite update
    const hyperciteResponse = await fetch("/api/db/hypercites/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": document
          .querySelector('meta[name="csrf-token"]')
          ?.getAttribute("content"),
      },
      credentials: "include",
      body: JSON.stringify({
        book: updatedHypercite.book,
        data: [updatedHypercite]
      }),
    });

    if (!hyperciteResponse.ok) {
      throw new Error(`Hypercite sync failed: ${hyperciteResponse.statusText}`);
    }

    console.log("✅ Hypercite delink synced with PostgreSQL");

    // Update library timestamp
    const libraryObj = await getLibraryObjectFromIndexedDB(updatedHypercite.book);
    if (libraryObj && libraryObj.timestamp) {
      const timestampResponse = await fetch("/api/db/library/update-timestamp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content"),
        },
        credentials: "include",
        body: JSON.stringify({
          book: libraryObj.book,
          timestamp: libraryObj.timestamp
        }),
      });

      if (!timestampResponse.ok) {
        throw new Error(`Library timestamp update failed: ${timestampResponse.statusText}`);
      }

      console.log("✅ Library timestamp updated for delink");
    }

  } catch (error) {
    console.error("❌ Error syncing delink with PostgreSQL:", error);
  }
}
