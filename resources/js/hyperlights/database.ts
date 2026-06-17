/**
 * Database module - Handles IndexedDB operations for hyperlights
 */

import { book } from '../app';
import { openDatabase, parseNodeId, createNodeChunksKey } from '../indexedDB/index';
import { getAuthContextSync, getAuthContext } from '../utilities/auth/index';
import type { BookId } from '../indexedDB/types';

interface AuthUser { name?: string; username?: string; email?: string }
interface AuthContext { user: AuthUser | null; userId: string | null }

interface CharRange { charStart: number; charEnd: number }

/** Input passed to addToHighlightsTable by the selection/marking flow. */
export interface HighlightInput {
  highlightId: string;
  charData?: Record<string, CharRange>;
  text: string;
  startLine: number;
}

/** The row written to the `hyperlights` store. */
export interface HighlightEntry {
  book: BookId;
  hyperlight_id: string;
  node_id: string[];
  charData: Record<string, CharRange>;
  highlightedText: string;
  highlightedHTML: string;
  annotation: string;
  startLine: number;
  creator: string | null;
  creator_token: string | null;
  time_since: number;
  is_user_highlight: boolean;
}

/** Hyperlight as embedded on a node record. */
interface NodeHyperlightEmbed { highlightID: string; charStart: number; charEnd: number; is_user_highlight: boolean }

/**
 * Add a new highlight to the hyperlights table
 */
export async function addToHighlightsTable(bookId: BookId, highlightData: HighlightInput): Promise<HighlightEntry> {
  const db = await openDatabase();

  return new Promise<HighlightEntry>(async (resolve, reject) => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");

    // ✅ PERF: Single sync auth lookup (no microtask hops)
    const auth: AuthContext = getAuthContextSync() || await getAuthContext();
    const { user, userId: currentUserId } = auth;

    const creator = user ? (user.name || user.username || user.email || null) : null;
    const creator_token = user ? null : currentUserId; // For anon users, currentUserId IS the token

    console.log("💾 Saving to IndexedDB with auth:", { creator, creator_token, currentUserId });

    // Create a document fragment to hold the highlighted content
    const fragment = document.createDocumentFragment();
    const selection = window.getSelection()!;
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
      const textNode = document.createTextNode(mark.textContent || '');
      // Replace the mark with its text content
      mark.parentNode?.replaceChild(textNode, mark);
    });

    const highlightedHTML = tempDiv.innerHTML;

    const highlightEntry: HighlightEntry = {
      book: bookId,
      hyperlight_id: highlightData.highlightId,
      node_id: Object.keys(highlightData.charData || {}),
      charData: highlightData.charData || {},
      highlightedText: highlightData.text,
      highlightedHTML: highlightedHTML,
      annotation: "",
      startLine: highlightData.startLine,
      creator: creator,
      creator_token: creator_token,
      time_since: Math.floor(Date.now() / 1000),
      is_user_highlight: true  // Always true for locally-created highlights
    };

    console.log(`💾 Saving highlight to IndexedDB:`);
    console.log(`   book: ${bookId}`);
    console.log(`   hyperlight_id: ${highlightData.highlightId}`);
    console.log(`   node_ids: ${JSON.stringify(highlightEntry.node_id)}`);
    console.log(`   startLine: ${highlightData.startLine}`);
    console.log(`   text: "${highlightData.text?.substring(0, 40)}..."`);

    const addRequest = store.put(highlightEntry);

    addRequest.onsuccess = () => {
      console.log("✅ Successfully added highlight to hyperlights table");
    };

    addRequest.onerror = (event) => {
      console.error("❌ Error adding highlight to hyperlights table:", (event.target as IDBRequest).error);
      reject((event.target as IDBRequest).error);
    };

    // ✅ FIX: Wait for transaction to complete before resolving
    // This ensures the data is committed and visible to subsequent readonly transactions
    tx.oncomplete = () => {
      console.log("✅ Transaction committed - highlight is now visible to other transactions");
      resolve(highlightEntry);
    };

    tx.onerror = (event) => {
      console.error("❌ Transaction error:", (event.target as IDBTransaction).error);
      reject((event.target as IDBTransaction).error);
    };
  });
}

/**
 * Update a node with a new highlight in the nodes table
 */
export async function updateNodeHighlight(
  bookId: BookId,
  chunkId: string | number,
  highlightStartOffset: number,
  highlightEndOffset: number,
  highlightId: string
): Promise<any> {
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
      let updatedNode: any; // 👈 ADD: Variable to track the updated node

      if (!node) {
        console.warn(`No nodes record for key [${book}, ${chunkId}]`);

        // Create a new node if it doesn't exist
        updatedNode = {
          book: book,
          startLine: parseNodeId(chunkId),  // Store as number
          chunk_id: parseNodeId(chunkId),
          content: document.getElementById(String(chunkId))?.innerHTML || "",
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
        putReq.onerror = e => reject((e.target as IDBRequest).error);
        return;
      }

      node.hyperlights = node.hyperlights || [];
      // Add your highlight if missing
      if (!node.hyperlights.find((h: NodeHyperlightEmbed) => h.highlightID === highlightId)) {
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
      putReq.onerror = e => reject((e.target as IDBRequest).error);
    };

    getRequest.onerror = e => reject((e.target as IDBRequest).error);
  });
}

/**
 * Remove highlight from nodes table
 */
export async function removeHighlightFromNodeChunks(bookId: BookId, highlightId: string): Promise<any[]> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodes", "readwrite");
    const store = tx.objectStore("nodes");
    const updatedNodes: any[] = [];
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        let node = cursor.value;
        if (node.book === bookId && node.hyperlights && Array.isArray(node.hyperlights)) {
          const originalCount = node.hyperlights.length;
          // Filter out any entry that has the highlightID we want to remove.
          node.hyperlights = node.hyperlights.filter(
            (hl: NodeHyperlightEmbed) => hl.highlightID !== highlightId
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
 */
export async function removeHighlightFromNodeChunksWithDeletion(bookId: BookId, highlightId: string, deletedHighlightData?: unknown): Promise<any[]> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("nodes", "readwrite");
    const store = tx.objectStore("nodes");
    const updatedNodes: any[] = [];
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        let node = cursor.value;
        if (node.book === bookId && node.hyperlights && Array.isArray(node.hyperlights)) {
          const originalCount = node.hyperlights.length;
          // Filter out any entry that has the highlightID we want to remove.
          node.hyperlights = node.hyperlights.filter(
            (hl: NodeHyperlightEmbed) => hl.highlightID !== highlightId
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
 */
export async function removeHighlightFromHyperlights(highlightId: string): Promise<any | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("hyperlights", "readwrite");
    const store = tx.objectStore("hyperlights");
    let deletedHyperlight: any = null; // 👈 ADD: Track deleted hyperlight

    // Use the index to get the primary key from the hyperlight_id field.
    const index = store.index("hyperlight_id");
    const getKeyRequest = index.getKey(highlightId);

    getKeyRequest.onsuccess = (e) => {
      const primaryKey = (e.target as IDBRequest).result;
      if (primaryKey === undefined) {
        console.warn(`No record found for highlight ${highlightId}`);
        resolve(null); // 👈 CHANGE: Return null instead of undefined
        return;
      }

      // 👈 ADD: Get the full record before deleting it
      const getRecordRequest = store.get(primaryKey);
      getRecordRequest.onsuccess = (event) => {
        deletedHyperlight = (event.target as IDBRequest).result;

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
