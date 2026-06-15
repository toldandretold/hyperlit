/**
 * serverSync/clear — remove a book's data from IndexedDB before a fresh
 * hydrate, and rebuild the annotations embedded inside node records.
 *
 * Pull-side counterpart to syncQueue (push). Split out of the former
 * resources/js/postgreSQL.js.
 */
import { verbose } from '../../utilities/logger';

/**
 * Clear only annotations (hyperlights/hypercites) from IndexedDB for a specific book.
 */
export async function clearAnnotationsFromIndexedDB(db: IDBDatabase, bookId: string): Promise<void> {
  verbose.content(`Clearing annotations for book: ${bookId}`, 'serverSync/clear');

  const annotationStores = ['hyperlights', 'hypercites'];

  for (const storeName of annotationStores) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);

    try {
      const index = store.index('book');
      const request = index.openCursor(IDBKeyRange.only(bookId));

      await new Promise<void>((resolve, reject) => {
        request.onsuccess = (event: any) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });
    } catch (e: any) {
      verbose.content(`Error clearing ${storeName}: ${e.message}`, 'serverSync/clear');
    }
  }
}

/**
 * Update embedded hyperlights/hypercites within nodes store.
 * Nodes store each node with embedded annotations for rendering.
 * This function rebuilds embedded annotations from standalone hyperlights/hypercites.
 *
 * @param db - IndexedDB database
 * @param bookId - Book identifier
 * @param hyperlights - Standalone hyperlights from API (unfiltered)
 * @param hypercites - Standalone hypercites from API
 */
export async function updateEmbeddedAnnotationsInNodes(
  db: IDBDatabase,
  bookId: string,
  hyperlights: any[],
  hypercites: any[],
): Promise<void> {
  // Build lookup maps: node_id -> array of hyperlights/hypercites for that node
  const hyperlightsByNodeId = new Map<string, any[]>();
  const hypercitesByNodeId = new Map<string, any[]>();

  // Process hyperlights - each can span multiple nodes
  if (hyperlights && hyperlights.length > 0) {
    for (const hl of hyperlights) {
      // node_id is an array of node IDs this highlight spans
      const nodeIds = Array.isArray(hl.node_id) ? hl.node_id : [hl.node_id];
      const charData = hl.charData || {};

      for (const nodeId of nodeIds) {
        if (!nodeId) continue;

        // Get the char data specific to this node
        const nodeCharData = charData[nodeId] || {};

        // Create node-specific highlight entry (format expected by applyHighlights)
        const nodeHighlight = {
          hyperlight_id: hl.hyperlight_id,
          charStart: nodeCharData.charStart ?? 0,
          charEnd: nodeCharData.charEnd ?? 0,
          is_user_highlight: hl.is_user_highlight || false,
          annotation: hl.annotation,
          creator: hl.creator,
          highlightedText: hl.highlightedText,
        };

        if (!hyperlightsByNodeId.has(nodeId)) {
          hyperlightsByNodeId.set(nodeId, []);
        }
        hyperlightsByNodeId.get(nodeId)!.push(nodeHighlight);
      }
    }
  }

  // Process hypercites - each can span multiple nodes (like hyperlights)
  if (hypercites && hypercites.length > 0) {
    for (const hc of hypercites) {
      // node_id is an array of node IDs this hypercite spans
      const nodeIds = Array.isArray(hc.node_id) ? hc.node_id : [hc.node_id];
      const charData = hc.charData || {};

      for (const nodeId of nodeIds) {
        if (!nodeId) continue;

        // Get the char data specific to this node
        const nodeCharData = charData[nodeId] || {};

        // Create node-specific hypercite entry
        const nodeHypercite = {
          hyperciteId: hc.hyperciteId,
          charStart: nodeCharData.charStart ?? 0,
          charEnd: nodeCharData.charEnd ?? 0,
          hypercitedText: hc.hypercitedText,
          hypercitedHTML: hc.hypercitedHTML,
          relationshipStatus: hc.relationshipStatus,
          citedIN: hc.citedIN,
        };

        if (!hypercitesByNodeId.has(nodeId)) {
          hypercitesByNodeId.set(nodeId, []);
        }
        hypercitesByNodeId.get(nodeId)!.push(nodeHypercite);
      }
    }
  }

  verbose.content(`Built annotation lookup: ${hyperlightsByNodeId.size} nodes with highlights, ${hypercitesByNodeId.size} nodes with hypercites`, 'serverSync/clear');

  // Read all nodes for this book from IndexedDB (read transaction)
  const readTx = db.transaction('nodes', 'readonly');
  const readStore = readTx.objectStore('nodes');
  const index = readStore.index('book');

  const localNodes = await new Promise<any[]>((resolve, reject) => {
    const request = index.getAll(IDBKeyRange.only(bookId));
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });

  verbose.content(`Found ${localNodes.length} local nodes to update`, 'serverSync/clear');

  // Update nodes with fresh embedded annotations
  // Process in memory first, then write in a single batch
  const updatedNodes = localNodes.map((localNode: any) => {
    const nodeHighlights = hyperlightsByNodeId.get(localNode.node_id) || [];
    const nodeHypercites = hypercitesByNodeId.get(localNode.node_id) || [];

    // Update embedded annotations (always update, even if empty - clears deleted highlights)
    localNode.hyperlights = nodeHighlights;
    localNode.hypercites = nodeHypercites;

    return localNode;
  });

  // Write all updates in a new transaction (batch write)
  const writeTx = db.transaction('nodes', 'readwrite');
  const writeStore = writeTx.objectStore('nodes');

  for (const node of updatedNodes) {
    writeStore.put(node);
  }

  // Wait for transaction to complete
  await new Promise<void>((resolve, reject) => {
    writeTx.oncomplete = () => resolve();
    writeTx.onerror = () => reject(writeTx.error);
  });

  verbose.content(`Updated embedded annotations in ${updatedNodes.length} nodes`, 'serverSync/clear');
}

/**
 * Clear existing book data from IndexedDB
 */
export async function clearBookDataFromIndexedDB(db: IDBDatabase, bookId: string): Promise<void> {
  verbose.content(`Clearing existing data for book: ${bookId}`, 'serverSync/clear');

  // Clear stores that have book-based indices
  // NOTE: 'footnotes' has compound keyPath ["book", "footnoteId"] — must use 'book' index,
  // not store.delete(bookId) which silently no-ops on compound keys.
  const bookIndexedStores = ['nodes', 'hyperlights', 'hypercites', 'footnotes'];

  for (const storeName of bookIndexedStores) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const index = store.index('book');

    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = index.getAllKeys(bookId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    for (const key of keys) {
      await new Promise<void>((resolve, reject) => {
        const deleteRequest = store.delete(key);
        deleteRequest.onsuccess = () => resolve();
        deleteRequest.onerror = () => reject(deleteRequest.error);
      });
    }

    verbose.content(`Cleared ${keys.length} records from ${storeName}`, 'serverSync/clear');
  }

  // Clear library (uses citationID as key, which should match bookId)
  try {
    const tx = db.transaction('library', 'readwrite');
    const store = tx.objectStore('library');

    await new Promise<void>((resolve, reject) => {
      const deleteRequest = store.delete(bookId);
      deleteRequest.onsuccess = () => resolve();
      deleteRequest.onerror = () => reject(deleteRequest.error);
    });
    verbose.content('Cleared library for book', 'serverSync/clear');
  } catch (error) {
    verbose.content('No existing library record to clear', 'serverSync/clear');
  }
}
