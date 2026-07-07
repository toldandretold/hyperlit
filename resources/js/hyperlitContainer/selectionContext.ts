/**
 * selectionContext — builds a structured "reading context" for a text selection
 * that is about to be sent to the AI (Quick Chat / AI Archivist).
 *
 * The AI is meant to act as an INFORMED READER: it should know WHERE the selected
 * text sits (inside a highlight / footnote / AI response, how deeply nested, and
 * who authored the containing annotation) and WHAT links it contains (citations +
 * hypercites resolved to their targets). This module reads that from the live DOM
 * and IndexedDB at SELECTION time — the only moment the un-mutated Range and its
 * `<a>` anchors still exist (by submit time rangy has split/wrapped the marks).
 *
 * The server (AiBrainController) is the single place that FORMATS this into an LLM
 * preamble and remains the privacy authority — the hypercite gate here is a
 * best-effort token-saver, re-checked server-side (docs/e2ee.md, SearchService).
 */

import { openDatabase } from '../indexedDB/index';
import { parseSubBookId, buildSubBookId } from '../utilities/subBookIdHelper';
import { detectHyperciteCitation } from './detection';
import { resolveBibliographyTarget } from '../indexedDB/bibliography/index';
import { getHyperciteFromIndexedDB } from '../indexedDB/hypercites/read';
import { getLibraryObjectFromIndexedDB } from '../indexedDB/core/library';
import { getAuthContextSync, getAuthContext } from '../utilities/auth/index';
import { verbose } from '../utilities/logger';
import type { BibliographyRecord, BookId } from '../indexedDB/types';

const FILE = '/hyperlitContainer/selectionContext.ts';

/** How many innermost nesting levels we describe before collapsing the rest. */
const MAX_CHAIN_DEPTH = 4;
const MAX_LABEL_CHARS = 160;
const MAX_LINKS = 8;
const MAX_HYPERCITE_TEXT = 300;

export type SelectionContainerType = 'footnote' | 'highlight' | 'ai-response';

export interface SelectionContainerLevel {
  type: SelectionContainerType;
  /** The sub-book id this container corresponds to, when it is a sub-book. */
  subBookId?: string;
  /** The owning item id: `HL_…` for a highlight, `Fn…` for a footnote. */
  itemId?: string;
  /** Username of the annotation's author; null for anonymous / footnotes. */
  creator: string | null;
  /** True when the container is an AI Archivist response. */
  isAi: boolean;
  /** Short plain-text label: the annotation text or footnote snippet. */
  label?: string;
}

export interface SelectionCitationRef {
  referenceId: string;
  content?: string;
  title?: string;
  author?: string;
  year?: string;
}

export interface SelectionHyperciteRef {
  hyperciteId: string;
  targetBook: string;
  /** Only populated when the target book is public or owned by the user. */
  hypercitedText?: string;
  targetBookTitle?: string;
  targetBookAuthor?: string;
  visibility: 'public' | 'restricted';
}

export interface SelectionContext {
  /** Ordered ROOT → INNERMOST; capped at {@link MAX_CHAIN_DEPTH}. */
  chain: SelectionContainerLevel[];
  /** True if the real chain was deeper than the cap. */
  chainTruncated: boolean;
  /** The innermost containing annotation (convenience copy of chain's last). */
  immediateContainer?: SelectionContainerLevel;
  citations: SelectionCitationRef[];
  hypercites: SelectionHyperciteRef[];
  /**
   * A math-clean rendering of the selected text — set ONLY when the selection
   * contains LaTeX (`<latex>`), where the browser's `selection.toString()` garbles/
   * duplicates KaTeX output. Each equation is decoded to its `$…$` source so the
   * LLM gets readable math. The server prefers this over the raw selected text.
   */
  selectedText?: string;
}

// ── small helpers ─────────────────────────────────────────────────────────────

function stripToText(html: string | null | undefined): string {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/** Decode a `<latex data-math>` base64 payload to LaTeX (matches renderMathElements). */
function decodeMathB64(b64: string): string {
  try { return decodeURIComponent(escape(atob(b64))); } catch { return ''; }
}

/**
 * Plain text of a selection fragment with math made readable: each `<latex>` /
 * `<latex-block>` (KaTeX renders visible glyphs + a hidden MathML/TeX copy, which
 * `toString()` duplicates) is replaced by its decoded `$…$` / `$$…$$` source.
 */
function cleanSelectionText(fragment: DocumentFragment): string {
  const clone = fragment.cloneNode(true) as DocumentFragment;
  clone.querySelectorAll('latex, latex-block').forEach((el) => {
    const tex = decodeMathB64(el.getAttribute('data-math') || '');
    const block = el.tagName.toLowerCase() === 'latex-block';
    el.textContent = tex ? ' ' + (block ? '$$' + tex + '$$' : '$' + tex + '$') + ' ' : '';
  });
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function isFootnoteItemId(itemId: string): boolean {
  return /^Fn\d/.test(itemId) || itemId.includes('_Fn');
}

function currentUsername(): string | null {
  const auth = getAuthContextSync();
  const user = auth?.user as { name?: string; username?: string; email?: string } | null | undefined;
  return user ? (user.name || user.username || user.email || null) : null;
}

/** Parsed `raw_json` (it may be a JSON string or an already-parsed object). */
function rawMeta(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

/**
 * Read the first record from a store's index that matches a predicate.
 * Mirrors the by-id + match-on-`book` idiom in pageLoad/containerChain.ts — a bare
 * `get()` is unsafe because item ids are not globally unique across books in IDB.
 */
async function findRecord(
  store: 'hyperlights' | 'footnotes',
  indexName: string,
  itemId: string,
  match: (rec: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  try {
    const db = await openDatabase();
    const tx = db.transaction(store, 'readonly');
    const index = tx.objectStore(store).index(indexName);
    const results: Record<string, unknown>[] = await new Promise((resolve, reject) => {
      const req = index.getAll(itemId);
      req.onsuccess = () => resolve((req.result as Record<string, unknown>[]) || []);
      req.onerror = () => reject(req.error);
    });
    return results.find(match) || null;
  } catch (e) {
    verbose.content(`findRecord(${store}) failed for ${itemId}`, FILE, e);
    return null;
  }
}

// ── nesting chain ───────────────────────────────────────────────────────────

/**
 * Resolve a highlight level (a `mark.HL_…` the selection sits in, or a highlight
 * sub-book container) into its creator / AI status / label.
 */
async function resolveHighlightLevel(
  itemId: string,
  matchBook: (recBook: string) => boolean,
  subBookId?: string,
): Promise<SelectionContainerLevel> {
  const rec = await findRecord('hyperlights', 'hyperlight_id', itemId, (r) => matchBook(String(r.book)));
  const creator = rec ? ((rec.creator as string | null) ?? null) : null;
  const meta = rawMeta(rec?.raw_json);
  const isAi = creator === 'AIarchivist' || meta.brain_query === true;
  const label = rec ? truncate(stripToText(rec.annotation as string | undefined), MAX_LABEL_CHARS) : undefined;
  return {
    type: isAi ? 'ai-response' : 'highlight',
    itemId,
    subBookId,
    creator,
    isAi,
    label: label || undefined,
  };
}

/** Resolve a footnote sub-book level into its label (footnotes have no author). */
async function resolveFootnoteLevel(
  itemId: string,
  matchBook: (recBook: string) => boolean,
  subBookId?: string,
): Promise<SelectionContainerLevel> {
  const rec = await findRecord('footnotes', 'footnoteId', itemId, (r) => matchBook(String(r.book)));
  const label = rec ? truncate(stripToText(rec.content as string | undefined), MAX_LABEL_CHARS) : undefined;
  return { type: 'footnote', itemId, subBookId, creator: null, isAi: false, label: label || undefined };
}

/**
 * Walk from the selection anchor up to `.main-content`, collecting the nesting
 * chain innermost-first. Each `mark.HL_…` ancestor is a highlight level; each
 * `[data-book-id]` sub-book boundary is a highlight/footnote/ai-response level
 * (its owning item id is encoded in the sub-book id).
 */
async function buildChain(startEl: Element | null): Promise<SelectionContainerLevel[]> {
  const levels: SelectionContainerLevel[] = [];
  const seen = new Set<string>();

  let el: Element | null = startEl;
  while (el && !el.classList?.contains('main-content')) {
    // Highlight the selection physically sits inside (highlighted text in a book).
    if (el.tagName === 'MARK') {
      const hlClasses = Array.from(el.classList).filter((c) => c.startsWith('HL_'));
      const enclosingBook = el.closest('[data-book-id]') as HTMLElement | null;
      const bookId = enclosingBook?.dataset?.bookId;
      for (const itemId of hlClasses) {
        if (seen.has(itemId)) continue;
        seen.add(itemId);
        levels.push(await resolveHighlightLevel(itemId, (recBook) => !bookId || recBook === bookId));
      }
    }

    // Sub-book container: the selection is inside an annotation / footnote body.
    const bookId = (el as HTMLElement).dataset?.bookId;
    if (bookId && bookId.includes('/')) {
      const parsed = parseSubBookId(bookId);
      const itemId: string | null = parsed.itemId;
      if (itemId && !seen.has(itemId)) {
        seen.add(itemId);
        const matchBook = (recBook: string) => buildSubBookId(recBook, itemId) === bookId;
        levels.push(
          isFootnoteItemId(itemId)
            ? await resolveFootnoteLevel(itemId, matchBook, bookId)
            : await resolveHighlightLevel(itemId, matchBook, bookId),
        );
      }
    }

    el = el.parentElement;
  }

  return levels; // innermost-first
}

// ── in-selection links ──────────────────────────────────────────────────────

/**
 * Anchors matching `selector` that are relevant to the selection: those CONTAINED
 * in the selection (fragment descendants) AND any single anchor the selection sits
 * INSIDE (an ancestor — `cloneContents()` drops it, so we recover it with `.closest()`
 * on the range's boundary elements). This is why selecting a short citation like
 * "(2016)" — where the selection is entirely within the `<a>` — is still detected.
 */
function collectAnchors(fragment: DocumentFragment, enclosing: Element[], selector: string): Element[] {
  const set = new Set<Element>(Array.from(fragment.querySelectorAll(selector)));
  for (const el of enclosing) {
    const a = el.closest(selector);
    if (a) set.add(a);
  }
  return Array.from(set);
}

async function collectCitations(fragment: DocumentFragment, enclosing: Element[], selectionBookId: BookId): Promise<SelectionCitationRef[]> {
  const anchors = collectAnchors(fragment, enclosing, 'a.citation-ref, a[id^="Ref"]');
  const out: SelectionCitationRef[] = [];
  const seen = new Set<string>();

  for (const a of anchors) {
    const referenceId = a.id;
    if (!referenceId || seen.has(referenceId)) continue;
    seen.add(referenceId);
    if (out.length >= MAX_LINKS) break;

    const ref: SelectionCitationRef = { referenceId };
    try {
      const bib = await readBibliography(selectionBookId, referenceId);
      if (bib?.content) ref.content = truncate(stripToText(bib.content), 400);
      if (bib) {
        const target = await resolveBibliographyTarget(bib);
        const meta = target?.metadata;
        if (meta) {
          if (meta.title) ref.title = truncate(String(meta.title), 300);
          if (meta.author) ref.author = truncate(String(meta.author), 200);
          if (meta.year != null) ref.year = String(meta.year);
        }
      }
    } catch (e) {
      verbose.content(`citation resolve failed for ${referenceId}`, FILE, e);
    }
    out.push(ref);
  }
  return out;
}

/** Read a bibliography record, trying the selection book then its foundation. */
async function readBibliography(selectionBookId: BookId, referenceId: string): Promise<BibliographyRecord | null> {
  const db = await openDatabase();
  const tryKey = (book: string): Promise<BibliographyRecord | null> =>
    new Promise((resolve) => {
      const tx = db.transaction('bibliography', 'readonly');
      const req = tx.objectStore('bibliography').get([book, referenceId]);
      req.onsuccess = () => resolve((req.result as BibliographyRecord) ?? null);
      req.onerror = () => resolve(null);
    });

  let rec = await tryKey(String(selectionBookId));
  if (!rec && String(selectionBookId).includes('/')) {
    rec = await tryKey(parseSubBookId(String(selectionBookId)).foundation);
  }
  return rec;
}

async function collectHypercites(fragment: DocumentFragment, enclosing: Element[]): Promise<SelectionHyperciteRef[]> {
  const anchors = collectAnchors(fragment, enclosing, 'a[href*="#hypercite_"]');
  const out: SelectionHyperciteRef[] = [];
  const seen = new Set<string>();
  const username = currentUsername();

  for (const a of anchors) {
    const detected = detectHyperciteCitation(a);
    if (!detected) continue;
    const { targetBook, targetHyperciteId } = detected as { targetBook: string; targetHyperciteId: string };
    if (!targetHyperciteId || seen.has(targetHyperciteId)) continue;
    seen.add(targetHyperciteId);
    if (out.length >= MAX_LINKS) break;

    const ref: SelectionHyperciteRef = { hyperciteId: targetHyperciteId, targetBook, visibility: 'restricted' };
    try {
      const lib = await getLibraryObjectFromIndexedDB(targetBook);
      const isPublic = lib?.visibility === 'public';
      const isOwn = !!username && lib?.creator === username;
      if (lib && (isPublic || isOwn)) {
        const hc = await getHyperciteFromIndexedDB(targetBook as BookId, targetHyperciteId);
        if (hc?.hypercitedText) ref.hypercitedText = truncate(stripToText(hc.hypercitedText), MAX_HYPERCITE_TEXT);
        if (lib.title) ref.targetBookTitle = truncate(String(lib.title), 300);
        if (lib.author) ref.targetBookAuthor = truncate(String(lib.author), 200);
        ref.visibility = 'public';
      }
    } catch (e) {
      verbose.content(`hypercite resolve failed for ${targetHyperciteId}`, FILE, e);
    }
    out.push(ref);
  }
  return out;
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Build the full {@link SelectionContext} for a live selection Range. Must run
 * BEFORE the brain highlight is created (so its mark can't pollute the chain).
 *
 * @param range           the live selection Range (un-mutated DOM)
 * @param selectionBookId the book the selection lives in (may be a sub-book id)
 */
export async function buildSelectionContext(range: Range, selectionBookId: BookId): Promise<SelectionContext> {
  // Ensure auth is warm so the hypercite privacy gate can read the username.
  if (!getAuthContextSync()) {
    try { await getAuthContext(); } catch { /* best-effort */ }
  }

  // Snapshot the selected fragment synchronously — it holds the `<a>` anchors.
  let fragment: DocumentFragment;
  try {
    fragment = range.cloneContents();
  } catch {
    fragment = document.createDocumentFragment();
  }

  const toEl = (n: Node | null | undefined): Element | null =>
    !n ? null : n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element);
  const startEl = toEl(range.commonAncestorContainer);
  // Boundary elements the selection touches — used to recover a citation/hypercite
  // anchor the selection sits INSIDE (an ancestor that cloneContents() drops).
  const enclosing = [
    toEl(range.commonAncestorContainer),
    toEl(range.startContainer),
    toEl(range.endContainer),
  ].filter((e): e is Element => e !== null);

  const [rawChain, citations, hypercites] = await Promise.all([
    buildChain(startEl),
    collectCitations(fragment, enclosing, selectionBookId),
    collectHypercites(fragment, enclosing),
  ]);

  // rawChain is innermost-first; cap to the innermost MAX_CHAIN_DEPTH levels.
  const chainTruncated = rawChain.length > MAX_CHAIN_DEPTH;
  const capped = chainTruncated ? rawChain.slice(0, MAX_CHAIN_DEPTH) : rawChain;
  const immediateContainer = capped[0];
  const chain = capped.slice().reverse(); // root → inner for the server

  // Only override the selected text when it actually contains math — otherwise the
  // raw browser selection is already fine (and avoids any normalization surprises).
  const hasMath = fragment.querySelector('latex, latex-block') !== null;
  const selectedText = hasMath ? cleanSelectionText(fragment) : undefined;

  const ctx: SelectionContext = { chain, chainTruncated, immediateContainer, citations, hypercites, selectedText };
  verbose.content(
    `SelectionContext: ${chain.length} levels${chainTruncated ? '+' : ''}, ` +
      `${citations.length} citations, ${hypercites.length} hypercites`,
    FILE,
  );
  return ctx;
}
