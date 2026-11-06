/**
 * Accepting a suggested edit — the node splice. Runs CLIENT-SIDE on the book
 * owner's machine through the normal edit path, per changed node:
 *
 *  - rendered node (path A): unwrap marks/<u>s, splice the charData range in
 *    the live DOM (reprocessHighlightsForNodes surgery template), shift the
 *    node's annotation views by the length delta, re-apply marks, then
 *    `batchUpdateIndexedDBRecords([{id}], {source:'edit'})` — the DOM is the
 *    truth, so content extraction + mark re-measure + sync all come free;
 *  - unrendered node (path B, lazy chunk never rendered): splice the STORED
 *    record content detached and pass it as explicit `html` (+ explicit
 *    `chunk_id` — determineChunkIdFromDOM is blind for an absent node).
 *
 * Idempotent by construction: a node whose live slice already equals `after`
 * is counted applied and skipped, so a retry after a failed resolve re-enters
 * with nothing left to splice. A node whose live slice matches NEITHER side
 * drifted since the suggestion — refused, never clobbered. The server's
 * CharDataRecalculator re-anchors every OTHER annotation authoritatively on
 * the node write; the local view shift is for the owner's immediate render.
 */
import {
  getHighlightRecord,
  getSuggestionSegments,
  sliceNodeCleanText,
  resolveSuggestion,
} from './suggestedEdit';
import { unwrapMark, unwrapElement } from './deletion';
import { attachMarkListeners } from './listeners';
import { setProgrammaticUpdateInProgress } from '../utilities/operationState';
import { isExternallyTranslated } from '../utilities/externalTranslation';
import { isBookStaleForEdit } from '../utilities/staleBookGate';
import { canUserEditBook } from '../utilities/auth/index';
import { openDatabase, batchUpdateIndexedDBRecords } from '../indexedDB/index';
import { getNodesByDataNodeIDs } from '../indexedDB/hydration/rebuild';
import { asLineId } from '../utilities/idHelpers';
import { asChunkId } from '../indexedDB/types';
import type { CharRange, HyperlightRecord, NodeRecord } from '../indexedDB/types';
import { log, verbose } from '../utilities/logger';

const LOG_PATH = '/hyperlights/suggestedEditAccept.ts';

export type AcceptOutcome =
  | { status: 'blocked'; reason: string }
  | { status: 'done'; applied: string[]; skipped: Array<{ nodeId: string; reason: string }> };

/**
 * Replace clean-text offsets [charStart, charEnd) inside rootEl with
 * `replacement`, verifying the range's current text equals `expected` first
 * (a mismatch means the DOM drifted from what the offsets were measured
 * against — abort rather than splice the wrong words).
 */
export function spliceCleanTextRange(
  rootEl: Element,
  charStart: number,
  charEnd: number,
  replacement: string,
  expected: string,
): void {
  const doc = rootEl.ownerDocument;
  const walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  let current = walker.nextNode() as Text | null;
  while (current) {
    const length = current.data.length;
    // `>` so a boundary start lands in the node that CONTAINS the character.
    if (!startNode && offset + length > charStart) {
      startNode = current;
      startOffset = charStart - offset;
    }
    if (offset + length >= charEnd) {
      endNode = current;
      endOffset = charEnd - offset;
      break;
    }
    offset += length;
    current = walker.nextNode() as Text | null;
  }
  if (!startNode || !endNode) {
    throw new Error('Splice range not found in node text');
  }

  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  if (range.toString() !== expected) {
    throw new Error('Passage has changed since this was suggested');
  }
  range.deleteContents();
  range.insertNode(doc.createTextNode(replacement));
  rootEl.normalize();
}

/** Shift one view's range across a splice of [start, end) → replacement of newLen. */
export function shiftRangeForSplice(
  range: CharRange,
  spliceStart: number,
  spliceEnd: number,
  newLength: number,
): CharRange {
  const delta = newLength - (spliceEnd - spliceStart);
  if (range.charStart < 0 || range.charEnd < 0) return range; // already a tombstone
  if (range.charEnd <= spliceStart) return range; // wholly before
  if (range.charStart >= spliceEnd) {
    return { ...range, charStart: range.charStart + delta, charEnd: range.charEnd + delta };
  }
  if (range.charStart >= spliceStart && range.charEnd <= spliceEnd) {
    // Swallowed by the splice — tombstone (CharDataRecalculator's contract).
    return { ...range, charStart: -1, charEnd: -1 };
  }
  if (range.charStart < spliceStart && range.charEnd > spliceEnd) {
    // Spans the splice — keep both sides, absorb the delta.
    return { ...range, charEnd: range.charEnd + delta };
  }
  if (range.charStart < spliceStart) {
    // Ends inside the splice — clip at the splice start.
    return { ...range, charEnd: spliceStart };
  }
  // Starts inside the splice — begins after the replacement.
  return { ...range, charStart: spliceStart + newLength, charEnd: range.charEnd + delta };
}

/** Locate the rendered element for a node, scoped to its book container. */
function findRenderedNode(book: string, startLine: number | string): HTMLElement | null {
  const bookContainer = document.querySelector(`[data-book-id="${book}"]`)
    || document.getElementById(book);
  const idSelector = `[id="${String(startLine)}"]`;
  return (bookContainer
    ? bookContainer.querySelector<HTMLElement>(idSelector)
    : document.querySelector<HTMLElement>(idSelector));
}

/** Update the suggestion record's own anchor after a path-B (detached) splice. */
async function updateSuggestionAnchorLocally(
  record: HyperlightRecord,
  nodeId: string,
  newRange: CharRange,
  newNodeContent: string,
): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('hyperlights', 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const store = tx.objectStore('hyperlights');
    const req = store.get([record.book, record.hyperlight_id]);
    req.onsuccess = () => {
      const fresh = req.result as HyperlightRecord | undefined;
      if (!fresh) return;
      fresh.charData = { ...fresh.charData, [nodeId]: newRange };
      // Rebuild the concatenated passage text from the updated anchor.
      fresh.highlightedText = (fresh.node_id ?? [])
        .map((id) => {
          const r = fresh.charData[id];
          if (!r || r.charStart < 0) return '';
          if (id === nodeId) return sliceNodeCleanText(newNodeContent, r.charStart, r.charEnd);
          return ''; // other nodes re-measure on next render/pull; text here is best-effort
        })
        .filter(Boolean)
        .join(' ') || fresh.highlightedText;
      store.put(fresh);
    };
  });
  // No queueForSync: the owner cannot upsert someone else's highlight row —
  // the server's CharDataRecalculator re-anchors it on the node write.
}

/** Accept applies before→after; revert (undo of an acceptance) applies after→before. */
type SpliceDirection = 'accept' | 'revert';

/**
 * Splice a suggestion into (or back out of) the book, then record the verdict
 * via the resolve endpoint — accept: pending → accepted; revert: accepted →
 * pending (the full decision space returns). Gates mirror editButton's entry
 * checks.
 */
async function spliceSuggestion(highlightId: string, direction: SpliceDirection): Promise<AcceptOutcome> {
  const record = await getHighlightRecord(highlightId);
  const requiredStatus = direction === 'accept' ? 'pending' : 'accepted';
  if (!record || record.suggestion_status !== requiredStatus || !record.suggested_text) {
    return {
      status: 'blocked',
      reason: direction === 'accept'
        ? 'This suggestion is no longer pending.'
        : 'Only an accepted suggestion can be reverted.',
    };
  }
  const book = record.book;

  if (isExternallyTranslated()) {
    return {
      status: 'blocked',
      reason: 'Your browser is translating this page, so on-screen text does not match the book. Turn translation off and reload first.',
    };
  }
  if (isBookStaleForEdit(book)) {
    return {
      status: 'blocked',
      reason: 'This book was edited in another tab, so this view is out of date. Refresh to load the latest first.',
    };
  }
  if (!(await canUserEditBook(book))) {
    return { status: 'blocked', reason: `Only the book owner can ${direction} a suggested edit.` };
  }

  const segments = await getSuggestionSegments(record);
  const nodes = (await getNodesByDataNodeIDs(Object.keys(record.suggested_text)))
    .filter((n) => n.book === book);
  const nodeByDataId = new Map<string, NodeRecord>();
  for (const n of nodes) nodeByDataId.set(String(n.node_id), n);

  const applied: string[] = [];
  const skipped: Array<{ nodeId: string; reason: string }> = [];

  for (const [nodeId, pair] of Object.entries(record.suggested_text)) {
    const segment = segments.find((s) => s.nodeId === nodeId);
    const nodeRecord = nodeByDataId.get(nodeId);
    const range = record.charData?.[nodeId];

    const fromText = direction === 'accept' ? pair.before : pair.after;
    const toText = direction === 'accept' ? pair.after : pair.before;

    if (!segment || !nodeRecord || !range) {
      skipped.push({ nodeId, reason: 'This part of the book is not available locally' });
      continue;
    }
    if (!segment.editable) {
      // Already-applied idempotent re-entry reads as drift below, so check first.
      if (segment.originalText === toText) { applied.push(nodeId); continue; }
      skipped.push({ nodeId, reason: segment.reason ?? 'This passage cannot be edited' });
      continue;
    }
    if (segment.originalText === toText) {
      applied.push(nodeId); // already applied (retry after a failed resolve)
      continue;
    }
    if (segment.originalText !== fromText) {
      skipped.push({
        nodeId,
        reason: direction === 'accept'
          ? 'The passage has changed since this was suggested'
          : 'The passage has changed since this was accepted',
      });
      continue;
    }

    const newRange: CharRange = { charStart: range.charStart, charEnd: range.charStart + toText.length };
    const nodeEl = findRenderedNode(book, nodeRecord.startLine);

    try {
      if (nodeEl) {
        // ── Path A: rendered node — splice the live DOM, re-apply marks ──
        const { applyHighlights, applyHypercites } = await import('../lazyLoader/index');
        setProgrammaticUpdateInProgress(true);
        try {
          nodeEl.querySelectorAll('mark[class*="HL_"]').forEach((mark) => {
            unwrapMark(mark);
            mark.parentNode?.normalize();
          });
          nodeEl.querySelectorAll('u[id^="hypercite_"]').forEach((u) => unwrapElement(u));
          nodeEl.normalize();

          spliceCleanTextRange(nodeEl, range.charStart, range.charEnd, toText, fromText);

          const shiftedHighlights = (nodeRecord.hyperlights ?? []).map((view) => (
            view.highlightID === highlightId
              ? { ...view, ...newRange }
              : { ...view, ...shiftRangeForSplice(view, range.charStart, range.charEnd, toText.length) }
          ));
          const shiftedHypercites = (nodeRecord.hypercites ?? []).map((view) => ({
            ...view,
            ...shiftRangeForSplice(view, range.charStart, range.charEnd, toText.length),
          }));

          const cleanHtml = nodeEl.innerHTML;
          let newHtml = applyHighlights(cleanHtml, shiftedHighlights, book);
          const liveCites = shiftedHypercites.filter((v) => v.charStart >= 0);
          if (liveCites.length > 0) {
            newHtml = applyHypercites(newHtml, liveCites);
          }
          nodeEl.innerHTML = newHtml;

          attachMarkListeners();
          const { attachUnderlineClickListeners } = await import('../hypercites/index');
          attachUnderlineClickListeners();
        } finally {
          requestAnimationFrame(() => setProgrammaticUpdateInProgress(false));
        }

        // The DOM is now the truth: extraction + mark re-measure (including the
        // suggestion's own new charData/highlightedText) + sync, all in batch.
        await batchUpdateIndexedDBRecords(
          [{ id: asLineId(String(nodeRecord.startLine)) }],
          { bookId: book, source: 'edit' },
        );
      } else {
        // ── Path B: unrendered node — splice the stored record detached ──
        const template = document.createElement('template');
        template.innerHTML = nodeRecord.content;
        const rootEl = template.content.firstElementChild;
        if (!rootEl) throw new Error('Stored node content is empty');

        spliceCleanTextRange(rootEl, range.charStart, range.charEnd, toText, fromText);

        await batchUpdateIndexedDBRecords(
          [{
            id: asLineId(String(nodeRecord.startLine)),
            html: rootEl.outerHTML,
            // Explicit on purpose: determineChunkIdFromDOM is blind for an
            // absent node and would corrupt the chunk assignment.
            chunk_id: asChunkId(Number(nodeRecord.chunk_id)),
          }],
          { bookId: book, source: 'edit' },
        );

        // Mark re-measure didn't run (no DOM) — move the suggestion's own
        // anchor locally so its render matches what the server will compute.
        await updateSuggestionAnchorLocally(record, nodeId, newRange, rootEl.outerHTML);
      }

      applied.push(nodeId);
      verbose.content(`Suggestion splice applied on node ${nodeId}`, LOG_PATH);
    } catch (error) {
      skipped.push({ nodeId, reason: (error as Error)?.message ?? 'Splice failed' });
      log.error(`Suggestion splice failed on node ${nodeId}`, LOG_PATH, error);
    }
  }

  if (applied.length === 0) {
    // Nothing changed in the book — leave the status where it is rather than
    // record a verdict that applied nothing.
    return { status: 'done', applied, skipped };
  }

  await resolveSuggestion(book, highlightId, direction === 'accept' ? 'accepted' : 'pending');
  log.user(`Suggestion ${highlightId} ${direction === 'accept' ? 'accepted' : 'reverted'} (${applied.length} node(s), ${skipped.length} skipped)`, LOG_PATH);
  return { status: 'done', applied, skipped };
}

/** Accept a pending suggestion: splice before→after, record `accepted`. */
export function acceptSuggestion(highlightId: string): Promise<AcceptOutcome> {
  return spliceSuggestion(highlightId, 'accept');
}

/**
 * Revert an ACCEPTED suggestion: splice after→before and return the
 * suggestion to `pending` — the owner gets the full decision space back
 * (decline it properly, re-accept later, or just leave it).
 */
export function revertSuggestion(highlightId: string): Promise<AcceptOutcome> {
  return spliceSuggestion(highlightId, 'revert');
}
