/**
 * Database module - Handles IndexedDB operations for hyperlights
 */

import { book } from '../app.js';
import { openDatabase, parseNodeId, createNodeChunksKey } from '../indexedDB/index.js';
import { getCurrentUser, getCurrentUserId } from "../utilities/auth.js";

/**
 * Add a new highlight to the hyperlights table
 * @param {string} bookId - The book ID
 * @param {Object} highlightData - Highlight metadata
 * @returns {Promise<Object>} The created highlight entry
 */
export async function addToHighlightsTable(bookId, highlightData) {
  const db = await openDatabase();

  return new Promise(async (resolve, reject) => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");

    // ✅ FIXED: Get current user info for IndexedDB storage
    const user = await getCurrentUser();
    const currentUserId = await getCurrentUserId();

    const creator = user ? (user.name || user.username || user.email) : null;
    const creator_token = user ? null : currentUserId; // For anon users, currentUserId IS the token

    console.log("💾 Saving to IndexedDB with auth:", { creator, creator_token, currentUserId });

    // Create a document fragment to hold the highlighted content
    const fragment = document.createDocumentFragment();
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);

    // Clone the range contents to preserve HTML structure
    const clonedContents = range.cloneContents();
    fragment.appendChild(clonedContents);

    // Get the HTML content as a string, but remove any mark tags
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(fragment.cloneNode(true));

    // Remove all mark tags from the temp div, preserving their content
    const markTags = tempDiv.querySelectorAll('mark');
    markTags.forEach(mark => {
      // Create a text node with the mark's content
      const textNode = document.createTextNode(mark.textContent);
      // Replace the mark with its text content
      mark.parentNode.replaceChild(textNode, mark);
    });

    const highlightedHTML = tempDiv.innerHTML;

    const highlightEntry = {
      book: bookId, // Current book ID
      hyperlight_id: highlightData.highlightId,
      highlightedText: highlightData.text, // Keep the plain text for searching
      highlightedHTML: highlightedHTML, // Store the HTML structure without mark tags
      annotation: "", // initial empty annotation
      startChar: highlightData.startChar,
      endChar: highlightData.endChar,
      startLine: highlightData.startLine,
      creator: creator,        // ✅ FIXED: Set proper creator
      creator_token: creator_token, // ✅ FIXED: Set proper creator_token
      time_since: Math.floor(Date.now() / 1000)
    };

    console.log("💾 Final highlight entry for IndexedDB:", highlightEntry);

    const addRequest = store.put(highlightEntry);

    addRequest.onsuccess = () => {
      console.log("✅ Successfully added highlight to hyperlights table");
      // MODIFIED: Resolve with the entry that was just saved.
      resolve(highlightEntry);
    };

    addRequest.onerror = (event) => {
      console.error("❌ Error adding highlight to hyperlights table:", event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Update a node with a new highlight in the nodes table
 * @param {string} bookId - The book ID
 * @param {string} chunkId - The chunk ID (e.g., "1.1")
 * @param {number} highlightStartOffset - Start offset
 * @param {number} highlightEndOffset - End offset
 * @param {string} highlightId - The highlight ID
 * @returns {Promise<Object>} The updated node
 */
export async function updateNodeHighlight(
  bookId,
  chunkId,
  highlightStartOffset,
  highlightEndOffset,
  highlightId
) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodes", "readwrite");
    const store = tx.objectStore("nodes");

    // Use the helper to create a consistent key
    const key = createNodeChunksKey(bookId, chunkId);
    console.log("Looking up with key:", key);

    const getRequest = store.get(key);

    getRequest.onsuccess = () => {
      const node = getRequest.result;
      let updatedNode; // 👈 ADD: Variable to track the updated node

      if (!node) {
        console.warn(`No nodes record for key [${book}, ${chunkId}]`);

        // Create a new node if it doesn't exist
        updatedNode = {
          book: book,
          startLine: parseNodeId(chunkId),  // Store as number
          chunk_id: parseNodeId(chunkId),
          content: document.getElementById(chunkId)?.innerHTML || "",
          hyperlights: [{
            highlightID: highlightId,
            charStart: highlightStartOffset,
            charEnd: highlightEndOffset,
            is_user_highlight: true
          }]
        };

        const putReq = store.put(updatedNode);
        putReq.onsuccess = () => {
          console.log(`Created new node for [${book}, ${chunkId}]`);
          resolve(updatedNode); // 👈 RETURN the new node
        };
        putReq.onerror = e => reject(e.target.error);
        return;
      }

      node.hyperlights = node.hyperlights || [];
      // Add your highlight if missing
      if (!node.hyperlights.find(h => h.highlightID === highlightId)) {
        node.hyperlights.push({
          highlightID: highlightId,
          charStart: highlightStartOffset,
          charEnd: highlightEndOffset,
          is_user_highlight: true
        });
      }

      updatedNode = node; // 👈 SET: The updated node

      const putReq = store.put(updatedNode);
      putReq.onsuccess = () => {
        console.log(`Updated node [${book}, ${chunkId}] with highlight`);
        resolve(updatedNode); // 👈 RETURN the updated node
      };
      putReq.onerror = e => reject(e.target.error);
    };

    getRequest.onerror = e => reject(e.target.error);
  });
}

/**
 * Remove highlight from nodes table
 * @param {string} bookId - The book ID
 * @param {string} highlightId - The highlight ID to remove
 * @returns {Promise<Array>} Array of updated nodes
 */
export async function removeHighlightFromNodeChunks(bookId, highlightId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodes", "readwrite");
    const store = tx.objectStore("nodes");
    const updatedNodes = [];
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        let node = cursor.value;
        if (node.book === bookId && node.hyperlights && Array.isArray(node.hyperlights)) {
          const originalCount = node.hyperlights.length;
          // Filter out any entry that has the highlightID we want to remove.
          node.hyperlights = node.hyperlights.filter(
            (hl) => hl.highlightID !== highlightId
          );
          if (node.hyperlights.length !== originalCount) {
            // Update record in IndexedDB if a change was made.
            cursor.update(node);
            // 👈 ADD: Store the updated node for API sync
            updatedNodes.push(node);
            console.log(`Removed highlight ${highlightId} from node [${node.book}, ${node.startLine}]`);
          }
        }
        cursor.continue();

      } else {
        // 👈 CHANGE: Resolve with the updated nodes array
        console.log(`Highlight ${highlightId} removal complete. Updated ${updatedNodes.length} nodes.`);
        resolve(updatedNodes);
      }
    };

    request.onerror = (error) => {
      console.error("Error iterating nodes:", error);
      reject(error);
    };

    // Also catch transactional errors.
    tx.onerror = (error) => {
      console.error("Transaction error in nodes:", error);
      reject(error);
    };
  });
}

/**
 * Remove highlight from nodes but add deletion instruction for backend sync
 * @param {string} bookId - The book ID
 * @param {string} highlightId - The highlight ID to remove
 * @param {Object} deletedHighlightData - The deleted highlight data
 * @returns {Promise<Array>} Array of updated nodes with deletion instructions
 */
export async function removeHighlightFromNodeChunksWithDeletion(bookId, highlightId, deletedHighlightData) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodes", "readwrite");
    const store = tx.objectStore("nodes");
    const updatedNodes = [];
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        let node = cursor.value;
        if (node.book === bookId && node.hyperlights && Array.isArray(node.hyperlights)) {
          const originalCount = node.hyperlights.length;
          // Filter out any entry that has the highlightID we want to remove.
          node.hyperlights = node.hyperlights.filter(
            (hl) => hl.highlightID !== highlightId
          );
          if (node.hyperlights.length !== originalCount) {
            // Update record in IndexedDB if a change was made.
            cursor.update(node);

            // Create a copy for backend sync with deletion instruction
            const nodeForSync = { ...node };
            nodeForSync.hyperlights = [
              ...node.hyperlights, // Keep remaining highlights
              {
                highlightID: highlightId,
                _deleted: true
              }
            ];

            updatedNodes.push(nodeForSync);
            console.log(`Removed highlight ${highlightId} from node [${node.book}, ${node.startLine}] and prepared deletion instruction for backend`);
          }
        }
        cursor.continue();

      } else {
        console.log(`Highlight ${highlightId} removal complete. Updated ${updatedNodes.length} nodes with deletion instructions.`);
        resolve(updatedNodes);
      }
    };

    request.onerror = (error) => {
      console.error("Error iterating nodes:", error);
      reject(error);
    };

    tx.onerror = (error) => {
      console.error("Transaction error in nodes:", error);
      reject(error);
    };
  });
}

/**
 * Remove highlight directly from the hyperlights table
 * @param {string} highlightId - The highlight ID to remove
 * @returns {Promise<Object|null>} The deleted highlight data or null
 */
export async function removeHighlightFromHyperlights(highlightId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    let deletedHyperlight = null; // 👈 ADD: Track deleted hyperlight

    // Use the index to get the primary key from the hyperlight_id field.
    const index = store.index("hyperlight_id");
    const getKeyRequest = index.getKey(highlightId);

    getKeyRequest.onsuccess = (e) => {
      const primaryKey = e.target.result;
      if (primaryKey === undefined) {
        console.warn(`No record found for highlight ${highlightId}`);
        resolve(null); // 👈 CHANGE: Return null instead of undefined
        return;
      }

      // 👈 ADD: Get the full record before deleting it
      const getRecordRequest = store.get(primaryKey);
      getRecordRequest.onsuccess = (event) => {
        deletedHyperlight = event.target.result;

        // Now delete the record using its primary key.
        const deleteRequest = store.delete(primaryKey);
        deleteRequest.onsuccess = () => {
          console.log(`Highlight ${highlightId} removed from hyperlights store.`);
          // 👈 CHANGE: Resolve with the deleted hyperlight data
          resolve(deletedHyperlight);
        };

        deleteRequest.onerror = (error) => {
          console.error("Error deleting record from hyperlights:", error);
          reject(error);
        };
      };

      getRecordRequest.onerror = (error) => {
        console.error("Error getting record before deletion:", error);
        reject(error);
      };
    };

    getKeyRequest.onerror = (error) => {
      console.error(
        `Error looking up primary key for highlight ${highlightId}:`,
        error
      );
      reject(error);
    };

    tx.oncomplete = () =>
      console.log("Hyperlights removal transaction complete");
    tx.onerror = (error) =>
      console.error("Transaction error in hyperlights removal:", error);
  });
}
