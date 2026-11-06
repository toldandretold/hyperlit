/**
 * Suggested edits — data/service layer (no DOM building; the UI lives in
 * hyperlitContainer/suggestedEditControl.ts).
 *
 * A suggestion is a per-node {before, after} map stored on the suggester's own
 * HyperlightRecord (`suggested_text`, keyed by the same data-node-ids as
 * charData) plus a lifecycle `suggestion_status`. Creation/withdrawal ride the
 * ordinary hyperlights sync (IDB put → queueForSync → unified-sync → upsert,
 * which derives pending/null server-side); resolution is the book-owner's
 * POST /api/db/hyperlights/suggestion/resolve, mirrored into IDB directly
 * (no queueForSync — the server is already authoritative, and the owner could
 * not upsert someone else's highlight anyway).
 */

import { openDatabase, queueForSync, updateAnnotationsTimestamp } from '../indexedDB/index';
import { getNodesByDataNodeIDs } from '../indexedDB/hydration/rebuild';
import type { HyperlightRecord, NodeRecord, SuggestedEditPair, SuggestionStatus } from '../indexedDB/types';
import { log } from '../utilities/logger';

const LOG_PATH = '/hyperlights/suggestedEdit.ts';

/** Verdict targets: the three resolutions, plus 'pending' = REVERT an acceptance. */
export type SuggestionResolution = SuggestionStatus;

export interface SuggestionSegment {
  nodeId: string;
  startLine: number | string;
  chunkId: number;
  /** The span's CURRENT text, sliced live from the stored node content. */
  originalText: string;
  /** The proposed replacement (existing suggestion's `after`, else = originalText). */
  suggestedText: string;
  /** The stored at-suggestion-time snapshot, when a suggestion exists. */
  storedBefore: string | null;
  editable: boolean;
  reason?: string;
}

/** Read a hyperlight record by id (the container blockquote is a truncated copy — never the source). */
export async function getHighlightRecord(highlightId: string): Promise<HyperlightRecord | undefined> {
  const db = await openDatabase();
  const tx = db.transaction('hyperlights', 'readonly');
  const idx = tx.objectStore('hyperlights').index('hyperlight_id');
  return new Promise((res, rej) => {
    const req = idx.get(highlightId);
    req.onsuccess = () => res(req.result as HyperlightRecord | undefined);
    req.onerror = () => rej(req.error);
  });
}

/**
 * Slice a node's clean text at a charData range. The inverse of
 * calculateCleanTextOffset: offsets index the node's full `textContent`
 * (tags gone, entities decoded, footnote sup digits INCLUDED).
 */
export function sliceNodeCleanText(content: string, charStart: number, charEnd: number): string {
  const template = document.createElement('template');
  template.innerHTML = content;
  const text = template.content.textContent ?? '';
  return text.slice(charStart, charEnd);
}

/**
 * Per-node segments for the suggestion editor / diff / accept flow, in the
 * highlight's node order. A segment is non-editable when its anchor is a
 * ghost tombstone (charStart < 0), its node record is missing, or the node
 * carries latex (the server's CharDataRecalculator skips latex nodes, so
 * other annotations there could never be relocated after a splice).
 */
export async function getSuggestionSegments(record: HyperlightRecord): Promise<SuggestionSegment[]> {
  const nodeIds = record.node_id ?? [];
  if (!nodeIds.length) return [];

  const nodes = (await getNodesByDataNodeIDs(nodeIds))
    .filter((n) => n.book === record.book); // numeric node ids collide across sub-books
  const byId = new Map<string, NodeRecord>();
  for (const n of nodes) byId.set(String(n.node_id), n);

  const suggested = record.suggested_text ?? null;

  return nodeIds.map((nodeId) => {
    const range = record.charData?.[nodeId];
    const node = byId.get(nodeId);
    const pair: SuggestedEditPair | undefined = suggested?.[nodeId];

    const base: SuggestionSegment = {
      nodeId,
      startLine: node?.startLine ?? '',
      chunkId: Number(node?.chunk_id ?? 0),
      originalText: '',
      suggestedText: pair?.after ?? '',
      storedBefore: pair?.before ?? null,
      editable: false,
    };

    if (!range || range.charStart < 0 || range.charEnd < 0) {
      return { ...base, reason: 'The highlighted text was deleted from the book' };
    }
    if (!node) {
      return { ...base, reason: 'This part of the book is not available locally' };
    }
    const original = sliceNodeCleanText(node.content, range.charStart, range.charEnd);
    if (node.content.includes('<latex')) {
      return { ...base, originalText: original, suggestedText: pair?.after ?? original, reason: 'Passages containing math cannot be edited by suggestion' };
    }
    return {
      ...base,
      originalText: original,
      suggestedText: pair?.after ?? original,
      editable: true,
    };
  });
}

/** Shared IDB mutate + sync-queue helper (the annotations.ts save shape). */
async function mutateHighlightRecord(
  highlightId: string,
  mutate: (record: HyperlightRecord) => void,
): Promise<HyperlightRecord> {
  const db = await openDatabase();
  const tx = db.transaction('hyperlights', 'readwrite');
  const store = tx.objectStore('hyperlights');
  const idx = store.index('hyperlight_id');
  const record: HyperlightRecord | undefined = await new Promise((res, rej) => {
    const req = idx.get(highlightId);
    req.onsuccess = () => res(req.result as HyperlightRecord | undefined);
    req.onerror = () => rej(req.error);
  });
  if (!record) throw new Error(`No highlight record for ${highlightId}`);
  mutate(record);
  await new Promise<void>((res, rej) => {
    const put = store.put(record);
    put.onsuccess = () => res();
    put.onerror = () => rej(put.error);
  });
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  return record;
}

/**
 * Save (or re-edit) a suggestion. `afterByNode` holds the editor's textarea
 * values; entries identical to the live original are dropped, and `before`
 * snapshots that live original at save time. An empty resulting map withdraws.
 */
export async function saveSuggestion(
  highlightId: string,
  afterByNode: Record<string, string>,
): Promise<'saved' | 'withdrawn'> {
  const record = await getHighlightRecord(highlightId);
  if (!record) throw new Error(`No highlight record for ${highlightId}`);

  const segments = await getSuggestionSegments(record);
  const map: Record<string, SuggestedEditPair> = {};
  for (const segment of segments) {
    if (!segment.editable) continue;
    const after = afterByNode[segment.nodeId];
    if (typeof after !== 'string') continue;
    if (after === segment.originalText) continue; // unchanged — not a suggestion
    map[segment.nodeId] = {
      // Keep the ORIGINAL stored snapshot on re-edit: `before` means "what the
      // suggester was responding to", not "the text at last keystroke".
      before: segment.storedBefore ?? segment.originalText,
      after,
    };
  }

  const withdrawn = Object.keys(map).length === 0;
  const updated = await mutateHighlightRecord(highlightId, (rec) => {
    rec.suggested_text = withdrawn ? null : map;
    rec.suggestion_status = withdrawn ? null : 'pending';
  });
  queueForSync('hyperlights', highlightId, 'update', updated);
  updateAnnotationsTimestamp(updated.book);
  log.user(`Suggestion ${withdrawn ? 'withdrawn' : 'saved'} for ${highlightId}`, LOG_PATH);
  return withdrawn ? 'withdrawn' : 'saved';
}

/** Withdraw an existing suggestion outright. */
export async function withdrawSuggestion(highlightId: string): Promise<void> {
  const updated = await mutateHighlightRecord(highlightId, (rec) => {
    rec.suggested_text = null;
    rec.suggestion_status = null;
  });
  queueForSync('hyperlights', highlightId, 'update', updated);
  updateAnnotationsTimestamp(updated.book);
  log.user(`Suggestion withdrawn for ${highlightId}`, LOG_PATH);
}

/**
 * Reopen a REJECTED or LIKED suggestion back to pending (reconsider). The book
 * body never changed for those verdicts, so this is a pure status flip — no
 * splice (unlike reverting an ACCEPTED one, which is suggestedEditAccept's
 * revertSuggestion). The owner lands back at the full Accept/Like/Decline row.
 */
export async function reopenSuggestion(book: string, highlightId: string): Promise<void> {
  await resolveSuggestion(book, highlightId, 'pending');
}

/**
 * Record the book owner's verdict. Server-authoritative: on success the local
 * record's status is mirrored directly (no queueForSync — the owner cannot
 * upsert someone else's highlight row, and must not try).
 */
export async function resolveSuggestion(
  book: string,
  highlightId: string,
  resolution: SuggestionResolution,
): Promise<void> {
  const csrfToken = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
  const response = await fetch('/api/db/hyperlights/suggestion/resolve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-CSRF-TOKEN': csrfToken,
    },
    credentials: 'include',
    body: JSON.stringify({ book, hyperlight_id: highlightId, resolution }),
  });
  const bodyText = await response.text(); // drains unconditionally (fetch-drain gate)
  if (!response.ok) {
    throw new Error(`Suggestion resolve failed: ${response.status} - ${bodyText}`);
  }

  await mutateHighlightRecord(highlightId, (rec) => {
    rec.suggestion_status = resolution;
  });
  log.user(`Suggestion ${highlightId} ${resolution === 'pending' ? 'reverted to pending' : `resolved: ${resolution}`}`, LOG_PATH);
}
