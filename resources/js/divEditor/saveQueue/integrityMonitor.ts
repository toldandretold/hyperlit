/**
 * IntegrityMonitor — the post-save + full-book integrity verification and
 * self-healing subsystem, extracted from SaveQueue.
 *
 * It is constructed with the queue (typed as IntegritySurface) and drives it
 * uni-directionally: reading pendingSaves / currentSavePromise / _lastInputTimestamp
 * and calling queueNode() / flush(). Its OWN state (the self-heal re-entrancy guard
 * and the full-verify debounce timer) lives here, not on SaveQueue.
 */
import { verbose } from '../../utilities/logger';
import { asLineId, type LineId, type BookId } from '../../utilities/idHelpers';
import { book as currentBook } from '../../app';
import { INLINE_SKIP_TAGS } from '../../utilities/blockElements';
import { verifyNodesIntegrity, findOrphanedNodes, healVerbatimDuplicates } from '../../integrity/verifier';
import { reportIntegrityFailure, type OrphanNode } from '../../integrity/reporter';
import type { IntegritySurface, PendingNode } from './types';

export class IntegrityMonitor {
  private queue: IntegritySurface;
  private _selfHealingInProgress = false;
  private _fullVerifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(queue: IntegritySurface) {
    this.queue = queue;
  }

  /** Cancel a pending full-book verification (called when new saves are queued). */
  cancelFullVerification(): void {
    if (this._fullVerifyTimer) {
      clearTimeout(this._fullVerifyTimer);
      this._fullVerifyTimer = null;
    }
  }

  destroy(): void {
    this.cancelFullVerification();
  }

  /**
   * Non-blocking post-save integrity verification.
   * Runs in requestIdleCallback so it never blocks typing.
   */
  verifyAfterSave(recordsByBookId: Map<BookId | null, PendingNode[]>): void {
    // Delay 500ms so the 200ms input debounce can re-queue any active node.
    // Without this, requestIdleCallback fires between keystrokes before the
    // node enters pendingSaves, causing false integrity mismatches.
    setTimeout(() => {
      // Bail if the SaveQueue was destroyed (e.g., sub-book closed)
      if (this.queue._destroyed) return;
      // Bail if new saves were queued during the delay — next save will re-verify
      if (this.queue.pendingSaves.nodes.size > 0) return;

      const schedule = typeof requestIdleCallback === 'function'
        ? (fn: () => void) => requestIdleCallback(fn, { timeout: 3000 })
        : (fn: () => void) => setTimeout(fn, 100);

      schedule(async () => {
      try {
        const msSinceLastInput = Date.now() - this.queue._lastInputTimestamp;
        if (msSinceLastInput < 400) return;
        if (this.queue.pendingSaves.nodes.size > 0) return;

        for (const [bookId, records] of recordsByBookId) {
          const effectiveBookId = bookId || currentBook;
          if (!effectiveBookId) continue;

          const nodeIds = records.map(r => r.id).filter(Boolean)
              .filter(id => !this.queue.pendingSaves.nodes.has(id));
          if (nodeIds.length === 0) continue;

          const verifyStartedAt = Date.now();
          const result = await verifyNodesIntegrity(effectiveBookId, nodeIds);

          // Yield to let any in-flight input events update _lastInputTimestamp
          await new Promise(resolve => setTimeout(resolve, 50));

          if (this.queue._lastInputTimestamp > verifyStartedAt || this.queue.pendingSaves.nodes.size > 0) {
            verbose.content('[integrity] Skipping post-save results — user typed during verification', 'divEditor/saveQueue/integrityMonitor.ts');
            continue;
          }

          const failedIds = [
            ...result.missingFromIDB.map(m => m.startLine),
            ...result.mismatches.map(m => m.startLine),
          ];

          if (failedIds.length > 0 && !this._selfHealingInProgress) {
            // Attempt self-healing: re-queue failed nodes → flush → re-verify
            verbose.content(`[integrity] Post-save self-healing: re-queuing ${failedIds.length} nodes`, 'divEditor/saveQueue/integrityMonitor.ts');
            this._selfHealingInProgress = true;
            try {
              // Don't overwrite IDB with empty DOM — that's data destruction
              const safeToHeal = failedIds.filter((id) => {
                const m = result.mismatches.find(m => m.startLine === id);
                if (m && !m.domText.trim() && m.idbText.trim()) {
                  console.warn(`[integrity] Skipping self-heal for node ${id}: DOM empty but IDB has "${m.idbText.substring(0, 50)}"`);
                  return false;
                }
                return true;
              });
              for (const id of safeToHeal) {
                this.queue.queueNode(asLineId(id), 'update', effectiveBookId);
              }
              await this.queue.flush();
              const retryStartedAt = Date.now();
              const retryResult = await verifyNodesIntegrity(effectiveBookId, nodeIds);
              if (this.queue._lastInputTimestamp > retryStartedAt || this.queue.pendingSaves.nodes.size > 0) {
                verbose.content('[integrity] Skipping self-heal retry — user typed during re-verification', 'divEditor/saveQueue/integrityMonitor.ts');
                continue;
              }
              if (retryResult.mismatches.length > 0 || retryResult.missingFromIDB.length > 0 || retryResult.duplicateIds.length > 0) {
                reportIntegrityFailure({
                  bookId: effectiveBookId,
                  mismatches: retryResult.mismatches,
                  missingFromIDB: retryResult.missingFromIDB,
                  duplicateIds: retryResult.duplicateIds,
                  trigger: 'save',
                });
              } else {
                verbose.content(`[integrity] Post-save self-healing succeeded for ${failedIds.length} nodes`, 'divEditor/saveQueue/integrityMonitor.ts');
                reportIntegrityFailure({
                  bookId: effectiveBookId,
                  mismatches: result.mismatches,
                  missingFromIDB: result.missingFromIDB,
                  duplicateIds: result.duplicateIds,
                  trigger: 'save',
                  selfHealed: true,
                  selfHealedNodeIds: failedIds,
                });
              }
            } finally {
              this._selfHealingInProgress = false;
            }
          } else if (result.duplicateIds.length > 0 || this._selfHealingInProgress) {
            const verbatimHealed = !this._selfHealingInProgress
              ? healVerbatimDuplicates(effectiveBookId)
              : [];

            let finalResult = result;
            if (verbatimHealed.length > 0) {
              const freshNodeIds = this._collectNodeIds(effectiveBookId);
              finalResult = await verifyNodesIntegrity(effectiveBookId, freshNodeIds);
            }

            if (verbatimHealed.length > 0 && finalResult.duplicateIds.length === 0
                && finalResult.mismatches.length === 0 && finalResult.missingFromIDB.length === 0) {
              reportIntegrityFailure({
                bookId: effectiveBookId,
                mismatches: result.mismatches,
                missingFromIDB: result.missingFromIDB,
                duplicateIds: result.duplicateIds,
                trigger: 'save',
                selfHealed: true,
                selfHealedNodeIds: verbatimHealed,
              });
            } else {
              reportIntegrityFailure({
                bookId: effectiveBookId,
                mismatches: finalResult.mismatches,
                missingFromIDB: finalResult.missingFromIDB,
                duplicateIds: finalResult.duplicateIds,
                trigger: 'save',
              });
            }
          }

          // Schedule a full-book scan on a longer debounce
          this._scheduleFullVerification(effectiveBookId);
        }
      } catch (e) {
        console.warn('[integrity] Post-save verification error:', e);
      }
      });
    }, 500);
  }

  /**
   * Re-scan the DOM for the current numerical node ids of a book — mirrors the
   * collection in `_scheduleFullVerification`. Used after a self-heal step
   * that may have removed DOM elements.
   */
  private _collectNodeIds(bookId: BookId): LineId[] {
    const container = document.querySelector(`[data-book-id="${bookId}"]`)
      || document.getElementById(bookId);
    if (!container) return [];
    const ids: LineId[] = [];
    container.querySelectorAll('[id]').forEach(el => {
      if (/^\d+(\.\d+)?$/.test(el.id) && !INLINE_SKIP_TAGS.has(el.tagName)) ids.push(asLineId(el.id));
    });
    return ids;
  }

  /**
   * Schedule a full-book verification that scans ALL visible nodes against IDB.
   * Debounced at 10s after the last save settles, runs in requestIdleCallback.
   */
  private _scheduleFullVerification(bookId: BookId): void {
    if (this._fullVerifyTimer) clearTimeout(this._fullVerifyTimer);
    this._fullVerifyTimer = setTimeout(() => {
      this._fullVerifyTimer = null;
      const schedule = typeof requestIdleCallback === 'function'
        ? (fn: () => void) => requestIdleCallback(fn, { timeout: 5000 })
        : (fn: () => void) => setTimeout(fn, 200);

      schedule(async () => {
        // Guard: bail if new saves were queued — next save will reschedule
        if (this.queue.pendingSaves.nodes.size > 0) return;

        // Guard: wait for any in-flight batch write to commit before reading IDB
        if (this.queue.currentSavePromise) {
          await this.queue.currentSavePromise;
        }

        const container = document.querySelector(`[data-book-id="${bookId}"]`)
          || document.getElementById(bookId);
        if (!container) return;

        const nodeEls = container.querySelectorAll('[id]');
        const nodeIds: LineId[] = [];
        nodeEls.forEach(el => {
          if (/^\d+(\.\d+)?$/.test(el.id) && !INLINE_SKIP_TAGS.has(el.tagName)) nodeIds.push(asLineId(el.id));
        });
        if (nodeIds.length === 0) return;

        try {
          verbose.content(`[integrity] Full-book verification: checking ${nodeIds.length} nodes for ${bookId}`, 'divEditor/saveQueue/integrityMonitor.ts');
          const verifyStartedAt = Date.now();
          const result = await verifyNodesIntegrity(bookId, nodeIds);

          // Yield to let any in-flight input events update _lastInputTimestamp
          await new Promise(resolve => setTimeout(resolve, 50));

          if (this.queue._lastInputTimestamp > verifyStartedAt || this.queue.pendingSaves.nodes.size > 0) {
            verbose.content('[integrity] Skipping full-scan results — user typed during verification', 'divEditor/saveQueue/integrityMonitor.ts');
            return;
          }

          const failedIds = [
            ...result.missingFromIDB.map(m => m.startLine),
            ...result.mismatches.map(m => m.startLine),
          ];

          if (failedIds.length > 0 && !this._selfHealingInProgress) {
            verbose.content(`[integrity] Full-scan self-healing: re-queuing ${failedIds.length} nodes`, 'divEditor/saveQueue/integrityMonitor.ts');
            this._selfHealingInProgress = true;
            try {
              // Don't overwrite IDB with empty DOM — that's data destruction
              const safeToHeal = failedIds.filter((id) => {
                const m = result.mismatches.find(m => m.startLine === id);
                if (m && !m.domText.trim() && m.idbText.trim()) {
                  console.warn(`[integrity] Skipping self-heal for node ${id}: DOM empty but IDB has "${m.idbText.substring(0, 50)}"`);
                  return false;
                }
                return true;
              });
              for (const id of safeToHeal) {
                this.queue.queueNode(asLineId(id), 'update', bookId);
              }
              await this.queue.flush();
              const retryStartedAt = Date.now();
              const retryResult = await verifyNodesIntegrity(bookId, nodeIds);
              if (this.queue._lastInputTimestamp > retryStartedAt || this.queue.pendingSaves.nodes.size > 0) {
                verbose.content('[integrity] Skipping full-scan self-heal retry — user typed during re-verification', 'divEditor/saveQueue/integrityMonitor.ts');
                return;
              }
              if (retryResult.mismatches.length > 0 || retryResult.missingFromIDB.length > 0 || retryResult.duplicateIds.length > 0) {
                reportIntegrityFailure({
                  bookId,
                  mismatches: retryResult.mismatches,
                  missingFromIDB: retryResult.missingFromIDB,
                  duplicateIds: retryResult.duplicateIds,
                  trigger: 'periodic-save',
                });
              } else {
                verbose.content(`[integrity] Full-scan self-healing succeeded for ${failedIds.length} nodes`, 'divEditor/saveQueue/integrityMonitor.ts');
                reportIntegrityFailure({
                  bookId,
                  mismatches: result.mismatches,
                  missingFromIDB: result.missingFromIDB,
                  duplicateIds: result.duplicateIds,
                  trigger: 'periodic-save',
                  selfHealed: true,
                  selfHealedNodeIds: failedIds,
                });
              }
            } finally {
              this._selfHealingInProgress = false;
            }
          } else if (result.duplicateIds.length > 0 || this._selfHealingInProgress) {
            const verbatimHealed = !this._selfHealingInProgress
              ? healVerbatimDuplicates(bookId)
              : [];

            let finalResult = result;
            if (verbatimHealed.length > 0) {
              const freshNodeIds = this._collectNodeIds(bookId);
              finalResult = await verifyNodesIntegrity(bookId, freshNodeIds);
            }

            if (verbatimHealed.length > 0 && finalResult.duplicateIds.length === 0
                && finalResult.mismatches.length === 0 && finalResult.missingFromIDB.length === 0) {
              reportIntegrityFailure({
                bookId,
                mismatches: result.mismatches,
                missingFromIDB: result.missingFromIDB,
                duplicateIds: result.duplicateIds,
                trigger: 'periodic-save',
                selfHealed: true,
                selfHealedNodeIds: verbatimHealed,
              });
            } else {
              reportIntegrityFailure({
                bookId,
                mismatches: finalResult.mismatches,
                missingFromIDB: finalResult.missingFromIDB,
                duplicateIds: finalResult.duplicateIds,
                trigger: 'periodic-save',
              });
            }
          } else {
            verbose.content(`[integrity] Full-book verification: all ${result.ok.length} nodes OK`, 'divEditor/saveQueue/integrityMonitor.ts');
          }

          // Orphan check: find block-level elements without numeric IDs
          const orphans = findOrphanedNodes(bookId);
          if (orphans.length > 0) {
            console.warn(`[integrity] Full-scan orphan check: found ${orphans.length} orphaned node(s)`);
            const { setElementIds, findPreviousElementId, findNextElementId } = await import('../../utilities/IDfunctions');

            const orphanedNodes: OrphanNode[] = [];
            for (const orphan of orphans) {
              try {
                const beforeId = findPreviousElementId(orphan.element);
                const afterId = findNextElementId(orphan.element);
                setElementIds(orphan.element, beforeId, afterId, bookId);
                console.log(`[integrity] Assigned ID ${orphan.element.id} to orphaned <${orphan.tag}> element`);
                this.queue.queueNode(asLineId(orphan.element.id), 'add', bookId);
                orphanedNodes.push({
                  tag: orphan.tag,
                  textSnippet: orphan.textSnippet,
                  assignedId: orphan.element.id,
                });
              } catch (err) {
                console.error(`[integrity] Failed to heal orphaned <${orphan.tag}>:`, err);
                orphanedNodes.push({
                  tag: orphan.tag,
                  textSnippet: orphan.textSnippet,
                  healFailed: true,
                  error: (err as Error).message,
                });
              }
            }

            await this.queue.flush();

            reportIntegrityFailure({
              bookId,
              mismatches: [],
              missingFromIDB: [],
              duplicateIds: [],
              orphanedNodes,
              trigger: 'periodic-save',
              selfHealed: true,
            });
          }
        } catch (e) {
          console.warn('[integrity] Full-book verification error:', e);
        }
      });
    }, 10_000);
  }
}
