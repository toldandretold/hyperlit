/**
 * Cut-gesture hypercite protection.
 *
 * Cmd/Ctrl+X and context-menu Cut fire no Delete/Backspace keydown (so
 * SelectionDeletionHandler's guard never sees them) and the MutationObserver
 * batch the removal lands in can be silently discarded by a concurrent paste /
 * programmatic operation (mutationProcessor drops, never replays). This module
 * makes cut deterministic: it snapshots the hypercite elements inside the
 * selection SYNCHRONOUSLY in the `cut` event — before the browser mutates the
 * DOM — then finalizes shortly after the 50ms move-vs-delete window:
 *
 * - a citing anchor that is gone → delinkHypercite (safe even if the user
 *   pastes it back: citation paste always mints a NEW id, so the old citedIN
 *   entry can never be revived);
 * - a cited source <u> that is gone → tombstone + ghost, which is exactly the
 *   contract the paste restoration path needs to resurrect it;
 * - anything still (or again) in the DOM → untouched.
 *
 * Every action is idempotent with the MutationObserver path, so double
 * handling is harmless. No confirm dialog: a sync dialog inside `cut` would
 * have to preventDefault and lose the clipboard, and cut is non-destructive
 * under this design.
 */

import { findSpecialElementsInRange } from './selectionSpecialElements';
import { findParentWithNumericalId } from '../hypercites/utils';
import { queueNodeForSave } from './editorState';
import { log, verbose } from '../utilities/logger';
import type { LineId } from '../utilities/idHelpers';
import { asLineId, isNumericalId } from '../utilities/idHelpers';

/** Just past handleHyperciteRemoval's 50ms delayed verify window. */
const CUT_FINALIZE_DELAY_MS = 60;

export interface CutHyperciteSnapshot {
  /** Source <u id="hypercite_…"> ids in the cut selection (tombstones excluded). */
  sourceUIds: string[];
  /** Citation anchors in the cut selection: element id + href to the source. */
  anchors: { elementId: string; href: string }[];
  /** Numeric-id block owning the selection start — preferred tombstone host. */
  hostBlockId: LineId | null;
  takenAt: number;
}

/**
 * Capture the hypercite elements inside the current selection. Synchronous —
 * must run inside the `cut` event, before the browser removes the selection.
 * Returns null when there is nothing hypercite-shaped to protect.
 */
export function snapshotCutSelection(): CutHyperciteSnapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const found = findSpecialElementsInRange(range);
  if (!found) return null;
  if (found.sourceHypercites.length === 0 && found.hyperciteAnchors.length === 0) return null;

  const startElement = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : (range.startContainer as Element | null);
  const hostBlock = findParentWithNumericalId(startElement as HTMLElement | null);
  const hostBlockId = hostBlock && isNumericalId(hostBlock.id) ? asLineId(hostBlock.id) : null;

  return {
    sourceUIds: found.sourceHypercites.map((el) => el.id),
    anchors: found.hyperciteAnchors
      .map((a) => ({ elementId: a.id || '', href: a.getAttribute('href') || '' }))
      .filter((entry) => entry.href.includes('#hypercite_'))
      .map((entry) => ({
        elementId: entry.elementId || (entry.href.match(/#(hypercite_[A-Za-z0-9]+)/)?.[1] ?? ''),
        href: entry.href,
      }))
      .filter((entry) => entry.elementId !== ''),
    hostBlockId,
    takenAt: Date.now(),
  };
}

/**
 * Apply the snapshot after the move-vs-delete window: delink anchors and
 * tombstone+ghost cited sources whose elements are genuinely gone from the DOM.
 */
export async function finalizeCut(snapshot: CutHyperciteSnapshot): Promise<void> {
  // Citing anchors: absent ⇒ the citedIN entry is dead no matter what happens
  // next (a re-paste mints a fresh id), so delink immediately.
  for (const anchor of snapshot.anchors) {
    if (document.getElementById(anchor.elementId)) continue;
    try {
      const { delinkHypercite } = await import('../hypercites/deletion');
      await delinkHypercite(anchor.elementId, anchor.href);
      verbose.content(`Cut finalize: delinked anchor ${anchor.elementId}`, '/divEditor/cutHandler.ts');
    } catch (error) {
      log.error('Cut finalize: delink failed', '/divEditor/cutHandler.ts', error);
    }
  }

  // Cited source <u> tags: absent ⇒ tombstone (so paste restoration works even
  // when the mutation batch was dropped) + ghost the record. Uncited sources
  // are left to the save-time absence reconciler's bookkeeping.
  for (const hyperciteId of snapshot.sourceUIds) {
    if (document.getElementById(hyperciteId)) continue;
    try {
      const { openDatabase } = await import('../indexedDB/index');
      const { getHyperciteById } = await import('../hypercites/database');
      const record = await getHyperciteById(await openDatabase(), hyperciteId);
      if (!record) continue;
      if (!Array.isArray(record.citedIN) || record.citedIN.length === 0) continue;

      const hostBlock = snapshot.hostBlockId ? document.getElementById(snapshot.hostBlockId) : null;
      const { insertTombstone } = await import('../hypercites/tombstone');
      const tombstone = insertTombstone(hyperciteId, hostBlock);

      const { markHyperciteAsGhost } = await import('../hypercites/deletion');
      await markHyperciteAsGhost(hyperciteId);

      const landedBlock = tombstone ? findParentWithNumericalId(tombstone) : null;
      if (landedBlock) queueNodeForSave(landedBlock.id, 'update');
      verbose.content(`Cut finalize: tombstoned source ${hyperciteId}`, '/divEditor/cutHandler.ts');
    } catch (error) {
      log.error('Cut finalize: tombstone/ghost failed', '/divEditor/cutHandler.ts', error);
    }
  }
}

/**
 * `cut` event entry point (wired in SelectionDeletionHandler.setupListeners).
 * Must stay synchronous up to the snapshot.
 */
export function handleCutEvent(): void {
  const snapshot = snapshotCutSelection();
  if (!snapshot) return;
  verbose.content(
    `Cut snapshot: ${snapshot.sourceUIds.length} source u, ${snapshot.anchors.length} anchors`,
    '/divEditor/cutHandler.ts',
  );
  setTimeout(() => {
    finalizeCut(snapshot).catch((error) =>
      log.error('Cut finalize failed', '/divEditor/cutHandler.ts', error));
  }, CUT_FINALIZE_DELAY_MS);
}
