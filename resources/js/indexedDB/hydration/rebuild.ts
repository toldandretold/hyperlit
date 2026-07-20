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

import { openDatabase } from '../core/connection';
import { log, verbose } from '../../utilities/logger';
import type {
  HyperciteRecord,
  HyperlightRecord,
  NodeHyperciteView,
  NodeHyperlightView,
  NodeRecord,
} from '../types';

/**
 * Rebuild hyperlights and hypercites arrays for specific nodes
 * Queries normalized tables and populates node arrays based on node_id and charData
 */
export async function rebuildNodeArrays(
  nodes: NodeRecord[],
  { skipWrite = false }: { skipWrite?: boolean } = {},
): Promise<void> {
  if (!nodes || nodes.length === 0) {
    // Benign no-op: several callers compute an "affected nodes" set that the
    // book-filter (parent/sub-book node_id collision) or a first-chunk-miss race
    // can legitimately empty. "Nothing to rebuild" is a normal outcome, not an
    // error — keep it out of console.error so it doesn't trip the e2e gate.
    verbose.content('rebuildNodeArrays: no nodes to rebuild', 'indexedDB/hydration/rebuild');
    return;
  }

  const db = await openDatabase();
  const dataNodeIDs = nodes.map(n => n.node_id).filter((id): id is string => Boolean(id));

  if (dataNodeIDs.length === 0) {
    log.error('rebuildNodeArrays: No valid data-node-ids found', '/indexedDB/hydration/rebuild.ts', nodes);
    return;
  }

  verbose.content(`NEW SYSTEM: Rebuilding arrays for ${dataNodeIDs.length} nodes`, 'indexedDB/hydration/rebuild');

  try {
    // Query normalized tables for all relevant hyperlights/hypercites (parallel)
    const [hyperlights, hypercites] = await Promise.all([
      queryHyperlightsByNodes(db, dataNodeIDs),
      queryHypercitesByNodes(db, dataNodeIDs),
    ]);

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
      // (no per-node logging here — this loop runs for every node on hydration)
    });

    // Update nodes in IndexedDB with new arrays (fire-and-forget cache update)
    if (!skipWrite) {
      updateNodesInDB(db, nodes).catch(err => log.error('Failed to update nodes cache in IndexedDB', '/indexedDB/hydration/rebuild.ts', err));
    }

    verbose.content(`NEW SYSTEM: Successfully rebuilt arrays for ${nodes.length} nodes`, 'indexedDB/hydration/rebuild');
  } catch (error) {
    log.error('Error rebuilding node arrays', '/indexedDB/hydration/rebuild.ts', error);
    throw error;
  }
}

/**
 * Query hyperlights that affect specific nodes
 * Uses node_id multi-entry index for fast O(k) lookups instead of O(N) full scan
 */
async function queryHyperlightsByNodes(db: IDBDatabase, dataNodeIDs: string[]): Promise<HyperlightRecord[]> {
  const tx = db.transaction('hyperlights', 'readonly');
  const store = tx.objectStore('hyperlights');

  if (!store.indexNames.contains('node_id')) {
    log.error('CRITICAL: node_id index does not exist on hyperlights store! Database needs to be upgraded to version 24', '/indexedDB/hydration/rebuild.ts');
    return [];
  }

  const index = store.index('node_id'); // Multi-entry index on node_id array

  // Use a Map to deduplicate (a hyperlight spanning multiple nodes will be found multiple times)
  const resultsMap = new Map<string, HyperlightRecord>();

  // Fire all index queries at once within the same transaction, collect with Promise.all
  const hlPromises = dataNodeIDs.map(dataNodeID => {
    const req = index.getAll(dataNodeID);
    return new Promise<HyperlightRecord[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  });
  const allHlResults = await Promise.all(hlPromises);
  allHlResults.forEach(matches => {
    matches.forEach(hl => {
      if (hl && hl.hyperlight_id) {
        resultsMap.set(hl.hyperlight_id, hl);
      }
    });
  });

  const results = Array.from(resultsMap.values());
  verbose.content(`NEW SYSTEM: Queried hyperlights index for ${dataNodeIDs.length} nodes, found ${results.length} hyperlights`, 'indexedDB/hydration/rebuild');

  return results;
}

/**
 * Query hypercites that affect specific nodes
 * Uses node_id multi-entry index for fast O(k) lookups instead of O(N) full scan
 */
async function queryHypercitesByNodes(db: IDBDatabase, dataNodeIDs: string[]): Promise<HyperciteRecord[]> {
  const tx = db.transaction('hypercites', 'readonly');
  const store = tx.objectStore('hypercites');
  const index = store.index('node_id'); // Multi-entry index on node_id array

  // Use a Map to deduplicate (a hypercite spanning multiple nodes will be found multiple times)
  const resultsMap = new Map<string, HyperciteRecord>();

  // Fire all index queries at once within the same transaction, collect with Promise.all
  const hcPromises = dataNodeIDs.map(dataNodeID => {
    const req = index.getAll(dataNodeID);
    return new Promise<HyperciteRecord[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  });
  const allHcResults = await Promise.all(hcPromises);
  allHcResults.forEach(matches => {
    matches.forEach(hc => {
      if (hc && hc.hyperciteId) {
        resultsMap.set(hc.hyperciteId, hc);
      }
    });
  });

  const results = Array.from(resultsMap.values());
  verbose.content(`NEW SYSTEM: Queried hypercites index for ${dataNodeIDs.length} nodes, found ${results.length} hypercites`, 'indexedDB/hydration/rebuild');

  return results;
}

/**
 * Build hyperlights array for a specific node
 * Extracts per-node position data from charData object
 */
function buildHyperlightsForNode(node: NodeRecord, allHyperlights: HyperlightRecord[]): NodeHyperlightView[] {
  const nodeId = node.node_id;
  if (!nodeId) {
    log.error('Node missing node_id, cannot build hyperlights', '/indexedDB/hydration/rebuild.ts', node);
    return [];
  }

  const results = allHyperlights
    .filter(hl => hl.node_id.includes(nodeId) && hl.book === node.book)
    .map((hl): NodeHyperlightView | null => {
      // Extract per-node position from charData
      const charData = hl.charData?.[nodeId];

      if (!charData) {
        verbose.content(`No charData for highlight ${hl.hyperlight_id} on node ${nodeId}`, '/indexedDB/hydration/rebuild.ts', hl);
        return null;
      }

      // Build hyperlight object in the format expected by renderer
      return {
        highlightID: hl.hyperlight_id,
        charStart: charData.charStart,
        charEnd: charData.charEnd,
        annotation: hl.annotation,
        creator: hl.creator,
        preview_nodes: hl.preview_nodes,
        is_user_highlight: hl.is_user_highlight,
        hidden: hl.hidden || false,
        time_since: hl.time_since,
      };
    })
    .filter((hl): hl is NodeHyperlightView => hl !== null); // Remove nulls from missing charData

  return results;
}

/**
 * Build hypercites array for a specific node
 * Extracts per-node position data from charData object
 */
function buildHypercitesForNode(node: NodeRecord, allHypercites: HyperciteRecord[]): NodeHyperciteView[] {
  const nodeId = node.node_id;
  if (!nodeId) {
    log.error('Node missing node_id, cannot build hypercites', '/indexedDB/hydration/rebuild.ts', node);
    return [];
  }

  return allHypercites
    .filter(hc => hc.node_id.includes(nodeId))
    .map((hc): NodeHyperciteView | null => {
      // Extract per-node position from charData
      const charData = hc.charData?.[nodeId];

      if (!charData) {
        verbose.content(`No charData for hypercite ${hc.hyperciteId} on node ${nodeId}`, '/indexedDB/hydration/rebuild.ts', hc);
        return null;
      }

      // Build hypercite object in the format expected by renderer.
      // creator/is_user_hypercite ride along — the client gate's ownership bypass
      // + singles mirror read them off the embedded view at render.
      return {
        hyperciteId: hc.hyperciteId,
        charStart: charData.charStart,
        charEnd: charData.charEnd,
        relationshipStatus: hc.relationshipStatus,
        citedIN: hc.citedIN || [],
        time_since: hc.time_since,
        creator: hc.creator ?? null,
        is_user_hypercite: hc.is_user_hypercite,
      };
    })
    .filter((hc): hc is NodeHyperciteView => hc !== null); // Remove nulls from missing charData
}

/**
 * Update nodes in IndexedDB with rebuilt arrays
 */
async function updateNodesInDB(db: IDBDatabase, nodes: NodeRecord[]): Promise<void> {
  const tx = db.transaction('nodes', 'readwrite');
  const store = tx.objectStore('nodes');

  // Fire all put() calls without individual awaits, wait for tx.oncomplete
  for (const node of nodes) {
    store.put(node);
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      verbose.content(`NEW SYSTEM: Updated ${nodes.length} nodes in IndexedDB`, 'indexedDB/hydration/rebuild');
      resolve();
    };
    tx.onerror = () => {
      log.error('Failed to update nodes in IndexedDB', '/indexedDB/hydration/rebuild.ts', tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Get nodes from IndexedDB by their data-node-ids
 * Uses node_id index for fast O(k) lookups instead of O(N) full scan
 *
 * ⚠️ Returns at most ONE record per node_id — when the same node_id exists in
 * several books, the alphabetically-first book's record wins (pinned in
 * rebuild.characterization.test.js). Callers must filter by book.
 */
export async function getNodesByDataNodeIDs(dataNodeIDs: string[]): Promise<NodeRecord[]> {
  if (!dataNodeIDs || dataNodeIDs.length === 0) {
    log.error('No data-node-ids provided to getNodesByDataNodeIDs', '/indexedDB/hydration/rebuild.ts');
    return [];
  }

  const db = await openDatabase();
  const tx = db.transaction('nodes', 'readonly');
  const store = tx.objectStore('nodes');
  const index = store.index('node_id'); // Use node_id index

  // Fire all index queries at once within the same transaction, collect with Promise.all
  const nodePromises = dataNodeIDs.map(dataNodeID => {
    const req = index.get(dataNodeID);
    return new Promise<NodeRecord | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
  const results = (await Promise.all(nodePromises)).filter((n): n is NodeRecord => Boolean(n));

  verbose.content(`NEW SYSTEM: Found ${results.length} nodes using indexed lookups (queried ${dataNodeIDs.length} data-node-ids)`, 'indexedDB/hydration/rebuild');

  return results;
}

/**
 * Extract footnote IDs from HTML content.
 * Looks for footnote reference links and extracts their IDs.
 */
function extractFootnoteIdsFromContent(content: string): string[] {
  if (!content) return [];

  const footnoteIds: string[] = [];
  const seen = new Set<string>();

  // Use regex to extract footnote IDs from href attributes
  // Matches: href="#bookId_Fn..." or href="#...Fn..."
  const hrefPattern = /href="#([^"]*(?:_Fn|Fn)[^"]*)"/g;
  let match: RegExpExecArray | null;

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
