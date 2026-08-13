/**
 * Hyperlights helper functions — deep-link fetch-on-demand.
 * Mirror of hypercites/helpers.ts fetchHyperciteRecord/fetchAndPinHypercite: a followed
 * #HL_ link whose record was gate-filtered out of the bulk sync pulls just that record,
 * pins it (survives the client gate + later re-syncs), and rebuilds the embedded
 * node.hyperlights arrays so the renderer picks the mark up.
 */

import { openDatabase } from '../core/connection';
import { log, verbose } from '../../utilities/logger';
import type { BookId, HyperlightRecord, NodeRecord } from '../types';

const HYPERLIGHT_ID_RE = /^HL_[A-Za-z0-9]+$/;

/** Result of fetchHyperlightRecord — explicit outcomes so callers can react (no silent-stale fallback). */
export type HyperlightFetchResult =
  | { status: 'ok'; record: HyperlightRecord }
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'error' };

/**
 * Fetch a SINGLE hyperlight record from the server and cache it in the `hyperlights`
 * store. Returns EXPLICIT outcomes — callers must not treat a failure as "record is fine".
 */
export async function fetchHyperlightRecord(bookId: BookId, hyperlightId: string): Promise<HyperlightFetchResult> {
  if (!HYPERLIGHT_ID_RE.test(hyperlightId)) {
    log.error(`fetchHyperlightRecord: invalid hyperlight id shape: ${hyperlightId}`, '/indexedDB/highlights/helpers.ts');
    return { status: 'error' };
  }

  try {
    // bookId goes into the path raw — sub-book slashes intact (the route's {book} is greedy).
    const response = await fetch(
      `/api/db/hyperlights/find/${bookId}/${hyperlightId}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      }
    );

    if (response.status === 404) return { status: 'not_found' };
    if (response.status === 403) return { status: 'forbidden' };
    if (!response.ok) {
      log.error(`fetchHyperlightRecord: server error ${response.status}`, '/indexedDB/highlights/helpers.ts');
      return { status: 'error' };
    }

    const data = await response.json();
    const wire = data.hyperlight;
    if (!wire || !wire.hyperlight_id) {
      log.error('fetchHyperlightRecord: response missing hyperlight', '/indexedDB/highlights/helpers.ts');
      return { status: 'error' };
    }

    // Normalize the wire row (mirror of serverSync/loaders processHyperlight).
    const record: HyperlightRecord = {
      ...wire,
      book: wire.book,
      node_id: Array.isArray(wire.node_id) ? wire.node_id : JSON.parse((wire.node_id as string) || '[]'),
      charData: wire.charData ?? {},
      highlightedText: wire.highlightedText ?? '',
      highlightedHTML: wire.highlightedHTML ?? '',
      annotation: wire.annotation ?? '',
      raw_json: typeof wire.raw_json === 'string' ? JSON.parse(wire.raw_json) : wire.raw_json,
    };

    const db = await openDatabase();
    const tx = db.transaction('hyperlights', 'readwrite');
    tx.objectStore('hyperlights').put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return { status: 'ok', record };
  } catch (error) {
    log.error('fetchHyperlightRecord: network error', '/indexedDB/highlights/helpers.ts', error);
    return { status: 'error' };
  }
}

/**
 * Deep-link fetch-on-demand: fetch the record, PIN it (survives client gate + later
 * re-syncs), and rebuild the embedded node.hyperlights arrays for its containing nodes
 * so the renderer picks it up. Returns the record, or null on any failure.
 */
export async function fetchAndPinHyperlight(bookId: BookId, hyperlightId: string): Promise<HyperlightRecord | null> {
  const result = await fetchHyperlightRecord(bookId, hyperlightId);
  if (result.status !== 'ok') {
    verbose.content(`fetchAndPinHyperlight: ${hyperlightId} → ${result.status}`, '/indexedDB/highlights/helpers.ts');
    return null;
  }

  const { pinHyperlight } = await import('../../components/utilities/gateFilter');
  pinHyperlight(hyperlightId);

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
