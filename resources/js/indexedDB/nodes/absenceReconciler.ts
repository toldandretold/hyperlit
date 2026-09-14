/**
 * Save-time hypercite ABSENCE reconciliation — the structural self-heal for
 * lost deletions.
 *
 * The MutationObserver path that delinks/ghosts hypercites is lossy by design:
 * mutationProcessor DROPS a queued batch when a paste / programmatic op /
 * chunk load is in flight (never replayed), and the paste handlers delete the
 * selection with the observer muted. When that happens, a record whose
 * <u>/<a> vanished from a surviving node stays live forever — the "two
 * citations, one red" bug class, and phantom <u>s re-rendered from stale
 * charData.
 *
 * This module closes the hole at the SAVE seam: whenever a node is saved from
 * the live DOM (batchUpdateIndexedDBRecords), the hypercite ids present in the
 * node's PREVIOUS content are diffed against the live element; ids gone from
 * the node AND from the whole document are reconciled shortly after the save —
 * missing citing anchors are delinked, missing cited sources are tombstoned +
 * ghosted (mirroring the whole-node-deletion shape in batch.ts), uncited
 * sources get their node bookkeeping pruned / `_orphaned_at` stamped.
 *
 * Deliberate boundaries:
 * - Only nodes saved FROM LIVE DOM are examined — an unrendered lazy chunk can
 *   never lose its hypercites here.
 * - Everything is idempotent with the observer path and the cut handler
 *   (delink no-ops when the entry is gone; tombstone insert reuses an
 *   existing element; ghost re-write converges).
 * - Records are NEVER deleted client-side — always synced as updates.
 */

import { log, verbose } from '../../utilities/logger';
import {
  isPasteInProgress,
  isProgrammaticUpdateInProgress,
  getHandleHypercitePaste,
} from '../../utilities/operationState';
import type { BookId } from '../types';
import type { LineId } from '../../utilities/idHelpers';

const HYPERCITE_ID_RE = /^hypercite_[A-Za-z0-9]+$/;
/** Delay after the save completes — past the observer's RAF batch + the 50ms move window. */
const RECONCILE_DELAY_MS = 120;
/** One re-try when a paste/programmatic op is mid-flight at reconcile time. */
const RETRY_DELAY_MS = 150;

export interface AbsenceCandidate {
  bookId: BookId;
  /** The saved node's positional id — tombstone host + re-save target. */
  lineId: LineId;
  /** The saved node's data-node-id (null for legacy nodes). */
  dataNodeID: string | null;
  /** Source <u id="hypercite_…"> ids present in the old content, gone from the live node + document. */
  missingSourceUs: string[];
  /** Citing anchors present in the old content, gone from the live node + document. */
  missingAnchors: { elementId: string; href: string }[];
}

function collectIdsFrom(root: ParentNode): { sourceUs: Map<string, HTMLElement>; anchors: Map<string, string> } {
  const sourceUs = new Map<string, HTMLElement>();
  for (const u of root.querySelectorAll<HTMLElement>('u[id^="hypercite_"]')) {
    if (HYPERCITE_ID_RE.test(u.id)) sourceUs.set(u.id, u);
  }
  const anchors = new Map<string, string>();
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href*="#hypercite_"]')) {
    const href = a.getAttribute('href') || '';
    const elementId = a.id || (href.match(/#(hypercite_[A-Za-z0-9]+)/)?.[1] ?? '');
    if (elementId) anchors.set(elementId, href);
  }
  return { sourceUs, anchors };
}

/**
 * Diff a node's previous content against its live DOM element. Returns null
 * when nothing hypercite-shaped went missing. Ids still present ANYWHERE in
 * the document are excluded — moved (e.g. chunk overflow), not deleted.
 */
export function collectAbsenceCandidates(
  oldContent: string | null | undefined,
  liveNode: HTMLElement,
  bookId: BookId,
  lineId: LineId,
): AbsenceCandidate | null {
  if (!oldContent || !oldContent.includes('hypercite_')) return null;

  const template = document.createElement('template');
  template.innerHTML = oldContent;
  const old = collectIdsFrom(template.content);
  if (old.sourceUs.size === 0 && old.anchors.size === 0) return null;

  const live = collectIdsFrom(liveNode);

  const missingSourceUs: string[] = [];
  for (const id of old.sourceUs.keys()) {
    if (live.sourceUs.has(id)) continue;
    if (document.getElementById(id)) continue; // moved, not deleted
    missingSourceUs.push(id);
  }

  const missingAnchors: { elementId: string; href: string }[] = [];
  for (const [elementId, href] of old.anchors) {
    if (live.anchors.has(elementId)) continue;
    if (document.getElementById(elementId)) continue;
    missingAnchors.push({ elementId, href });
  }

  if (missingSourceUs.length === 0 && missingAnchors.length === 0) return null;

  return {
    bookId,
    lineId,
    dataNodeID: liveNode.getAttribute('data-node-id'),
    missingSourceUs,
    missingAnchors,
  };
}

function operationInFlight(): boolean {
  return isPasteInProgress() || isProgrammaticUpdateInProgress() || Boolean(getHandleHypercitePaste());
}

async function reconcileMissingSourceU(candidate: AbsenceCandidate, hyperciteId: string): Promise<void> {
  const { getHyperciteFromIndexedDB } = await import('../hypercites/read');
  const record = await getHyperciteFromIndexedDB(candidate.bookId, hyperciteId);
  if (!record) return;

  // Multi-node / lazy-chunk guard: does any OTHER node still host this id?
  const nodeIds: string[] = Array.isArray(record.node_id) ? record.node_id : [];
  const otherNodeIds = nodeIds.filter((id) => id && id !== candidate.dataNodeID);
  let hostedElsewhere = false;
  if (otherNodeIds.length > 0) {
    const { getNodesByDataNodeIDs } = await import('../hydration/rebuild');
    const otherNodes = (await getNodesByDataNodeIDs(otherNodeIds)).filter((n) => n.book === candidate.bookId);
    hostedElsewhere = otherNodes.some(
      (n) => typeof n.content === 'string' && n.content.includes(`id="${hyperciteId}"`),
    );
  }

  const { updateHyperciteInIndexedDB } = await import('../hypercites/index');

  if (hostedElsewhere) {
    // Partial prune: this node no longer hosts the hypercite; the others do.
    if (!candidate.dataNodeID) return;
    const newNodeIds = nodeIds.filter((id) => id !== candidate.dataNodeID);
    const newCharData = { ...(record.charData || {}) };
    delete newCharData[candidate.dataNodeID];
    await updateHyperciteInIndexedDB(candidate.bookId, hyperciteId, {
      node_id: newNodeIds,
      charData: newCharData,
    });
    verbose.content(`Absence reconcile: pruned ${candidate.dataNodeID} from multi-node ${hyperciteId}`, '/indexedDB/nodes/absenceReconciler.ts');
    return;
  }

  const cited = Array.isArray(record.citedIN) && record.citedIN.length > 0;

  if (cited) {
    // Sole host, still cited → ghost + DOM tombstone (mirrors the whole-node-
    // deletion shape so the server's CharDataRecalculator and the paste
    // restoration path both understand it).
    const newCharData = { ...(record.charData || {}) };
    if (candidate.dataNodeID) {
      newCharData[candidate.dataNodeID] = { charStart: -1, charEnd: -1 };
    }
    await updateHyperciteInIndexedDB(candidate.bookId, hyperciteId, {
      relationshipStatus: 'ghost',
      charData: newCharData,
      ...(candidate.dataNodeID ? { _ghost_anchor_node: candidate.dataNodeID } : {}),
    });

    const hostBlock = document.getElementById(String(candidate.lineId));
    const { insertTombstone } = await import('../../hypercites/tombstone');
    const tombstone = insertTombstone(hyperciteId, hostBlock);
    if (tombstone) {
      const { queueNodeForSave } = await import('../../divEditor/editorState');
      queueNodeForSave(String(candidate.lineId), 'update');
    }
    log.content(`Absence reconcile: ghosted cited hypercite ${hyperciteId} (source <u> lost without a delete event)`, '/indexedDB/nodes/absenceReconciler.ts');
    return;
  }

  // Sole host, uncited → prune the bookkeeping; orphan the record (recoverable:
  // updateHyperciteRecords auto-clears _orphaned_at if the <u> ever reappears).
  const newNodeIds = candidate.dataNodeID ? nodeIds.filter((id) => id !== candidate.dataNodeID) : nodeIds;
  const newCharData = { ...(record.charData || {}) };
  if (candidate.dataNodeID) delete newCharData[candidate.dataNodeID];
  await updateHyperciteInIndexedDB(candidate.bookId, hyperciteId, {
    node_id: newNodeIds,
    charData: newCharData,
    ...(newNodeIds.length === 0 ? { _orphaned_at: Date.now() } : {}),
  });
  verbose.content(`Absence reconcile: orphaned uncited hypercite ${hyperciteId}`, '/indexedDB/nodes/absenceReconciler.ts');
}

/**
 * Apply the collected candidates. Re-verifies absence at execution time, and
 * defers ONCE if a paste/programmatic operation is mid-flight (the next save
 * re-collects, so giving up is safe).
 */
export async function reconcileAbsences(candidates: AbsenceCandidate[], isRetry = false): Promise<void> {
  if (candidates.length === 0) return;

  if (operationInFlight()) {
    if (!isRetry) {
      setTimeout(() => {
        reconcileAbsences(candidates, true).catch((error) =>
          log.error('Absence reconcile retry failed', '/indexedDB/nodes/absenceReconciler.ts', error));
      }, RETRY_DELAY_MS);
    }
    return;
  }

  for (const candidate of candidates) {
    for (const anchor of candidate.missingAnchors) {
      if (document.getElementById(anchor.elementId)) continue; // reappeared
      try {
        const { delinkHypercite } = await import('../../hypercites/deletion');
        await delinkHypercite(anchor.elementId, anchor.href);
        verbose.content(`Absence reconcile: delinked lost anchor ${anchor.elementId}`, '/indexedDB/nodes/absenceReconciler.ts');
      } catch (error) {
        log.error('Absence reconcile: delink failed', '/indexedDB/nodes/absenceReconciler.ts', error);
      }
    }

    for (const hyperciteId of candidate.missingSourceUs) {
      if (document.getElementById(hyperciteId)) continue; // tombstoned/restored meanwhile
      try {
        await reconcileMissingSourceU(candidate, hyperciteId);
      } catch (error) {
        log.error('Absence reconcile: source-u reconcile failed', '/indexedDB/nodes/absenceReconciler.ts', error);
      }
    }
  }
}

/** Fire-and-forget scheduling used by the batch writer after tx.oncomplete. */
export function scheduleAbsenceReconciliation(candidates: AbsenceCandidate[]): void {
  if (candidates.length === 0) return;
  setTimeout(() => {
    reconcileAbsences(candidates).catch((error) =>
      log.error('Absence reconcile failed', '/indexedDB/nodes/absenceReconciler.ts', error));
  }, RECONCILE_DELAY_MS);
}
