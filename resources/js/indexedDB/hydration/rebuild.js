/**
 * Hydration Module
 *
 * Rebuilds node.hyperlights and node.hypercites arrays from normalized tables.
 * This is the NEW SYSTEM philosophy: arrays in nodes table are computed views,
 * rebuilt on-demand from the normalized hyperlights and hypercites tables.
 *
 * Philosophy:
 * - Normalized tables (hyperlights, hypercites) are the source of truth
 * - node.hyperlights and node.hypercites arrays are denormalized caches for fast rendering
 * - Arrays are NEVER updated directly - always rebuilt from normalized tables
 * - Enables dynamic filtering, live updates, and clean separation of concerns
 */

import { openDatabase } from '../core/connection.js';

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

  console.log(`🔄 NEW SYSTEM: Rebuilding arrays for ${nodeUUIDs.length} nodes`, nodeUUIDs);

  try {
    // Query normalized tables for all relevant hyperlights/hypercites
    const hyperlights = await queryHyperlightsByNodes(db, nodeUUIDs);
    const hypercites = await queryHypercitesByNodes(db, nodeUUIDs);

    console.log(`📊 NEW SYSTEM: Found ${hyperlights.length} hyperlights, ${hypercites.length} hypercites for these nodes`);

    // Build arrays for each node from normalized data
    nodes.forEach(node => {
      node.hyperlights = buildHyperlightsForNode(node, hyperlights);
      node.hypercites = buildHypercitesForNode(node, hypercites);

      console.log(`📝 NEW SYSTEM: Node ${node.node_id} rebuilt with ${node.hyperlights.length} hyperlights, ${node.hypercites.length} hypercites`);
    });

    // Update nodes in IndexedDB with new arrays
    await updateNodesInDB(db, nodes);

    console.log(`✅ NEW SYSTEM: Successfully rebuilt arrays for ${nodes.length} nodes`);
  } catch (error) {
    console.error('❌ NEW SYSTEM: Error rebuilding node arrays:', error);
    throw error;
  }
}

/**
 * Query hyperlights that affect specific nodes
 * Uses node_id array to find hyperlights spanning these nodes
 *
 * @param {IDBDatabase} db - IndexedDB database
 * @param {Array<string>} nodeUUIDs - Node UUIDs to query
 * @returns {Promise<Array>} - Hyperlights affecting these nodes
 */
async function queryHyperlightsByNodes(db, nodeUUIDs) {
  const tx = db.transaction('hyperlights', 'readonly');
  const store = tx.objectStore('hyperlights');

  const allHyperlights = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  // Filter to hyperlights that affect at least one of these nodes
  const filtered = allHyperlights.filter(hl =>
    hl.node_id &&
    Array.isArray(hl.node_id) &&
    hl.node_id.some(uuid => nodeUUIDs.includes(uuid))
  );

  console.log(`🔍 NEW SYSTEM: Queried hyperlights table, found ${filtered.length}/${allHyperlights.length} affecting target nodes`);

  return filtered;
}

/**
 * Query hypercites that affect specific nodes
 * Uses node_id array to find hypercites spanning these nodes
 *
 * @param {IDBDatabase} db - IndexedDB database
 * @param {Array<string>} nodeUUIDs - Node UUIDs to query
 * @returns {Promise<Array>} - Hypercites affecting these nodes
 */
async function queryHypercitesByNodes(db, nodeUUIDs) {
  const tx = db.transaction('hypercites', 'readonly');
  const store = tx.objectStore('hypercites');

  const allHypercites = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  // Filter to hypercites that affect at least one of these nodes
  const filtered = allHypercites.filter(hc =>
    hc.node_id &&
    Array.isArray(hc.node_id) &&
    hc.node_id.some(uuid => nodeUUIDs.includes(uuid))
  );

  console.log(`🔍 NEW SYSTEM: Queried hypercites table, found ${filtered.length}/${allHypercites.length} affecting target nodes`);

  return filtered;
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

  return allHyperlights
    .filter(hl => hl.node_id.includes(node.node_id))
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
        console.log(`💾 NEW SYSTEM: Updated node ${node.node_id} in IndexedDB`);
        resolve();
      };
      req.onerror = () => {
        console.error(`❌ NEW SYSTEM: Failed to update node ${node.node_id}:`, req.error);
        reject(req.error);
      };
    });
  }

  console.log(`✅ NEW SYSTEM: Updated ${nodes.length} nodes in IndexedDB`);
}

/**
 * Get nodes from IndexedDB by their UUIDs
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

  const allNodes = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  const filtered = allNodes.filter(node => nodeUUIDs.includes(node.node_id));

  console.log(`🔍 NEW SYSTEM: Found ${filtered.length}/${allNodes.length} nodes matching UUIDs`, nodeUUIDs);

  return filtered;
}
