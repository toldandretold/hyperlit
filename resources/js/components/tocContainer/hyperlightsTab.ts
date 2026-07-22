/**
 * hyperlightsTab — the TOC container's second tab: the current user's
 * highlights for the open book (logged-in OR anonymous — ownership is the
 * identity test in myHighlights/list), as clickable previews in CURRENT
 * document order (the same order the hyperlit container's ↑↓ arrows walk, so
 * this list IS the arrow sequence). Ghosts (underlying text deleted) are
 * interleaved at their last-known position, dimmed with 👻.
 *
 * Clicking an entry is handled by tocContainer/index.ts's delegated handler:
 * close the TOC → navigateAndOpenHighlight (hyperlitContainer/highlightNav).
 */

import DOMPurify from 'dompurify';
import type { HyperlightRecord } from '../../indexedDB/types';
import { getAuthContextSync, getAuthContext } from '../../utilities/auth/index';
import { getOwnedHighlightsForBook, type AuthIdentity } from '../../hyperlights/myHighlights/list';
import { partitionGhosts } from '../../hyperlights/myHighlights/ghost';
import { openDatabase } from '../../indexedDB/core/connection';

const TEXT_LIMIT = 120;
const NOTE_LIMIT = 80;

/** Sanitize to plain text and truncate WITHOUT an ellipsis marker. */
function plainText(html: string | null | undefined, limit: number): string {
  const text = DOMPurify.sanitize(String(html ?? ''), { ALLOWED_TAGS: [] }).trim();
  return text.length > limit ? text.slice(0, limit).trimEnd() : text;
}

/**
 * The annotation snippet for a record. Annotations LIVE IN THE SUB-BOOK
 * (book/HL_id nodes) — `record.annotation` is legacy and usually empty for new
 * highlights. The record carries `preview_nodes` (cached sub-book snippets):
 * use the first non-empty one; fall back to the legacy field.
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

/** Pure HTML assembly — unit-tested directly. `records` arrive in document order. */
export function buildHyperlightsTabHtml(records: HyperlightRecord[], ghostIds: Set<string>): string {
  if (records.length === 0) {
    return '<p class="toc-hyperlights-empty">No highlights yet.</p>';
  }
  const ghostCount = records.filter((r) => ghostIds.has(r.hyperlight_id)).length;
  const countLine = `${records.length} hyperlight${records.length === 1 ? '' : 's'}${ghostCount ? ` · ${ghostCount} ghosted` : ''}`;

  const entries = records.map((record) => {
    const id = DOMPurify.sanitize(record.hyperlight_id, { ALLOWED_TAGS: [] });
    const ghosted = ghostIds.has(record.hyperlight_id);
    const text = plainText(record.highlightedText, TEXT_LIMIT) || '(empty highlight)';
    const note = annotationSnippet(record);
    return `
      <a href="#${id}" class="toc-hyperlight-entry" data-highlight-id="${id}" data-ghost="${ghosted ? 'true' : 'false'}">
        <blockquote class="toc-hyperlight-text">… ${text} …${ghosted ? ' 👻' : ''}</blockquote>
        ${note ? `<span class="toc-hyperlight-note">${note}</span>` : ''}
      </a>`;
  }).join('');

  return `<p class="toc-hyperlights-count">${countLine}</p>${entries}`;
}

/** Fetch + render the current user's highlights into the TOC scroller. */
export async function renderHyperlightsTab(scroller: HTMLElement, bookId: string): Promise<void> {
  const rawAuth = getAuthContextSync() || await getAuthContext();
  const auth: AuthIdentity = { user: rawAuth?.user ?? null, userId: rawAuth?.userId ?? null };
  const db = await openDatabase();
  const ordered = await getOwnedHighlightsForBook(bookId, auth, db);
  const { ghosts } = await partitionGhosts(ordered, db);
  const ghostIds = new Set(ghosts.map((g) => g.hyperlight_id));
  scroller.innerHTML = buildHyperlightsTabHtml(ordered, ghostIds);
}
