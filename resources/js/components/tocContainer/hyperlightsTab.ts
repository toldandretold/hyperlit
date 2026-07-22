/**
 * hyperlightsTab — the TOC container's second tab: everything the current user
 * has "hyperlighted" in the open book — HIGHLIGHTS and <u> CITES — merged into
 * one CURRENT-document-order list (the same order the hyperlit container's ↑↓
 * arrows walk). Logged-in OR anonymous (ownership via the identity tests in
 * myHighlights/list). Ghosts (underlying text deleted) are interleaved at
 * their last-known position, dimmed with 👻.
 *
 * Entry shape: blockquote of the marked text; beneath it, a highlight shows
 * its annotation snippet (from preview_nodes — annotations LIVE IN THE
 * SUB-BOOK; record.annotation is legacy) while a cite shows "Cited in: <the
 * citing books/footnotes/annotations>" resolved via parseCitedInLink + the
 * library store ("Not cited anywhere yet" for un-pasted singles).
 *
 * Clicking an entry is handled by tocContainer/index.ts's delegated handler.
 */

import DOMPurify from 'dompurify';
import type { HyperciteRecord, HyperlightRecord } from '../../indexedDB/types';
import { getAuthContextSync, getAuthContext } from '../../utilities/auth/index';
import { getOwnedAnnotationsForBook, type AuthIdentity, type OwnedAnnotation } from '../../hyperlights/myHighlights/list';
import { partitionGhosts, isHyperciteGhosted } from '../../hyperlights/myHighlights/ghost';
import { parseCitedInLink } from '../../hyperlitContainer/contentBuilders/displayHypercites/hyperciteLinks';
import { openDatabase } from '../../indexedDB/core/connection';

const TEXT_LIMIT = 120;
const NOTE_LIMIT = 80;

/** One renderable row — precomputed async bits (notes, ghost flags) resolved. */
export interface DisplayEntry {
  id: string;
  kind: 'highlight' | 'hypercite';
  text: string;
  note: string;
  ghosted: boolean;
}

/** Sanitize to plain text and truncate WITHOUT an ellipsis marker. */
function plainText(html: string | null | undefined, limit: number): string {
  const text = DOMPurify.sanitize(String(html ?? ''), { ALLOWED_TAGS: [] }).trim();
  return text.length > limit ? text.slice(0, limit).trimEnd() : text;
}

/**
 * The annotation snippet for a highlight. Annotations LIVE IN THE SUB-BOOK —
 * `record.annotation` is legacy and usually empty for new highlights. The
 * record carries `preview_nodes` (cached sub-book snippets): use the first
 * non-empty one; fall back to the legacy field.
 */
function annotationSnippet(record: HyperlightRecord): string {
  const previews = Array.isArray(record.preview_nodes) ? record.preview_nodes : [];
  for (const node of previews) {
    const content = (node as { content?: unknown } | null)?.content;
    const text = plainText(typeof content === 'string' ? content : '', NOTE_LIMIT);
    if (text) return text;
  }
  return plainText(record.annotation, NOTE_LIMIT);
}

/** Look up a book title from the library store (memoized per render). */
async function bookTitle(db: IDBDatabase, bookId: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(bookId);
  if (cached !== undefined) return cached;
  const title = await new Promise<string>((resolve) => {
    try {
      const req = db.transaction('library', 'readonly').objectStore('library').get(bookId);
      req.onsuccess = () => resolve((req.result as { title?: string } | undefined)?.title || bookId);
      req.onerror = () => resolve(bookId);
    } catch {
      resolve(bookId);
    }
  });
  cache.set(bookId, title);
  return title;
}

/** "Cited in: …" line for a cite — citing locations resolved to titles + kinds. */
async function citedInNote(record: HyperciteRecord, db: IDBDatabase, titleCache: Map<string, string>): Promise<string> {
  const citedIN = Array.isArray(record.citedIN) ? record.citedIN : [];
  if (citedIN.length === 0) return 'Not cited anywhere yet';
  const parts: string[] = [];
  for (const citation of citedIN.slice(0, 3)) {
    try {
      const meta = parseCitedInLink(citation, record.hyperciteId);
      const title = meta.bookID ? await bookTitle(db, meta.bookID, titleCache) : '?';
      const kind = meta.isFootnoteURL ? ' (footnote)' : meta.isHyperlightURL ? ' (annotation)' : '';
      parts.push(`${title}${kind}`);
    } catch {
      parts.push('?');
    }
  }
  const more = citedIN.length > 3 ? ` +${citedIN.length - 3} more` : '';
  return `Cited in: ${parts.join(', ')}${more}`;
}

/** Pure HTML assembly over precomputed rows — unit-tested directly. */
export function buildHyperlightsTabHtml(entries: DisplayEntry[]): string {
  if (entries.length === 0) {
    return '<p class="toc-hyperlights-empty">No highlights yet.</p>';
  }
  const ghostCount = entries.filter((e) => e.ghosted).length;
  const countLine = `${entries.length} hyperlighted${ghostCount ? ` · ${ghostCount} ghosted` : ''}`;

  const rows = entries.map((entry) => {
    const id = DOMPurify.sanitize(entry.id, { ALLOWED_TAGS: [] });
    const text = plainText(entry.text, TEXT_LIMIT) || '(empty)';
    const note = plainText(entry.note, NOTE_LIMIT);
    // Visual kind-coding with the real annotation styles: highlights render
    // inside a <mark> (user-highlight aqua), cites inside a <u> (the hypercite
    // gradient underline) — styled by tocContainer.css, text pre-sanitized.
    const marked = entry.kind === 'hypercite' ? `<u>${text}</u>` : `<mark>${text}</mark>`;
    return `
      <a href="#${id}" class="toc-hyperlight-entry" data-highlight-id="${id}" data-kind="${entry.kind}" data-ghost="${entry.ghosted ? 'true' : 'false'}">
        <blockquote class="toc-hyperlight-text">… ${marked} …${entry.ghosted ? ' 👻' : ''}</blockquote>
        ${note ? `<span class="toc-hyperlight-note">${note}</span>` : ''}
      </a>`;
  }).join('');

  return `<p class="toc-hyperlights-count">${countLine}</p>${rows}`;
}

/** Resolve the mixed annotation list into renderable rows (async bits here). */
export async function buildDisplayEntries(annotations: OwnedAnnotation[], db: IDBDatabase): Promise<DisplayEntry[]> {
  const highlightRecords = annotations
    .filter((a): a is Extract<OwnedAnnotation, { kind: 'highlight' }> => a.kind === 'highlight')
    .map((a) => a.record);
  const { ghosts } = await partitionGhosts(highlightRecords, db);
  const ghostHighlightIds = new Set(ghosts.map((g) => g.hyperlight_id));

  const titleCache = new Map<string, string>();
  const entries: DisplayEntry[] = [];
  for (const annotation of annotations) {
    if (annotation.kind === 'highlight') {
      entries.push({
        id: annotation.record.hyperlight_id,
        kind: 'highlight',
        text: annotation.record.highlightedText ?? '',
        note: annotationSnippet(annotation.record),
        ghosted: ghostHighlightIds.has(annotation.record.hyperlight_id),
      });
    } else {
      entries.push({
        id: annotation.record.hyperciteId,
        kind: 'hypercite',
        text: annotation.record.hypercitedText ?? '',
        note: await citedInNote(annotation.record, db, titleCache),
        ghosted: isHyperciteGhosted(annotation.record),
      });
    }
  }
  return entries;
}

/** Fetch + render the user's hyperlighted list into the TOC scroller. */
export async function renderHyperlightsTab(scroller: HTMLElement, bookId: string): Promise<void> {
  const rawAuth = getAuthContextSync() || await getAuthContext();
  const auth: AuthIdentity = { user: rawAuth?.user ?? null, userId: rawAuth?.userId ?? null };
  const db = await openDatabase();
  const annotations = await getOwnedAnnotationsForBook(bookId, auth, db);
  const entries = await buildDisplayEntries(annotations, db);
  scroller.innerHTML = buildHyperlightsTabHtml(entries);
}
