/**
 * Hypercites Helper Functions
 * Supporting functions for hypercite operations
 */

import { openDatabase } from '../core/connection';
import { getHyperciteFromIndexedDB } from './read';
import { log, verbose } from '../../utilities/logger';
import type { BookId, HyperciteRecord, NodeRecord } from '../types';

const HYPERCITE_ID_RE = /^hypercite_[A-Za-z0-9]+$/;

/** Result of fetchHyperciteRecord — explicit outcomes so callers can react (no silent-stale fallback). */
export type HyperciteFetchResult =
  | { status: 'ok'; record: HyperciteRecord }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'error' };

/**
 * Resolve a hypercite from local IndexedDB or fetch from server
 * Ensures hypercite exists before performing operations.
 * A local hit only counts when the book's nodes are cached too — otherwise
 * the server fetch caches BOTH the hypercite and the whole parent book.
 */
export async function resolveHypercite(bookId: BookId, hyperciteId: string): Promise<HyperciteRecord | null> {
  // Path 1: Check local IndexedDB first
  const localHypercite = await getHyperciteFromIndexedDB(bookId, hyperciteId);

  if (localHypercite) {
    // Also verify nodes are cached for this book
    const { getNodesFromIndexedDB } = await import('../nodes/read');
    const localNodes = await getNodesFromIndexedDB(bookId);
    if (localNodes.length > 0) {
      return localHypercite;
    }
    // Nodes not cached — fall through to server fetch
  }
  try {
    const response = await fetch(
      `/api/db/hypercites/find/${bookId}/${hyperciteId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN":
            document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content || "",
        },
        credentials: "include",
      }
    );

    if (!response.ok) {
      log.error(`Server error: ${response.status} ${response.statusText}`, '/indexedDB/hypercites/helpers.ts');
      return localHypercite || null;
    }

    const data = await response.json();
    const serverHypercite: HyperciteRecord | undefined = data.hypercite;
    const serverNodes: NodeRecord[] | undefined = data.nodes; // Note the plural

    if (!serverHypercite || !serverNodes || serverNodes.length === 0) {
      log.error('Server response was missing hypercite or nodes data from PostgreSQL', '/indexedDB/hypercites/helpers.ts');
      return localHypercite || null;
    }

    // ✅ CACHE BOTH THE HYPERCITE AND ALL THE NODES
    const db = await openDatabase();
    const tx = db.transaction(["hypercites", "nodes"], "readwrite");
    const hypercitesStore = tx.objectStore("hypercites");
    const nodesStore = tx.objectStore("nodes");

    // Put the single hypercite record
    hypercitesStore.put(serverHypercite);

    // Bulk-write all the nodes to nodes object store
    for (const chunk of serverNodes) {
      nodesStore.put(chunk);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Return just the hypercite, as the calling function expects.
    return serverHypercite;

  } catch (error) {
    log.error('Network error while fetching hypercite and book content', '/indexedDB/hypercites/helpers.ts', error);
    return localHypercite || null;
  }
}

/**
 * Fetch a SINGLE hypercite record (scope=record — no nodes payload) and cache it in the
 * `hypercites` store. Used by deep-link fetch-on-demand (a gated/'single' target absent
 * from the bulk sync) and the container's status fallback. Unlike resolveHypercite this
 * returns EXPLICIT outcomes — callers must not treat a failure as "record is fine".
 */
export async function fetchHyperciteRecord(bookId: BookId, hyperciteId: string): Promise<HyperciteFetchResult> {
  if (!HYPERCITE_ID_RE.test(hyperciteId)) {
    log.error(`fetchHyperciteRecord: invalid hypercite id shape: ${hyperciteId}`, '/indexedDB/hypercites/helpers.ts');
    return { status: 'error' };
  }

  try {
    // bookId goes into the path raw — sub-book slashes intact (the route's {book} is greedy).
    const response = await fetch(
      `/api/db/hypercites/find/${bookId}/${hyperciteId}?scope=record`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      }
    );

    if (response.status === 404) return { status: 'not_found' };
    if (response.status === 403) return { status: 'forbidden' };
    if (!response.ok) {
      log.error(`fetchHyperciteRecord: server error ${response.status}`, '/indexedDB/hypercites/helpers.ts');
      return { status: 'error' };
    }

    const data = await response.json();
    const record: HyperciteRecord | undefined = data.hypercite;
    if (!record || !record.hyperciteId) {
      log.error('fetchHyperciteRecord: response missing hypercite', '/indexedDB/hypercites/helpers.ts');
      return { status: 'error' };
    }

    const db = await openDatabase();
    const tx = db.transaction('hypercites', 'readwrite');
    tx.objectStore('hypercites').put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return { status: 'ok', record };
  } catch (error) {
    log.error('fetchHyperciteRecord: network error', '/indexedDB/hypercites/helpers.ts', error);
    return { status: 'error' };
  }
}

/**
 * Deep-link fetch-on-demand: fetch the record, PIN it (survives client gate + later
 * re-syncs), and rebuild the embedded node.hypercites arrays for its containing nodes
 * so the renderer picks it up. Returns the record, or null on any failure.
 */
export async function fetchAndPinHypercite(bookId: BookId, hyperciteId: string): Promise<HyperciteRecord | null> {
  const result = await fetchHyperciteRecord(bookId, hyperciteId);
  if (result.status !== 'ok') {
    verbose.content(`fetchAndPinHypercite: ${hyperciteId} → ${result.status}`, '/indexedDB/hypercites/helpers.ts');
    return null;
  }

  const { pinHypercite } = await import('../../components/utilities/gateFilter');
  pinHypercite(hyperciteId);

  const nodeIds = Array.isArray(result.record.node_id) ? result.record.node_id.filter(Boolean) : [];
  if (nodeIds.length > 0) {
    const { rebuildNodeArrays, getNodesByDataNodeIDs } = await import('../hydration/rebuild');
    const allNodes = await getNodesByDataNodeIDs(nodeIds);
    // Filter to the right book — the same node_id can exist in parent AND sub-book locally.
    const nodes = allNodes.filter((n: NodeRecord) => n.book === bookId);
    if (nodes.length > 0) {
      await rebuildNodeArrays(nodes);
    }
  }

  return result.record;
}
