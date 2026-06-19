/**
 * Hypercite Database Operations
 *
 * IndexedDB CRUD operations for hypercites.
 * Handles creation, retrieval, and updates of hypercite records.
 */

import { openDatabase, parseNodeId, createNodeKey, updateBookTimestamp, queueForSync, debouncedMasterSync, rebuildNodeArrays, getNodesByDataNodeIDs } from '../indexedDB/index';
import { findParentWithNumericalId } from './utils';
import type { BookId } from '../indexedDB/types';

// parseNodeId is referenced by the (commented-out) legacy node-embed path below.
void parseNodeId;

/** One element-span of a hypercite, produced by collectHyperciteData. */
export interface HyperciteBlock {
  startLine: string;
  dataNodeId: string | null;
  nodeBook: string | null;
  charStart: number;
  charEnd: number;
  elementType: string;
  hyperciteId: string;
}

/**
 * Fetch library record from server as fallback
 */
export async function fetchLibraryFromServer(bookId: BookId): Promise<any | null> {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')!.getAttribute('content') || '',
      },
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Server request failed: ${response.status}`);
    }

    const data = await response.json();

    // The API returns {success: true, library: {...}, book_id: ...}
    if (data && data.success && data.library) {
      if (data.library.bibtex) {
        return data.library;
      } else if (data.library.title || data.library.author) {
        // Create basic bibtex from available fields
        const basicBibtex = `@misc{${bookId},
  author = {${data.library.author || 'Unknown'}},
  title = {${data.library.title || 'Untitled'}},
  year = {${new Date().getFullYear()}},
}`;
        return {
          ...data.library,
          bibtex: basicBibtex
        };
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to fetch library record from server:', error);
    return null;
  }
}

/**
 * Get hypercite by ID from IndexedDB
 */
export async function getHyperciteById(db: IDBDatabase, hyperciteId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("hypercites", "readonly");
    const store = tx.objectStore("hypercites");
    const index = store.index("hyperciteId");
    const request = index.get(hyperciteId);

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(new Error(`Error retrieving hypercite: ${hyperciteId}`));
    };
  });
}

/**
 * Get hypercite data from IndexedDB by book and startLine
 * Retrieves node data containing hypercite information
 */
export async function getHyperciteData(book: BookId, startLine: string | number): Promise<any> {
  try {
    const db = await openDatabase();
    const tx = db.transaction("nodes", "readonly");
    const store = tx.objectStore("nodes");

    // Create the proper key for lookup
    const key = createNodeKey(book, startLine);
    console.log("Looking up hypercite data with key:", key);

    // Use the composite key [book, numericStartLine]
    const request = store.get(key);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error("Error retrieving hypercite data"));
      };
    });
  } catch (error) {
    console.error("Error accessing IndexedDB:", error);
    throw error;
  }
}

/**
 * Recursively get all text nodes from an element
 * Same logic as rendering system in lazyLoaderFactory.js
 */
function getTextNodes(element: Node): Text[] {
  let textNodes: Text[] = [];
  for (let node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      textNodes.push(node as Text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      textNodes.push(...getTextNodes(node));
    }
  }
  return textNodes;
}

/**
 * Collect hypercite data from DOM element
 * Extracts position and metadata from the wrapped hypercite element
 */
export function collectHyperciteData(hyperciteId: string, wrapper: HTMLElement): HyperciteBlock[] {
  console.log("Wrapper outerHTML:", wrapper.outerHTML);

  // Find nearest parent with a numeric id.
  const parentElement = findParentWithNumericalId(wrapper);
  if (!parentElement) {
    console.error(
      "No valid parent element with a numerical ID found for the <u> tag:",
      wrapper.outerHTML
    );
    return [];
  }

  const parentId = parentElement.id;

  // ✅ FIX: Calculate charStart/charEnd by walking DOM text nodes
  // This matches how the rendering system counts characters in applyHypercites()
  const textNodes = getTextNodes(parentElement);
  let charStart = -1;
  let charEnd = -1;
  let currentIndex = 0;
  let insideWrapper = false;

  for (const textNode of textNodes) {
    const nodeLength = (textNode.textContent || '').length;

    // Check if this text node is inside our specific wrapper element
    const isInsideThisWrapper = wrapper.contains(textNode);

    if (isInsideThisWrapper && !insideWrapper) {
      // First text node inside our wrapper - this is charStart
      charStart = currentIndex;
      insideWrapper = true;
    }

    if (insideWrapper && isInsideThisWrapper) {
      // Still inside our wrapper - update charEnd
      charEnd = currentIndex + nodeLength;
    }

    if (insideWrapper && !isInsideThisWrapper) {
      // We've exited the wrapper - stop
      break;
    }

    currentIndex += nodeLength;
  }

  if (charStart === -1 || charEnd === -1) {
    console.error(
      "Could not determine character positions for hypercite in parent.",
      "wrapper:", wrapper.outerHTML,
      "parent:", parentElement.outerHTML
    );
    charStart = 0;
    charEnd = wrapper.innerText.length;
  }

  console.log(`📍 Calculated positions for ${hyperciteId}: charStart=${charStart}, charEnd=${charEnd}`);

  // Get correct book + dataNodeId from the DOM element we already found
  const dataNodeId = parentElement.getAttribute('data-node-id');
  const nodeBook = parentElement.closest('[data-book-id]')?.getAttribute('data-book-id') || null;

  return [
    {
      startLine: parentId,
      dataNodeId,    // correct node ID from correct element (avoids getElementById collision)
      nodeBook,      // the node's actual book from DOM context
      charStart: charStart,
      charEnd: charEnd,
      elementType: parentElement.tagName.toLowerCase(),
      hyperciteId: hyperciteId,
    },
  ];
}

/**
 * Create new hypercite in IndexedDB and sync to PostgreSQL
 * Saves hypercite to both the main hypercites store and updates nodes
 */
export async function NewHyperciteIndexedDB(book: BookId, hyperciteId: string, blocks: HyperciteBlock[]): Promise<void> {
  // Open the IndexedDB database
  const db = await openDatabase();

  try {
    console.log("Attempting to add NEW hypercite with book:", book);
    console.log("NEW Hypercite ID:", hyperciteId);
    if (!book || !hyperciteId) {
      throw new Error(
        "Missing key properties: book or hyperciteId is undefined.",
      );
    }

    const tx = db.transaction(["hypercites", "nodes"], "readwrite");
    const hypercitesStore = tx.objectStore("hypercites");

    // Locate the created <u> node in the DOM by hyperciteId.
    const uElement = document.getElementById(hyperciteId);
    if (!uElement) {
      throw new Error("Hypercite element not found in DOM.");
    }

    // Remove <u> tag wrappers to get clean inner HTML
    const tempDiv = document.createElement("div");
    const clonedU = uElement.cloneNode(true);
    tempDiv.appendChild(clonedU);
    const uTags = tempDiv.querySelectorAll("u");
    uTags.forEach((uTag) => {
      const textNode = document.createTextNode(uTag.textContent || '');
      uTag.parentNode?.replaceChild(textNode, uTag);
    });

    // --- Define hypercitedHTML and hypercitedText AFTER extracting from DOM ---
    const hypercitedHTML = tempDiv.innerHTML;
    const hypercitedText = uElement.textContent;
    const overallStartChar = blocks.length > 0 ? blocks[0]!.charStart : 0;
    const overallEndChar =
      blocks.length > 0 ? blocks[blocks.length - 1]!.charEnd : 0;
    void overallStartChar; void overallEndChar;

    // ✅ NEW: Collect node_id array and charData object (like hyperlights)
    const nodeIdArray: string[] = [];
    const charDataByNode: Record<string, { charStart: number; charEnd: number }> = {};

    for (const block of blocks) {
      // Use dataNodeId directly from block — avoids getElementById collision across sub-books
      const dataNodeID = block.dataNodeId;

      if (dataNodeID) {
        nodeIdArray.push(dataNodeID);
        charDataByNode[dataNodeID] = {
          charStart: block.charStart,
          charEnd: block.charEnd
        };
      }
    }

    console.log(`📊 Hypercite ${hyperciteId} affects ${nodeIdArray.length} nodes:`, nodeIdArray);
    console.log(`📊 CharData:`, charDataByNode);

    // Build the initial hypercite record for the main hypercites store
    const hyperciteEntry = {
      book: book,
      hyperciteId: hyperciteId,
      node_id: nodeIdArray,
      charData: charDataByNode,
      hypercitedText: hypercitedText,
      hypercitedHTML: hypercitedHTML,
      relationshipStatus: "single",
      citedIN: [] as string[],
      time_since: Math.floor(Date.now() / 1000)
    };

    console.log("Hypercite record to add (main store):", hyperciteEntry);

    const putRequestHypercites = hypercitesStore.put(hyperciteEntry);
    putRequestHypercites.onerror = (event) => {
      console.error(
        "❌ Error upserting hypercite record in main store:",
        (event.target as IDBRequest).error,
      );
    };
    putRequestHypercites.onsuccess = () => {
      console.log("✅ Successfully upserted hypercite record in main store.");
    };

    // 🔄 OLD SYSTEM: COMMENTED OUT - Don't update embedded arrays in nodes table
    /*
    const nodesStore = tx.objectStore("nodes");
    const updatedNodes = [];

    for (const block of blocks) {
      console.log("Processing block for NEW hypercite:", block);
      if (block.startLine === undefined || block.startLine === null) {
        console.error("Block missing startLine:", block);
        continue;
      }

      const numericStartLine = parseNodeId(block.startLine);
      const key = createNodeKey(book, block.startLine);
      console.log("Looking up node for NEW hypercite with key:", key);

      const getRequest = nodesStore.get(key);

      const nodeRecord = await new Promise((resolve, reject) => {
        getRequest.onsuccess = (e) => resolve(e.target.result);
        getRequest.onerror = (e) => reject(e.target.error);
      });

      let updatedNodeRecord;

      if (nodeRecord) {
        console.log(
          "Existing node record found:",
          JSON.stringify(nodeRecord),
        );

        if (!Array.isArray(nodeRecord.hypercites)) {
          nodeRecord.hypercites = [];
          console.log(
            "⚠️ Created empty hypercites array in existing node",
          );
        }

        const existingHyperciteIndex = nodeRecord.hypercites.findIndex(
          (hc) => hc.hyperciteId === hyperciteId,
        );

        if (existingHyperciteIndex !== -1) {
          console.log(
            `Hypercite ${hyperciteId} already exists in node, updating position.`,
          );
          nodeRecord.hypercites[existingHyperciteIndex].charStart =
            block.charStart;
          nodeRecord.hypercites[existingHyperciteIndex].charEnd =
            block.charEnd;
        } else {
          console.log(
            `Adding new hypercite ${hyperciteId} to existing node.`,
          );
          nodeRecord.hypercites.push({
            hyperciteId: hyperciteId,
            charStart: block.charStart,
            charEnd: block.charEnd,
            relationshipStatus: "single",
            citedIN: [],
            time_since: Math.floor(Date.now() / 1000)
          });
        }

        updatedNodeRecord = nodeRecord;
      } else {
        console.log(
          "No existing node record, creating new one with startLine:",
          numericStartLine,
        );

        // NOTE: block.nodeId is a numeric startLine (id=""), NOT a data-node-id
        const blockElement = document.getElementById(block.nodeId);
        const nodeIdFromDOM = blockElement?.getAttribute('data-node-id');

        updatedNodeRecord = {
          book: book,
          startLine: numericStartLine,
          chunk_id: numericStartLine,
          node_id: nodeIdFromDOM || null,
          hypercites: [
            {
              hyperciteId: hyperciteId,
              charStart: block.charStart,
              charEnd: block.charEnd,
              relationshipStatus: "single",
              citedIN: [],
              time_since: Math.floor(Date.now() / 1000)
            },
          ],
        };
      }

      console.log(
        "Node record to put:",
        JSON.stringify(updatedNodeRecord),
      );

      console.log(
        "About to save node with hypercites:",
        JSON.stringify(updatedNodeRecord.hypercites, null, 2),
      );
      updatedNodes.push(updatedNodeRecord);

      const putRequestNode = nodesStore.put(updatedNodeRecord);
      await new Promise((resolve, reject) => {
        putRequestNode.onsuccess = () => {
          console.log(
            `✅ Updated node [${book}, ${block.startLine}] with NEW hypercite info.`,
          );

          const verifyRequest = nodesStore.get(
            createNodeKey(book, block.startLine),
          );
          verifyRequest.onsuccess = () => {
            console.log(
              "🔍 IMMEDIATELY AFTER SAVE - What was actually stored:",
              JSON.stringify(verifyRequest.result.hypercites, null, 2),
            );
          };

          resolve();
        };
        putRequestNode.onerror = (e) => {
          console.error("❌ Error updating node:", e.target.error);
          reject(e.target.error);
        };
      });
    }
    */

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject((e.target as IDBTransaction).error);
    });

    console.log("✅ NEW SYSTEM: Hypercite saved to normalized table");

    // ✅ NEW SYSTEM: Rebuild affected node arrays from normalized tables
    const allAffectedNodes = await getNodesByDataNodeIDs(nodeIdArray);
    // Filter to correct book — getNodesByDataNodeIDs may return a parent book's
    // node when the same node_id exists in both parent and sub-book.
    const affectedNodes = allAffectedNodes.filter((n: any) => n.book === book);
    await rebuildNodeArrays(affectedNodes);

    console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${affectedNodes.length} affected nodes`);

    // Queue hypercite for PostgreSQL sync
    await updateBookTimestamp(book);
    queueForSync("hypercites", hyperciteId, "update", hyperciteEntry);

    // 🔄 OLD SYSTEM: COMMENTED OUT - Don't queue node updates
    /*
    updatedNodes.forEach((chunk) => {
      queueForSync("nodes", chunk.startLine, "update", chunk);
    });
    */

    // Immediately flush sync queue for cross-device pasting
    console.log("⚡ NEW SYSTEM: Flushing sync queue immediately for new hypercite...");
    await debouncedMasterSync.flush();
    console.log("✅ NEW SYSTEM: Sync queue flushed.");

    // --- END: SOLUTION ---
  } catch (error) {
    console.error("❌ Error in NewHyperciteIndexedDB:", error);
  }
}
