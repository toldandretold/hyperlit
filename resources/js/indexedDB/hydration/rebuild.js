/**
 * Hydration Module
 *
 * Rebuilds node.hyperlights, node.hypercites, and node.footnotes arrays.
 * This is the NEW SYSTEM philosophy: arrays in nodes table are computed views,
 * rebuilt on-demand from the normalized hyperlights and hypercites tables,
 * and footnotes extracted from HTML content.
 *
 * Philosophy:
 * - Normalized tables (hyperlights, hypercites) are the source of truth
 * - node.hyperlights and node.hypercites arrays are denormalized caches for fast rendering
 * - node.footnotes is rebuilt from HTML content (extracted from footnote links)
 * - Arrays are NEVER updated directly - always rebuilt from source
 * - Enables dynamic filtering, live updates, and clean separation of concerns
 */

import { openDatabase } from '../core/connection.js';
import { verbose } from '../../utilities/logger.js';

/**
 * Rebuild hyperlights and hypercites arrays for specific nodes
 * Queries normalized tables and populates node arrays based on node_id and charData
 *
 * @param {Array} nodes - Array of node objects to rebuild
 * @returns {Promise<void>}
 */
export async function rebuildNodeArrays(nodes) {
  if (!nodes || nodes.length === 0) {
    console.warn('⚠️ rebuildNodeArrays: No nodes provided');
    return;
  }

  const db = await openDatabase();
  const nodeUUIDs = nodes.map(n => n.node_id).filter(Boolean);

  if (nodeUUIDs.length === 0) {
    console.warn('⚠️ rebuildNodeArrays: No valid node UUIDs found', nodes);
    return;
  }

  verbose.content(`NEW SYSTEM: Rebuilding arrays for ${nodeUUIDs.length} nodes`, 'indexedDB/hydration/rebuild.js');

  try {
    // Query normalized tables for all relevant hyperlights/hypercites
    const hyperlights = await queryHyperlightsByNodes(db, nodeUUIDs);
    const hypercites = await queryHypercitesByNodes(db, nodeUUIDs);

    verbose.content(`NEW SYSTEM: Found ${hyperlights.length} hyperlights, ${hypercites.length} hypercites for these nodes`, 'indexedDB/hydration/rebuild.js');

    // Build arrays for each node from normalized data
    nodes.forEach(node => {
      node.hyperlights = buildHyperlightsForNode(node, hyperlights);
      node.hypercites = buildHypercitesForNode(node, hypercites);

      // Rebuild footnotes array from HTML content
      // Only overwrite if extraction found IDs; preserve existing otherwise
      const extractedFootnotes = extractFootnoteIdsFromContent(node.content);
      if (extractedFootnotes.length > 0) {
        node.footnotes = extractedFootnotes;
      } else if (!node.footnotes) {
        node.footnotes = [];
      }
      // If extractedFootnotes is empty but node.footnotes exists, keep existing (old format compatibility)

      verbose.content(`NEW SYSTEM: Node ${node.node_id} rebuilt with ${node.hyperlights.length} hyperlights, ${node.hypercites.length} hypercites, ${(node.footnotes || []).length} footnotes`, 'indexedDB/hydration/rebuild.js');
    });

    // Update nodes in IndexedDB with new arrays
    await updateNodesInDB(db, nodes);

    verbose.content(`NEW SYSTEM: Successfully rebuilt arrays for ${nodes.length} nodes`, 'indexedDB/hydration/rebuild.js');
  } catch (error) {
    console.error('❌ NEW SYSTEM: Error rebuilding node arrays:', error);
    throw error;
  }
}

/**
 * Query hyperlights that affect specific nodes
 * Uses node_id multi-entry index for fast O(k) lookups instead of O(N) full scan
 *
 * @param {IDBDatabase} db - IndexedDB database
 * @param {Array<string>} nodeUUIDs - Node UUIDs to query
 * @returns {Promise<Array>} - Hyperlights affecting these nodes
 */
async function queryHyperlightsByNodes(db, nodeUUIDs) {
  const tx = db.transaction('hyperlights', 'readonly');
  const store = tx.objectStore('hyperlights');

  // 🔍 DEBUG: Check if index exists
  verbose.content(`DEBUG: Available indexes: ${Array.from(store.indexNames).join(', ')}`, 'indexedDB/hydration/rebuild.js');

  if (!store.indexNames.contains('node_id')) {
    console.error('❌ CRITICAL: node_id index does not exist on hyperlights store!');
    console.error('❌ Database needs to be upgraded to version 24');
    return [];
  }

  const index = store.index('node_id'); // Multi-entry index on node_id array

  // Use a Set to deduplicate (a hyperlight spanning multiple nodes will be found multiple times)
  const resultsMap = new Map(); // Use Map to deduplicate by hyperlight_id

  // 🔍 DEBUG: Let's also check what's in the store directly
  const allRequest = store.getAll();
  const allHyperlights = await new Promise((resolve, reject) => {
    allRequest.onsuccess = () => resolve(allRequest.result || []);
    allRequest.onerror = () => reject(allRequest.error);
  });
  verbose.content(`DEBUG: Total hyperlights in store: ${allHyperlights.length}`, 'indexedDB/hydration/rebuild.js');
  verbose.content(`DEBUG: Looking for nodeUUIDs: ${nodeUUIDs.join(', ')}`, 'indexedDB/hydration/rebuild.js');
  verbose.content(`DEBUG: Hyperlights node_id fields checked (${allHyperlights.length} items)`, 'indexedDB/hydration/rebuild.js');

  // Query each UUID using the index - each query is O(1) with the index
  for (const uuid of nodeUUIDs) {
    verbose.content(`DEBUG: Querying index for UUID: ${uuid}`, 'indexedDB/hydration/rebuild.js');
    const req = index.getAll(uuid);
    const matches = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    verbose.content(`DEBUG: Found ${matches.length} matches for UUID ${uuid}`, 'indexedDB/hydration/rebuild.js');

    // Add to map, keyed by hyperlight_id to avoid duplicates
    matches.forEach(hl => {
      if (hl && hl.hyperlight_id) {
        resultsMap.set(hl.hyperlight_id, hl);
      }
    });
  }

  // 🔍 DEBUG: Fallback - manually filter all hyperlights if index returned nothing
  if (resultsMap.size === 0 && allHyperlights.length > 0) {
    verbose.content('DEBUG: Index returned no results, falling back to manual filtering', 'indexedDB/hydration/rebuild.js');
    allHyperlights.forEach(hl => {
      if (hl && hl.node_id && Array.isArray(hl.node_id)) {
        const hasMatch = hl.node_id.some(id => nodeUUIDs.includes(id));
        if (hasMatch) {
          verbose.content(`DEBUG: Manual filter found match: ${hl.hyperlight_id}`, 'indexedDB/hydration/rebuild.js');
          resultsMap.set(hl.hyperlight_id, hl);
        }
      }
    });
  }

  const results = Array.from(resultsMap.values());
  verbose.content(`NEW SYSTEM: Queried hyperlights index for ${nodeUUIDs.length} nodes, found ${results.length} hyperlights`, 'indexedDB/hydration/rebuild.js');

  return results;
}

/**
 * Query hypercites that affect specific nodes
 * Uses node_id multi-entry index for fast O(k) lookups instead of O(N) full scan
 *
 * @param {IDBDatabase} db - IndexedDB database
 * @param {Array<string>} nodeUUIDs - Node UUIDs to query
 * @returns {Promise<Array>} - Hypercites affecting these nodes
 */
async function queryHypercitesByNodes(db, nodeUUIDs) {
  const tx = db.transaction('hypercites', 'readonly');
  const store = tx.objectStore('hypercites');
  const index = store.index('node_id'); // Multi-entry index on node_id array

  // Use a Map to deduplicate (a hypercite spanning multiple nodes will be found multiple times)
  const resultsMap = new Map(); // Use Map to deduplicate by hyperciteId

  // Query each UUID using the index - each query is O(1) with the index
  for (const uuid of nodeUUIDs) {
    const req = index.getAll(uuid);
    const matches = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    // Add to map, keyed by hyperciteId to avoid duplicates
    matches.forEach(hc => {
      if (hc && hc.hyperciteId) {
        resultsMap.set(hc.hyperciteId, hc);
      }
    });
  }

  const results = Array.from(resultsMap.values());
  verbose.content(`NEW SYSTEM: Queried hypercites index for ${nodeUUIDs.length} nodes, found ${results.length} hypercites`, 'indexedDB/hydration/rebuild.js');

  return results;
}

/**
 * Build hyperlights array for a specific node
 * Extracts per-node position data from charData object
 *
 * @param {Object} node - Node object with node_id
 * @param {Array} allHyperlights - All hyperlights affecting this node
 * @returns {Array} - Array of hyperlight objects for this node
 */
function buildHyperlightsForNode(node, allHyperlights) {
  if (!node.node_id) {
    console.warn('⚠️ NEW SYSTEM: Node missing node_id, cannot build hyperlights', node);
    return [];
  }

  console.log(`[DEBUG buildHyperlightsForNode] node.node_id=${node.node_id}, node.book=${node.book} (type: ${typeof node.book})`);
  allHyperlights.forEach(hl => {
    const nodeMatch = hl.node_id.includes(node.node_id);
    const bookMatch = hl.book === node.book;
    console.log(`  hl.hyperlight_id=${hl.hyperlight_id}, hl.book=${hl.book} (type: ${typeof hl.book}), hl.node_id=${JSON.stringify(hl.node_id)}, nodeMatch=${nodeMatch}, bookMatch=${bookMatch}`);
  });

  return allHyperlights
    .filter(hl => hl.node_id.includes(node.node_id) && hl.book === node.book)
    .map(hl => {
      // Extract per-node position from charData
      const charData = hl.charData?.[node.node_id];

      if (!charData) {
        console.warn(`⚠️ NEW SYSTEM: No charData for highlight ${hl.hyperlight_id} on node ${node.node_id}`, hl);
        return null;
      }

      // Build hyperlight object in the format expected by renderer
      return {
        highlightID: hl.hyperlight_id,
        charStart: charData.charStart,
        charEnd: charData.charEnd,
        annotation: hl.annotation,
        is_user_highlight: hl.is_user_highlight,
        hidden: hl.hidden || false,
        time_since: hl.time_since,
      };
    })
    .filter(Boolean); // Remove nulls from missing charData
}

/**
 * Build hypercites array for a specific node
 * Extracts per-node position data from charData object
 *
 * @param {Object} node - Node object with node_id
 * @param {Array} allHypercites - All hypercites affecting this node
 * @returns {Array} - Array of hypercite objects for this node
 */
function buildHypercitesForNode(node, allHypercites) {
  if (!node.node_id) {
    console.warn('⚠️ NEW SYSTEM: Node missing node_id, cannot build hypercites', node);
    return [];
  }

  return allHypercites
    .filter(hc => hc.node_id.includes(node.node_id))
    .map(hc => {
      // Extract per-node position from charData
      const charData = hc.charData?.[node.node_id];

      if (!charData) {
        console.warn(`⚠️ NEW SYSTEM: No charData for hypercite ${hc.hyperciteId} on node ${node.node_id}`, hc);
        return null;
      }

      // Build hypercite object in the format expected by renderer
      return {
        hyperciteId: hc.hyperciteId,
        charStart: charData.charStart,
        charEnd: charData.charEnd,
        relationshipStatus: hc.relationshipStatus,
        citedIN: hc.citedIN || [],
        time_since: hc.time_since,
      };
    })
    .filter(Boolean); // Remove nulls from missing charData
}

/**
 * Update nodes in IndexedDB with rebuilt arrays
 *
 * @param {IDBDatabase} db - IndexedDB database
 * @param {Array} nodes - Nodes with rebuilt arrays
 * @returns {Promise<void>}
 */
async function updateNodesInDB(db, nodes) {
  const tx = db.transaction('nodes', 'readwrite');
  const store = tx.objectStore('nodes');

  for (const node of nodes) {
    const key = [node.book, node.startLine];

    await new Promise((resolve, reject) => {
      const req = store.put(node);
      req.onsuccess = () => {
        verbose.content(`NEW SYSTEM: Updated node ${node.node_id} in IndexedDB`, 'indexedDB/hydration/rebuild.js');
        resolve();
      };
      req.onerror = () => {
        console.error(`❌ NEW SYSTEM: Failed to update node ${node.node_id}:`, req.error);
        reject(req.error);
      };
    });
  }

  verbose.content(`NEW SYSTEM: Updated ${nodes.length} nodes in IndexedDB`, 'indexedDB/hydration/rebuild.js');
}

/**
 * Get nodes from IndexedDB by their UUIDs
 * Uses node_id index for fast O(k) lookups instead of O(N) full scan
 *
 * @param {Array<string>} nodeUUIDs - Node UUIDs to fetch
 * @returns {Promise<Array>} - Array of node objects
 */
export async function getNodesByUUIDs(nodeUUIDs) {
  if (!nodeUUIDs || nodeUUIDs.length === 0) {
    console.warn('⚠️ NEW SYSTEM: No node UUIDs provided to getNodesByUUIDs');
    return [];
  }

  const db = await openDatabase();
  const tx = db.transaction('nodes', 'readonly');
  const store = tx.objectStore('nodes');
  const index = store.index('node_id'); // Use node_id index

  const results = [];

  // Query each UUID using the index - O(1) per lookup
  for (const uuid of nodeUUIDs) {
    const req = index.get(uuid);
    const node = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (node) {
      results.push(node);
    }
  }

  verbose.content(`NEW SYSTEM: Found ${results.length} nodes using indexed lookups (queried ${nodeUUIDs.length} UUIDs)`, 'indexedDB/hydration/rebuild.js');

  return results;
}

/**
 * Extract footnote IDs from HTML content.
 * Looks for footnote reference links and extracts their IDs.
 *
 * @param {string} content - HTML content string
 * @returns {Array<string>} - Array of footnote IDs found in content
 */
function extractFootnoteIdsFromContent(content) {
  if (!content) return [];

  const footnoteIds = [];
  const seen = new Set();

  // Use regex to extract footnote IDs from href attributes
  // Matches: href="#bookId_Fn..." or href="#...Fn..."
  const hrefPattern = /href="#([^"]*(?:_Fn|Fn)[^"]*)"/g;
  let match;

  while ((match = hrefPattern.exec(content)) !== null) {
    const footnoteId = match[1];
    if (footnoteId && !seen.has(footnoteId)) {
      footnoteIds.push(footnoteId);
      seen.add(footnoteId);
    }
  }

  // Also try data-footnote-id attribute
  const dataAttrPattern = /data-footnote-id="([^"]*)"/g;
  while ((match = dataAttrPattern.exec(content)) !== null) {
    const footnoteId = match[1];
    if (footnoteId && !seen.has(footnoteId) && (footnoteId.includes('_Fn') || footnoteId.includes('Fn'))) {
      footnoteIds.push(footnoteId);
      seen.add(footnoteId);
    }
  }

  return footnoteIds;
}
