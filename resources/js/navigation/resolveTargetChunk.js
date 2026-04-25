/**
 * Unified Target → Chunk Resolver (Client-side)
 *
 * Mirrors the server's resolveTargetChunkId branch order:
 *   1. chunk_id=N → direct
 *   2. hypercite_ → hypercites store → node_id → nodes.chunk_id
 *   3. HL_ → hyperlights store → node_id → nodes.chunk_id
 *   4. Fn (footnote pattern) → scan nodes.footnotes
 *   5. Numeric → nodes by startLine
 *   6. Any other → regex over nodes.content for id="<target>"
 *   7. fallback_target → retry 2-6
 *   8. Saved scroll position
 *   9. Lowest existing chunk_id from manifest
 *
 * Returns { chunkId, resolved, reason, fallbackUsed }
 */

import { openDatabase } from '../indexedDB/core/connection.js';

import { verbose } from '../utilities/logger.js';

/**
 * @param {string} bookId
 * @param {string|null} target
 * @param {{ fallbackTarget?: string, chunkManifest?: Array, nodes?: Array }} [opts]
 * @returns {Promise<{ chunkId: number, resolved: boolean, reason: string, fallbackUsed: string|null }>}
 */
export async function resolveTargetChunkId(bookId, target, opts = {}) {
  const { fallbackTarget = null, chunkManifest = null, nodes = null } = opts;

  // Step 1: Direct chunk_id (numeric string prefixed with "chunk_")
  // Not typically used client-side, but included for contract parity
  if (target && /^chunk_\d+$/.test(target)) {
    return { chunkId: parseInt(target.replace('chunk_', ''), 10), resolved: true, reason: 'direct', fallbackUsed: null };
  }

  // Steps 2-6: Try resolving the primary target via IndexedDB
  if (target) {
    let result = await resolveTargetToChunkIdLocal(bookId, target);

    // Fallback: scan in-memory nodes if IndexedDB lookup failed.
    // Handles the case where editor saves cleared embedded arrays in IDB
    // but the in-memory nodes were re-hydrated with current data.
    if (result === null && nodes && nodes.length > 0) {
      result = resolveTargetInMemory(target, nodes);
    }

    if (result !== null) {
      verbose.nav(`Resolved target "${target}" → chunk ${result.chunkId} (${result.reason})`, 'resolveTargetChunk.js');
      return { ...result, resolved: true, fallbackUsed: null };
    }

    // Step 7: Fallback target → retry steps 2-6
    if (fallbackTarget) {
      const fallbackResult = await resolveTargetToChunkIdLocal(bookId, fallbackTarget);
      if (fallbackResult !== null) {
        verbose.nav(`Fallback target "${fallbackTarget}" → chunk ${fallbackResult.chunkId} (${fallbackResult.reason})`, 'resolveTargetChunk.js');
        return { chunkId: fallbackResult.chunkId, resolved: false, reason: 'fallback_target', fallbackUsed: fallbackResult.reason };
      }
    }

    // Step 8: Saved scroll position (sessionStorage)
    const savedChunk = getSavedPosition(bookId);
    if (savedChunk !== null) {
      verbose.nav(`Target "${target}" not found, using saved position chunk ${savedChunk}`, 'resolveTargetChunk.js');
      return { chunkId: savedChunk, resolved: false, reason: 'saved_position', fallbackUsed: 'saved_position' };
    }

    // Step 9: Lowest existing chunk_id
    const lowestChunk = getLowestChunkId(chunkManifest);
    verbose.nav(`Target "${target}" not found, falling back to lowest chunk ${lowestChunk}`, 'resolveTargetChunk.js');
    return { chunkId: lowestChunk, resolved: false, reason: 'lowest_chunk', fallbackUsed: 'lowest_chunk' };
  }

  // No target — check saved position
  const savedChunk = getSavedPosition(bookId);
  if (savedChunk !== null) {
    return { chunkId: savedChunk, resolved: true, reason: 'saved_position', fallbackUsed: null };
  }

  // Default: lowest chunk
  return { chunkId: getLowestChunkId(chunkManifest), resolved: true, reason: 'lowest_chunk', fallbackUsed: null };
}

/**
 * Try to resolve a single target to a chunk_id from IndexedDB.
 * Returns { chunkId, reason } or null.
 */
async function resolveTargetToChunkIdLocal(bookId, target) {
  // Step 2: Hypercite
  if (target.startsWith('hypercite_')) {
    const chunkId = await resolveHyperciteChunk(bookId, target);
    if (chunkId !== null) {
      return { chunkId, reason: 'hypercite' };
    }
  }

  // Step 3: Hyperlight
  if (target.startsWith('HL_')) {
    const chunkId = await resolveHyperlightChunk(bookId, target);
    if (chunkId !== null) {
      return { chunkId, reason: 'hyperlight' };
    }
  }

  // Step 4: Footnote
  if (/(^|_)Fn\d/.test(target)) {
    const chunkId = await resolveFootnoteChunk(bookId, target);
    if (chunkId !== null) {
      return { chunkId, reason: 'footnote' };
    }
  }

  // Step 5: Numeric startLine
  if (/^\d+(\.\d+)?$/.test(target)) {
    const chunkId = await resolveStartLineChunk(bookId, parseFloat(target));
    if (chunkId !== null) {
      return { chunkId, reason: 'startLine' };
    }
  }

  // Step 6: Content scan — find id="<target>" in node content,
  // OR in the embedded hypercites/hyperlights arrays (which may have data
  // even when the standalone stores are empty, e.g. after editor clears arrays)
  const chunkId = await resolveContentScanChunk(bookId, target);
  if (chunkId !== null) {
    return { chunkId, reason: 'content_scan' };
  }

  return null;
}

// ── Branch implementations ──────────────────────────────────────────

async function resolveHyperciteChunk(bookId, hyperciteId) {
  try {
    // Local-only lookup — no server fallback. If the hypercite isn't in
    // local IDB (e.g. citation arrows), the resolver's content-scan
    // fallback (step 6) will find it instead.
    const { getHyperciteFromIndexedDB } = await import('../indexedDB/hypercites/index.js');
    const record = await getHyperciteFromIndexedDB(bookId, hyperciteId);
    if (record && Array.isArray(record.node_id) && record.node_id.length > 0) {
      return await nodeIdToChunkId(bookId, record.node_id[0]);
    }
  } catch (e) {
    console.warn('resolveHyperciteChunk failed:', e);
  }
  return null;
}

async function resolveHyperlightChunk(bookId, hyperlightId) {
  try {
    const db = await openDatabase();
    const tx = db.transaction('hyperlights', 'readonly');
    const store = tx.objectStore('hyperlights');

    const record = await idbGet(store, [bookId, hyperlightId]);
    if (record && Array.isArray(record.node_id) && record.node_id.length > 0) {
      return await nodeIdToChunkId(bookId, record.node_id[0]);
    }
  } catch (e) {
    console.warn('resolveHyperlightChunk failed:', e);
  }
  return null;
}

async function resolveFootnoteChunk(bookId, target) {
  try {
    const db = await openDatabase();
    const tx = db.transaction('nodes', 'readonly');
    const store = tx.objectStore('nodes');
    const index = store.index('book');

    return new Promise((resolve) => {
      const request = index.openCursor(bookId);
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(null); return; }

        const node = cursor.value;
        if (Array.isArray(node.footnotes) && node.footnotes.length > 0 && node.footnotes.includes(target)) {
          resolve(node.chunk_id);
          return;
        }
        cursor.continue();
      };
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    console.warn('resolveFootnoteChunk failed:', e);
    return null;
  }
}

async function resolveStartLineChunk(bookId, startLine) {
  try {
    const db = await openDatabase();
    const tx = db.transaction('nodes', 'readonly');
    const store = tx.objectStore('nodes');

    // Primary key is [book, startLine] — direct O(1) lookup
    const node = await idbGet(store, [bookId, startLine]);
    if (node) return node.chunk_id;
  } catch (e) {
    console.warn('resolveStartLineChunk failed:', e);
  }
  return null;
}

async function resolveContentScanChunk(bookId, target) {
  try {
    const db = await openDatabase();
    const tx = db.transaction('nodes', 'readonly');
    const store = tx.objectStore('nodes');
    const index = store.index('book');
    const regex = new RegExp(`id=['"]${escapeRegex(target)}['"]`, 'i');
    const normalizedTarget = target.toLowerCase();

    return new Promise((resolve) => {
      const request = index.openCursor(bookId);
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(null); return; }

        const node = cursor.value;

        // Check raw content for id="<target>"
        if (node.content && regex.test(node.content)) {
          resolve(node.chunk_id);
          return;
        }

        // Check embedded hypercites array (populated by hydration,
        // may have data even when standalone store is empty)
        if (Array.isArray(node.hypercites)) {
          for (const cite of node.hypercites) {
            if (cite.hyperciteId && cite.hyperciteId.toLowerCase() === normalizedTarget) {
              resolve(node.chunk_id);
              return;
            }
          }
        }

        // Check embedded hyperlights array
        if (Array.isArray(node.hyperlights)) {
          for (const light of node.hyperlights) {
            if (light.highlightID && light.highlightID.toLowerCase() === normalizedTarget) {
              resolve(node.chunk_id);
              return;
            }
          }
        }

        cursor.continue();
      };
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    console.warn('resolveContentScanChunk failed:', e);
    return null;
  }
}

// ── In-memory fallback (mirrors old findLineForCustomId) ────────────

/**
 * Scan in-memory nodes array for the target.
 * Checks content, embedded hypercites, and embedded hyperlights.
 * Used when IndexedDB lookups fail (e.g. stale embedded arrays).
 */
function resolveTargetInMemory(target, nodes) {
  const normalizedTarget = target.toLowerCase();
  const regex = new RegExp(`id=['"]${escapeRegex(target)}['"]`, 'i');

  for (const node of nodes) {
    // Check content
    if (node.content && regex.test(node.content)) {
      return { chunkId: node.chunk_id, reason: 'content_scan' };
    }

    // Check embedded hypercites
    if (Array.isArray(node.hypercites)) {
      for (const cite of node.hypercites) {
        if (cite.hyperciteId && cite.hyperciteId.toLowerCase() === normalizedTarget) {
          return { chunkId: node.chunk_id, reason: 'hypercite' };
        }
      }
    }

    // Check embedded hyperlights
    if (Array.isArray(node.hyperlights)) {
      for (const light of node.hyperlights) {
        if (light.highlightID && light.highlightID.toLowerCase() === normalizedTarget) {
          return { chunkId: node.chunk_id, reason: 'hyperlight' };
        }
      }
    }
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────

async function nodeIdToChunkId(bookId, nodeId) {
  try {
    const db = await openDatabase();
    const tx = db.transaction('nodes', 'readonly');
    const store = tx.objectStore('nodes');
    const index = store.index('node_id');

    return new Promise((resolve) => {
      const request = index.getAll(nodeId);
      request.onsuccess = () => {
        const results = request.result || [];
        const match = results.find(n => n.book === bookId);
        resolve(match ? match.chunk_id : null);
      };
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    console.warn('nodeIdToChunkId failed:', e);
    return null;
  }
}

function idbGet(store, key) {
  return new Promise((resolve) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

function getSavedPosition(bookId) {
  try {
    const key = `scrollPosition_${bookId}`;
    const saved = sessionStorage.getItem(key);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed.chunkId === 'number') {
        return parsed.chunkId;
      }
    }
  } catch {
    // sessionStorage not available or invalid data
  }
  return null;
}

function getLowestChunkId(chunkManifest) {
  if (Array.isArray(chunkManifest) && chunkManifest.length > 0) {
    return chunkManifest[0].chunk_id;
  }
  return 0;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
