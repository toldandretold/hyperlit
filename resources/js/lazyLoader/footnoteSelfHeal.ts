import { verbose } from '../utilities/logger';
import { getDisplayNumber } from '../footnotes/FootnoteNumberingService';

// Module-level self-heal queue. When a chunk renders and the renderer detects
// that the stored sup `fn-count-id` disagrees with the dynamic map, it queues
// (bookId, startLine) here. A microtask-deferred flush then writes the
// corrected DOM back to IDB via the same batch path the renumber uses.
//
// This is defense-in-depth: `rebuildAndRenumber` already reconciles stored
// content on every footnote add/delete and after background download, but
// render-time heal also catches:
//   - Books whose IDB was stale from a session that predates the reconcile fix
//   - Background download failures / offline loads
//   - Cases where a chunk renders before any renumber has fired this session
const _renderHealQueue = new Map<string, Set<string>>(); // bookId -> Set<startLine string>
let _renderHealTimer: any = null;

// One write-back attempt per (bookId, startLine) per session. The heal persists
// from the LIVE DOM: when that DOM carries the same stale number (or the node
// isn't rendered at all, so batch falls back to the existing record), the write
// is a no-op and every future render of the chunk would re-queue it — an
// infinite save loop that starves the debounced server sync (cloudRef stuck
// orange). If one attempt doesn't converge, stop retrying; rebuildAndRenumber
// remains the primary reconcile mechanism.
const _healAttempted = new Set<string>(); // `${bookId}|${startLine}`

function _scheduleRenderHealFlush() {
  if (_renderHealTimer || _renderHealQueue.size === 0) return;
  // setTimeout(0) defers until after the synchronous render task completes —
  // by then the chunk is in the live DOM and batchUpdateIndexedDBRecords can
  // find it via [data-node-id]/[id] selectors.
  _renderHealTimer = setTimeout(async () => {
    _renderHealTimer = null;
    if (_renderHealQueue.size === 0) return;

    // Snapshot + clear so concurrent appends accumulate to a fresh queue
    const snapshot: any[] = [];
    for (const [bookId, set] of _renderHealQueue) {
      snapshot.push({ bookId, startLines: [...set] });
    }
    _renderHealQueue.clear();

    let batchUpdateIndexedDBRecords: any;
    try {
      ({ batchUpdateIndexedDBRecords } = await import('../indexedDB/nodes/batch'));
    } catch (e) {
      console.warn('[render-heal] failed to import batch module:', e);
      return;
    }

    for (const { bookId, startLines } of snapshot) {
      try {
        const records = startLines.map((id: any) => ({ id }));
        await batchUpdateIndexedDBRecords(records, { bookId, skipFootnoteRenumber: true });
        verbose.content(
          `[render-heal] persisted ${startLines.length} node(s) for ${bookId}`,
          'lazyLoaderFactory.js'
        );
      } catch (e) {
        console.warn(`[render-heal] persist failed for ${bookId}:`, e);
      }
    }
  }, 0);
}

/**
 * Queue a node for render-time self-heal write-back, reusing the same queue,
 * one-attempt-per-(bookId,startLine)-per-session guard, and deferred flush the
 * footnote heal uses. Callers detect that a chunk rendered stale stored content
 * (e.g. a transient `audio-reading` class baked into the DB) and, after fixing
 * the LIVE DOM, ask for the node to be re-persisted so IDB + Postgres converge.
 *
 * The one-attempt guard is load-bearing: it prevents the save loop that starves
 * the debounced server sync (see the sweep×self-heal regression). Never call
 * this for an offscreen render — the heal persists from the live DOM an
 * offscreen copy never touches, so it can't converge.
 */
export function queueRenderHeal(bookId: any, startLine: any): void {
  if (startLine == null || !bookId) return;
  const attemptKey = `${bookId}|${startLine}`;
  if (_healAttempted.has(attemptKey)) return;
  _healAttempted.add(attemptKey);
  if (!_renderHealQueue.has(bookId)) {
    _renderHealQueue.set(bookId, new Set());
  }
  _renderHealQueue.get(bookId)!.add(String(startLine));
  _scheduleRenderHealFlush();
}

/**
 * Apply dynamic footnote numbers to rendered HTML element.
 * Looks up display numbers from FootnoteNumberingService and updates
 * the fn-count-id attribute and link text.
 *
 * @param {HTMLElement} element - The DOM element (the temp wrapper containing
 *   a single node's content; this runs BEFORE the chunk is appended to the
 *   live DOM and BEFORE the firstElement's id="<startLine>" gets set).
 * @param {Object}      [nodeContext]            - Owning node context for self-heal
 * @param {number|string} [nodeContext.startLine]
 * @param {string}      [nodeContext.bookId]
 */
export function applyDynamicFootnoteNumbers(element: any, nodeContext: any = {}) {
  const { startLine, bookId } = nodeContext;
  // Find all footnote sups - both formats:
  // 1. Old format: <sup class="footnote-ref" fn-count-id="N" id="footnoteId">N</sup>
  // 2. New format: <sup fn-count-id="N" id="..."><a class="footnote-ref" href="#footnoteId">N</a></sup>
  const footnoteSups = element.querySelectorAll('sup[fn-count-id]');
  let mutatedThisNode = false;

  for (const sup of footnoteSups) {
    // Get footnoteId from anchor href (new format) or sup id (old format)
    const anchor = sup.querySelector('a.footnote-ref, a[href^="#"]');
    let footnoteId;

    if (anchor && anchor.getAttribute('href')) {
      // New format: get from anchor href
      footnoteId = anchor.getAttribute('href').replace(/^#/, '');
    } else {
      // Old format: get from sup id directly
      footnoteId = sup.id;
    }

    if (!footnoteId) continue;

    // Get the dynamic display number from the service
    const displayNumber = getDisplayNumber(footnoteId);

    if (displayNumber) {
      const newValue = displayNumber.toString();
      const oldValue = sup.getAttribute('fn-count-id');

      // Update the sup's fn-count-id attribute
      sup.setAttribute('fn-count-id', newValue);

      // Update the visible text
      if (anchor) {
        anchor.textContent = newValue;
      } else {
        sup.textContent = newValue;
      }

      if (oldValue !== newValue) {
        mutatedThisNode = true;

        // Diagnostic: record mutations where the renderer had to overwrite a
        // stale stored value. Tests enable via window.__fnDiag.enabled = true.
        if (typeof window !== 'undefined' && (window as any).__fnDiag && (window as any).__fnDiag.enabled) {
          if (!(window as any).__fnDiag.domMutations) (window as any).__fnDiag.domMutations = [];
          (window as any).__fnDiag.domMutations.push({
            source: 'applyDynamicFootnoteNumbers',
            startLine: startLine != null ? String(startLine) : null,
            footnoteId,
            oldValue,
            newValue,
            ts: Date.now(),
          });
          if ((window as any).__fnDiag.domMutations.length > 100) {
            (window as any).__fnDiag.domMutations.shift();
          }
        }
      }
    }
  }

  // Render-time self-heal: any sup we just had to rewrite means IDB's stored
  // content has the wrong number. Queue this node for write-back so future
  // integrity checks see DOM and IDB agreeing.
  if (mutatedThisNode) {
    queueRenderHeal(bookId, startLine);
  }
}
