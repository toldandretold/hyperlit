/**
 * Local Initial-Chunk Loader
 *
 * Returns the same envelope shape as the server's getInitialChunk response,
 * but sourced entirely from IndexedDB. Used when the local cache is fresh
 * or the device is offline.
 */

import { getNodeChunksFromIndexedDB } from '../indexedDB/nodes/read.js';
import { getLibraryObjectFromIndexedDB } from '../indexedDB/core/library.js';
import { openDatabase } from '../indexedDB/core/connection.js';
import { resolveTargetChunkId } from './resolveTargetChunk.js';
import { verbose } from '../utilities/logger.js';

/**
 * @param {string} bookId
 * @param {string|null} target - Navigation target (hypercite_, HL_, Fn, startLine, etc.)
 * @param {{ fallbackTarget?: string }} [opts]
 * @returns {Promise<Object>} Same shape as fetchInitialChunk() return value
 */
export async function loadInitialChunkLocal(bookId, target, opts = {}) {
  const { fallbackTarget = null } = opts;

  try {
    // 1. Get all nodes for this book from IndexedDB (already sorted by chunk_id)
    const allNodes = await getNodeChunksFromIndexedDB(bookId);
    if (!allNodes || allNodes.length === 0) {
      verbose.content(`No local nodes found for ${bookId}`, 'loadInitialChunkLocal.js');
      return { success: false, reason: 'no_local_data' };
    }

    // 2. Build chunk manifest from nodes
    const chunkMap = new Map();
    for (const node of allNodes) {
      const cid = node.chunk_id;
      if (!chunkMap.has(cid)) {
        chunkMap.set(cid, { chunk_id: cid, first_line: node.startLine, last_line: node.startLine, node_count: 1 });
      } else {
        const entry = chunkMap.get(cid);
        if (node.startLine < entry.first_line) entry.first_line = node.startLine;
        if (node.startLine > entry.last_line) entry.last_line = node.startLine;
        entry.node_count++;
      }
    }
    const chunkManifest = [...chunkMap.values()].sort((a, b) => a.chunk_id - b.chunk_id);

    // 3. Resolve which chunk to load
    const resolution = await resolveTargetChunkId(bookId, target, {
      fallbackTarget,
      chunkManifest,
    });

    let targetChunkId = resolution.chunkId;

    // Validate chunk exists in manifest
    const validChunkIds = chunkManifest.map(m => m.chunk_id);
    if (!validChunkIds.includes(targetChunkId)) {
      targetChunkId = validChunkIds[0] ?? 0;
    }

    // 4. Extract nodes for target chunk + adjacent chunks (same logic as server)
    const targetPos = validChunkIds.indexOf(targetChunkId);
    const startIdx = Math.max(0, targetPos - 1);
    const endIdx = Math.min(validChunkIds.length - 1, targetPos + 1);
    const chunksToInclude = new Set(validChunkIds.slice(startIdx, endIdx + 1));

    let initialNodes = allNodes.filter(n => chunksToInclude.has(n.chunk_id));

    // If too few nodes, include more adjacent chunks
    const minNodes = 20;
    if (initialNodes.length < minNodes && chunkManifest.length > 1) {
      // Try expanding range
      const expandStart = Math.max(0, startIdx - 1);
      const expandEnd = Math.min(validChunkIds.length - 1, endIdx + 1);
      const expandedChunks = new Set(validChunkIds.slice(expandStart, expandEnd + 1));
      initialNodes = allNodes.filter(n => expandedChunks.has(n.chunk_id));
    }

    // 5. Get library and footnotes from IndexedDB
    const [library, footnotes] = await Promise.all([
      getLibraryObjectFromIndexedDB(bookId),
      getFootnotesByBook(bookId),
    ]);

    verbose.content(
      `Local initial chunk: ${initialNodes.length} nodes (chunk ${targetChunkId}), ` +
      `${chunkManifest.length} total chunks, resolved=${resolution.resolved} (${resolution.reason})`,
      'loadInitialChunkLocal.js'
    );

    return {
      success: true,
      nodes: initialNodes,
      chunkManifest,
      targetChunkId,
      targetResolved: resolution.resolved,
      targetReason: resolution.reason,
      targetFallbackUsed: resolution.fallbackUsed,
      bookmark: null, // Not available from local cache
      library,
      footnotes: footnotes ? { book: bookId, data: footnotes } : null,
      metadata: {
        book_id: bookId,
        total_chunks: chunkManifest.length,
        loaded_chunk: targetChunkId,
        generated_at: new Date().toISOString(),
        source: 'local',
      },
    };
  } catch (error) {
    console.error('loadInitialChunkLocal failed:', error);
    return { success: false, reason: 'local_error', error: error.message };
  }
}

/**
 * Read all footnotes for a book from IndexedDB.
 * Returns an object { footnoteId: content, ... } or null.
 */
async function getFootnotesByBook(bookId) {
  try {
    const db = await openDatabase();
    const tx = db.transaction('footnotes', 'readonly');
    const store = tx.objectStore('footnotes');
    const index = store.index('book');

    return new Promise((resolve) => {
      const request = index.getAll(bookId);
      request.onsuccess = () => {
        const records = request.result || [];
        if (records.length === 0) { resolve(null); return; }
        const data = {};
        for (const rec of records) {
          data[rec.footnoteId] = rec.preview_nodes
            ? { content: rec.content, preview_nodes: rec.preview_nodes }
            : rec.content;
        }
        resolve(data);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
