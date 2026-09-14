/**
 * citedIN reconciliation — removes DEAD citations (entries whose citing anchor
 * no longer exists anywhere in the citing book) from a source hypercite.
 *
 * Why this exists: a cut/paste of a citation anchor mints a NEW id and APPENDS
 * to the source's citedIN. If the cut's delink was lost (dropped mutation
 * batch, observer muted during paste), the source ends up with two entries —
 * one live, one dead-but-red-in-the-health-check. The paste handler calls
 * reconcileCitedINForCitingBook before appending, so the dead entry is pruned
 * at the exact moment the duplicate would otherwise be created.
 *
 * Deliberately CONSERVATIVE: an entry is only removed when the anchor is
 * missing from the citing book's rendered DOM *and* from every un-rendered
 * IDB copy (nodes + footnotes). When in doubt, keep — the manual health check
 * can always clean up later; a wrong delink silently loses a real citation.
 */

import {
  getHyperciteFromIndexedDB,
  getNodesFromIndexedDB,
  updateHyperciteInIndexedDB,
  getNodesByDataNodeIDs,
  rebuildNodeArrays,
} from '../indexedDB/index';
import { getAllFootnotesForBook } from '../indexedDB/footnotes/index';
import { parseHyperciteHref, determineRelationshipStatus } from './utils';
import { log, verbose } from '../utilities/logger';
import type { BookId } from '../indexedDB/types';

/**
 * Is the citing anchor `anchorId` still alive in `citingBook`?
 *
 * - In the live DOM → alive (no book-ownership check: a same-id element in
 *   another rendered book is near-impossible for minted anchor ids, and
 *   treating it as alive only errs toward keeping the entry).
 * - In an IDB node whose DOM copy is NOT rendered (lazy chunk) → alive.
 * - In an IDB node that IS rendered but no longer contains it → stale IDB in
 *   the unflushed-save window; the DOM wins → dead (unless found elsewhere).
 * - In a footnote's content → alive.
 * - Nowhere → dead.
 */
export async function isCitingAnchorAlive(citingBook: BookId, anchorId: string): Promise<boolean> {
  if (document.getElementById(anchorId)) return true;

  const needle = `id="${anchorId}"`;

  try {
    const nodes = await getNodesFromIndexedDB(citingBook);
    for (const node of nodes) {
      if (typeof node.content !== 'string' || !node.content.includes(needle)) continue;
      const rendered =
        (node.node_id && document.querySelector(`[data-node-id="${node.node_id}"]`)) ||
        (node.startLine != null && document.getElementById(String(node.startLine)));
      if (!rendered) return true; // un-rendered IDB copy — trust it
      // Rendered without the anchor → stale IDB copy; keep scanning other nodes.
    }
  } catch (error) {
    log.error('isCitingAnchorAlive: node scan failed — treating as alive', '/hypercites/reconciliation.ts', error);
    return true;
  }

  try {
    const footnotes = await getAllFootnotesForBook(citingBook);
    if (footnotes.some((fn) => typeof fn.content === 'string' && fn.content.includes(needle))) {
      return true;
    }
  } catch (error) {
    log.error('isCitingAnchorAlive: footnote scan failed — treating as alive', '/hypercites/reconciliation.ts', error);
    return true;
  }

  return false;
}

/**
 * Remove dead citedIN entries pointing into `citingBook` from the source
 * hypercite (sourceBook, sourceHyperciteId). Entries for OTHER books are never
 * touched. Returns the removed citation URLs (empty when nothing changed).
 *
 * Persists via updateHyperciteInIndexedDB (which queues the sync — records are
 * never deleted client-side) and rebuilds the source's embedded node arrays.
 */
export async function reconcileCitedINForCitingBook(
  sourceBook: BookId,
  sourceHyperciteId: string,
  citingBook: BookId,
): Promise<string[]> {
  try {
    const record = await getHyperciteFromIndexedDB(sourceBook, sourceHyperciteId);
    if (!record || !Array.isArray(record.citedIN) || record.citedIN.length === 0) return [];

    const removed: string[] = [];
    const kept: string[] = [];

    for (const citationUrl of record.citedIN) {
      const parsed = parseHyperciteHref(citationUrl);
      if (!parsed || parsed.booka !== String(citingBook) || !parsed.hyperciteIDa) {
        kept.push(citationUrl);
        continue;
      }
      if (await isCitingAnchorAlive(citingBook, parsed.hyperciteIDa)) {
        kept.push(citationUrl);
      } else {
        removed.push(citationUrl);
      }
    }

    if (removed.length === 0) return [];

    const newStatus = determineRelationshipStatus(kept.length);
    const updated = await updateHyperciteInIndexedDB(sourceBook, sourceHyperciteId, {
      citedIN: kept,
      relationshipStatus: newStatus,
    });
    if (!updated) return [];

    verbose.content(
      `Reconciled ${sourceHyperciteId}: removed ${removed.length} dead citation(s) from ${citingBook}, status → ${newStatus}`,
      '/hypercites/reconciliation.ts',
    );

    const affectedDataNodeIDs = record.node_id || [];
    if (affectedDataNodeIDs.length > 0) {
      const allNodes = await getNodesByDataNodeIDs(affectedDataNodeIDs);
      const affectedNodes = allNodes.filter((n) => n.book === sourceBook);
      if (affectedNodes.length > 0) await rebuildNodeArrays(affectedNodes);
    }

    return removed;
  } catch (error) {
    log.error('reconcileCitedINForCitingBook failed', '/hypercites/reconciliation.ts', error);
    return [];
  }
}
