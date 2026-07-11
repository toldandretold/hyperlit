/**
 * Plain citation (bibliography "Reference" card) — mirrors the source-container's clean pattern.
 *
 * A matched reference renders its citation via the shared bibtex/citation convention with the TITLE
 * hyperlinked to the source, followed by ONE provenance pill ("Citation verified") that expands an
 * explanation (with a "view on OpenAlex ↗" link) — exactly like sourceContainer/checkSource.ts.
 * The single action is an OWNER-only "Check source" button (lookup → pick → link a canonical); a
 * reference that points at a held Hyperlit book keeps its "Open source" button.
 *
 * Build discipline: all IDB reads happen up-front in ONE short readonly transaction (phase 1); the
 * async work (canonical resolution via fetch, per-source library reads, owner check) runs AFTER that
 * tx has closed (phase 2), so awaiting never auto-commits a transaction other reads still depend on.
 */

import { book } from '../../../app';
import { openDatabase } from '../../../indexedDB/index';
import { resolveBibliographyTarget } from '../../../indexedDB/bibliography/index';
import type { BibliographyRecord } from '../../../indexedDB/types';
import { log } from '../../../utilities/logger';
import { formatMetadataToCitation } from '../../../utilities/bibtexProcessor';
import { wireSourceStatus } from '../../../components/sourceContainer/checkSource';
import { privateLockIcon, deletedTrashIcon, MUTED_BTN_STYLE, BTN_SPINNER_HTML, lockButtonEl, enableButtonEl } from '../sourceAccessButton';

const AQUA_BTN_STYLE = 'display: inline-flex; align-items: center; gap: 0.5em; padding: 0.5em 1em; background: var(--hyperlit-aqua, #4EACAE); color: var(--hyperlit-black, #221F20); text-decoration: none; border-radius: 4px;';
const AQUA_LINK_STYLE = 'color: var(--hyperlit-aqua); text-decoration: underline;';
const PILL_STYLE = 'font-size: 12px; color: var(--hyperlit-aqua); display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--hyperlit-aqua) 35%, transparent); border-radius: 999px;';
const CHECK_SOURCE_BTN_STYLE = 'padding: 6px 12px; font-size: 12px; color: var(--hyperlit-aqua); border: 1px solid color-mix(in srgb, var(--hyperlit-aqua) 40%, transparent); background: transparent; border-radius: 4px; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px;';

const LINK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const SEARCH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

function escapeHtml(s: any): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Render a citation from canonical metadata (or a lookup candidate) with the TITLE linked to `url`. */
function metaToCitation(meta: any, url: string | null): string {
  return formatMetadataToCitation({
    title: meta?.title, author: meta?.author, year: meta?.year, journal: meta?.journal,
    publisher: meta?.publisher, doi: meta?.doi, type: meta?.type, url: url || undefined,
  });
}

/**
 * The TITLE link — the readable source. Prefers the actual full-text (OA url / PDF) over the DOI
 * landing page, then the OpenAlex/Open Library record; for a WebFetch stub, the original scraped URL.
 */
function citationExternalLink(result: any, meta: any): string | null {
  if (result?.source_external_url) return String(result.source_external_url);
  if (meta?.oa_url) return String(meta.oa_url);
  if (meta?.pdf_url) return String(meta.pdf_url);
  if (meta?.doi) return `https://doi.org/${meta.doi}`;
  if (meta?.openalex_id) return `https://openalex.org/${meta.openalex_id}`;
  if (meta?.open_library_key) return `https://openlibrary.org${meta.open_library_key}`;
  if (meta?.source_url) return String(meta.source_url);
  return null;
}

/** The provenance record ("view on OpenAlex ↗") shown inside the pill's explanation. */
function provenanceLink(meta: any): { label: string; url: string } | null {
  if (meta?.openalex_id) return { label: 'OpenAlex', url: `https://openalex.org/${meta.openalex_id}` };
  if (meta?.open_library_key) return { label: 'Open Library', url: `https://openlibrary.org${meta.open_library_key}` };
  if (meta?.doi) return { label: 'DOI', url: `https://doi.org/${meta.doi}` };
  return null;
}

interface LoadedRef { refId: string; result: BibliographyRecord | null; }

/** Phase 1: read every referenced bibliography record in ONE short readonly transaction. */
async function readBibliographyRecords(database: any, lookupBook: any, ids: string[]): Promise<LoadedRef[]> {
  const tx = database.transaction('bibliography', 'readonly');
  const store = tx.objectStore('bibliography');
  return Promise.all(
    ids.map(
      (refId) =>
        new Promise<LoadedRef>((resolve) => {
          const request = store.get([lookupBook, refId]);
          request.onsuccess = () => resolve({ refId, result: request.result || null });
          request.onerror = () => resolve({ refId, result: null });
        }),
    ),
  );
}

/** Read one library row from local IDB (own short tx — external cited books are usually absent). */
async function readLibraryRow(database: any, bookId: any): Promise<any> {
  return new Promise((resolve) => {
    const tx = database.transaction('library', 'readonly');
    const request = tx.objectStore('library').get(bookId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

/**
 * Build citation content section(s). Matched refs render the title-linked canonical citation + a
 * provenance pill; a ref pointing at a held Hyperlit book keeps its "Open source" button; otherwise
 * the imported text + (owner) Check source.
 * @param contentType - The citation content type object
 * @param db - Reused database connection
 */
export async function buildCitationContent(contentType: any, db: any = null) {
  try {
    const { referenceId } = contentType;
    if (!referenceId) {
      log.error('No referenceId found in contentType', 'displayCitations/plainCitation', contentType);
      return '';
    }

    const database = db || await openDatabase();
    const lookupBook = contentType.parentBookId || book;
    const ids = contentType.referenceIds || [referenceId]; // range citations like [6-8]

    // Owner-ness resolved ONCE, before any IDB tx (canUserEditBook may fetch; it is per-book cached).
    let isOwner = false;
    try {
      const { canUserEditBook }: any = await import('../../../utilities/auth/index');
      isOwner = !!(await canUserEditBook(lookupBook));
    } catch {
      isOwner = false;
    }

    // Phase 1: read all records synchronously in one readonly tx.
    const loaded = await readBibliographyRecords(database, lookupBook, ids);

    // Phase 2: resolve + build each section (async work runs AFTER the read tx closed).
    let sections = '';
    for (const { refId, result } of loaded) {
      const record: BibliographyRecord | null = result;
      sections += await buildOneSection(database, lookupBook, refId, record, isOwner);
    }
    return sections;
  } catch (error) {
    log.error('Error building citation content', 'displayCitations/plainCitation', error);
    const referenceId = contentType?.referenceId || 'unknown';
    return `
      <div class="citations-section" data-content-id="${escapeHtml(referenceId)}">
        <h3>Reference</h3>
        <div class="error">Error loading reference</div>
        <hr style="margin: 2em 0; opacity: 0.5;">
      </div>`;
  }
}

/** Build a single reference card (the async, post-transaction work for one refId). */
async function buildOneSection(
  database: any,
  lookupBook: any,
  refId: string,
  result: BibliographyRecord | null,
  isOwner: boolean,
): Promise<string> {
  if (!result || !result.content) {
    return `
      <div class="citations-section" data-content-id="${escapeHtml(refId)}">
        <h3>Reference</h3>
        <div class="error">Reference not found: ${escapeHtml(refId)}</div>
        <hr style="margin: 2em 0; opacity: 0.5;">
      </div>`;
  }

  const sourceHasNodes = result.source_has_nodes == null || !!result.source_has_nodes;
  const isWebStub = !!result.source_is_web_stub;
  const hasCanonicalMatch = !!result.canonical_source_id;
  const rejected = result.reference_match_method === 'user_rejected';
  // Auto matches count as matched immediately (like the source panel); a rejected match reverts to
  // "unmatched" so the owner can re-check.
  const isMatched = hasCanonicalMatch && !rejected;

  // Resolve the canonical (metadata + best held Hyperlit version) when there's a match.
  let canonicalResolvedBook: any = null;
  let meta: any = null;
  if (hasCanonicalMatch) {
    try {
      const resolved: any = await resolveBibliographyTarget(result);
      if (resolved?.type === 'library' && resolved.book) { canonicalResolvedBook = resolved.book; meta = resolved.metadata || null; }
      else if (resolved?.type === 'citation-card') { meta = resolved.metadata || null; }
    } catch (e) {
      log.error('displayCitations: canonical resolve failed', 'displayCitations/plainCitation', e);
    }
  }

  let displayContent = result.content;
  let leadingIcon = '';
  let navHtml = '';
  let statusHtml = '';

  if (isMatched && meta) {
    // Matched → title-linked canonical citation (internal Hyperlit version if we hold one, else the
    // best readable external URL) + a provenance pill.
    const titleUrl = canonicalResolvedBook ? `/${encodeURIComponent(canonicalResolvedBook)}` : citationExternalLink(result, meta);
    displayContent = metaToCitation(meta, titleUrl);
    statusHtml = sourceStatusHtml({
      refId, lookupBook, canonicalId: result.canonical_source_id, isOwner,
      matched: true, method: result.reference_match_method || null, provenance: provenanceLink(meta),
    });
  } else if (result.source_id && !isWebStub && sourceHasNodes && !hasCanonicalMatch) {
    // Legacy: a reference pointing directly at a cited Hyperlit book (visibility resolved post-open).
    const legacy = await buildLegacyOpenButton(database, result);
    navHtml = legacy.html;
    leadingIcon = legacy.leadingIcon;
    statusHtml = isOwner ? sourceStatusHtml({ refId, lookupBook, canonicalId: '', isOwner, matched: false }) : '';
  } else {
    // Unmatched (incl. rejected / web-only / no source) → imported text + (owner) Check source.
    statusHtml = sourceStatusHtml({ refId, lookupBook, canonicalId: result.canonical_source_id ?? '', isOwner, matched: false });
  }

  return `
    <div class="citations-section" data-content-id="${escapeHtml(refId)}" data-reference-id="${escapeHtml(refId)}">
      <h3 style="margin-bottom: 0.5em;">Reference</h3>
      <blockquote style="margin: 0; padding: 0.5em 0; font-style: normal;">${leadingIcon}${displayContent}</blockquote>
      ${statusHtml}
      ${navHtml}
      <hr style="margin: 2em 0; opacity: 0.5;">
    </div>`;
}

// ── Source-status block (pill + owner Check source), mirroring the source panel ─────────────────

/** The "Check source" button — an OWNER/creator-only action (readers never see it). */
function checkSourceButtonHtml(): string {
  return `<button type="button" class="ref-check-source" style="${CHECK_SOURCE_BTN_STYLE}">${SEARCH_SVG} Check source</button>`;
}

/** The inner of a `.ref-source-status` block — pill + explanation + owner Check source + a mount. */
function sourceStatusInner(o: { isOwner: boolean; matched: boolean; method?: string | null; provenance?: { label: string; url: string } | null }): string {
  const check = o.isOwner ? checkSourceButtonHtml() : '';
  if (!o.matched) return `${check}<div class="ref-source-mount"></div>`;

  const explain = o.method === 'user_verified'
    ? "Confirmed by the book's author."
    : 'Matched automatically against a bibliographic database.';
  const prov = o.provenance
    ? ` <a href="${escapeHtml(o.provenance.url)}" target="_blank" rel="noopener" style="${AQUA_LINK_STYLE}">view on ${escapeHtml(o.provenance.label)} ↗</a>`
    : '';
  const pill = `<span class="source-cat-pill" data-cat="verified" role="button" tabindex="0" aria-expanded="false" title="What does this mean?" style="${PILL_STYLE} cursor: pointer;">${LINK_SVG} Citation verified</span>`;
  const detail = `<div class="source-cat-detail" data-cat="verified" style="display: none; font-size: 12px; color: var(--color-text-secondary); margin-top: 8px; line-height: 1.5;">${explain}${prov}</div>`;
  return `<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">${pill}${check}</div>${detail}<div class="ref-source-mount"></div>`;
}

/** The `.ref-source-status` wrapper carrying the ids the post-open wiring needs. */
function sourceStatusHtml(o: {
  refId: string; lookupBook: any; canonicalId: any; isOwner: boolean;
  matched: boolean; method?: string | null; provenance?: { label: string; url: string } | null;
}): string {
  return `<div class="ref-source-status" data-ref-id="${escapeHtml(o.refId)}" data-book="${escapeHtml(o.lookupBook)}" data-canonical="${escapeHtml(o.canonicalId ?? '')}" data-owner="${o.isOwner ? '1' : '0'}" style="margin-top: 1em;">${sourceStatusInner(o)}</div>`;
}

/** The legacy "Open source" button for a source_id-linked library version (visibility resolved post-open). */
async function buildLegacyOpenButton(database: any, result: any): Promise<{ html: string; leadingIcon: string }> {
  const libraryRecord: any = await readLibraryRow(database, result.source_id);

  const isDeleted = libraryRecord && libraryRecord.visibility === 'deleted';
  const isPrivate = libraryRecord && libraryRecord.visibility === 'private';
  const isUnknown = !libraryRecord; // external book — visibility resolved post-open

  const targetUrl = `/${encodeURIComponent(result.source_id)}`;
  let buttonText = 'Open source';
  let buttonStyle = AQUA_BTN_STYLE;
  let buttonAttrs = '';
  let buttonSuffix = '';
  let leadingIcon = '';

  if (isDeleted) {
    buttonText = 'Source deleted';
    buttonStyle += ' opacity: 0.6; cursor: not-allowed; pointer-events: none;';
    buttonAttrs = `data-deleted="true"`;
    leadingIcon = deletedTrashIcon();
  } else if (isPrivate || isUnknown) {
    buttonStyle += MUTED_BTN_STYLE;
    buttonSuffix = BTN_SPINNER_HTML;
    buttonAttrs = `data-needs-citation-check="true" data-book-id="${escapeHtml(result.source_id)}"${isPrivate ? ' data-visibility="private"' : ''}`;
  }

  const html = `
    <div class="citation-navigation" style="margin-top: 1em;">
      <a href="${targetUrl}" class="citation-source-link" ${buttonAttrs} style="${buttonStyle}">
        ${buttonText}${buttonSuffix}
        <span class="open-icon">↗</span>
      </a>
    </div>`;
  return { html, leadingIcon };
}

/**
 * Place the lock/trash icon next to the citation text (mirrors the hypercite statusIcon), NOT on the
 * button. Idempotent — won't double-insert if the resolver runs twice.
 */
function insertCitationLockIcon(btn: any, iconHtml: string) {
  const section = btn?.closest?.('.citations-section');
  if (!section || section.querySelector('.private-lock-icon, .deleted-icon')) return;
  const blockquote = section.querySelector('blockquote');
  if (blockquote) blockquote.insertAdjacentHTML('afterbegin', iconHtml);
}

/**
 * Post-open resolution for the legacy "Open source" buttons (source_id → a cited Hyperlit book whose
 * visibility isn't known at build time). Resolves deleted/private/public off the server.
 */
export async function resolveCitationButtonStatus(_contentType: any, _db: any, container: any = null) {
  try {
    const root = container
      || document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
    if (!root || !document.body.contains(root)) return;

    const btns = root.querySelectorAll('.citation-source-link[data-needs-citation-check="true"]');
    if (btns.length === 0) return;

    const { fetchLibraryFromServer }: any = await import('../../utils.js');
    const { canUserEditBook }: any = await import('../../../utilities/auth/index');

    for (const btn of btns) {
      const bookId = btn.getAttribute('data-book-id');
      btn.removeAttribute('data-needs-citation-check');

      let visibility = btn.getAttribute('data-visibility'); // 'private' hint, or null when unknown
      if (!visibility && bookId) {
        try {
          const record: any = await fetchLibraryFromServer(bookId);
          visibility = record?.visibility || 'public';
        } catch (e) {
          visibility = 'public'; // couldn't determine — leave enabled rather than guess locked
        }
      }

      if (visibility === 'deleted') {
        lockButtonEl(btn, 'Source deleted');
        insertCitationLockIcon(btn, deletedTrashIcon());
      } else if (visibility === 'private') {
        const hasAccess: any = bookId ? await canUserEditBook(bookId) : false;
        if (hasAccess) {
          enableButtonEl(btn);
        } else {
          lockButtonEl(btn, 'Source private');
          insertCitationLockIcon(btn, privateLockIcon());
        }
      } else {
        enableButtonEl(btn);
      }
    }
  } catch (error) {
    log.error('resolveCitationButtonStatus error', 'displayCitations/plainCitation', error);
  }
}

/**
 * Collapse candidates that are the same work surfaced by more than one provider. A book found on both
 * OpenAlex and Open Library carries DIFFERENT identifiers, so an identifier-only dedup still shows two
 * identical rows — hence we ALSO collapse on normalized title+year. Keeps the first (highest-ranked).
 */
function dedupeCandidateList(candidates: any[]): any[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const out: any[] = [];
  for (const c of candidates) {
    const idKey =
      (c.doi && `doi:${c.doi}`) ||
      (c.openalex_id && `oa:${c.openalex_id}`) ||
      (c.open_library_key && `ol:${c.open_library_key}`) ||
      (c.semantic_scholar_id && `ss:${c.semantic_scholar_id}`) ||
      null;
    const titleKey = `t:${String(c.title ?? '').toLowerCase().trim()}|${c.year ?? ''}`;
    if ((idKey && seenIds.has(idKey)) || seenTitles.has(titleKey)) continue;
    if (idKey) seenIds.add(idKey);
    seenTitles.add(titleKey);
    out.push(c);
  }
  return out;
}

/** After the owner links a source: swap the blockquote to the clean title-linked citation + verified pill. */
function markSectionMatched(statusEl: any, candidate: any, readableUrl: string | null, root: any): void {
  const section = statusEl.closest?.('.citations-section');
  const blockquote = section?.querySelector?.('blockquote');
  if (blockquote) blockquote.innerHTML = metaToCitation(candidate, readableUrl);
  statusEl.innerHTML = sourceStatusInner({ isOwner: true, matched: true, method: 'user_verified', provenance: provenanceLink(candidate) });
  statusEl._refCheckWired = false; // re-wire the new (re-check) button
  wireReferenceVerifyButtons(root);
}

/**
 * Post-open wiring: pill expand (reused `wireSourceStatus`) + the owner "Check source" flow
 * (lookup → dedupe → renderSourceMatchList → pick → approve → re-render to the matched state).
 * Called from citationHandler.postOpen; idempotent per status block.
 */
export function wireReferenceVerifyButtons(container: any = null): void {
  const root = container
    || document.querySelector('#hyperlit-container.open, .hyperlit-container-stacked.open');
  if (!root || !document.body.contains(root)) return;

  root.querySelectorAll('.ref-source-status').forEach((statusEl: any) => {
    wireSourceStatus(statusEl); // pill click → expand (idempotent, delegated)

    if (statusEl._refCheckWired) return;
    const check = statusEl.querySelector('.ref-check-source') as HTMLButtonElement | null;
    if (!check) return;
    statusEl._refCheckWired = true;

    const bookId = statusEl.getAttribute('data-book');
    const refId = statusEl.getAttribute('data-ref-id');
    const mount = statusEl.querySelector('.ref-source-mount') as HTMLElement | null;
    const note = (msg: string) => { if (mount) mount.innerHTML = `<p style="font-size: 12px; color: var(--color-label); margin: 8px 0 0;">${escapeHtml(msg)}</p>`; };

    check.addEventListener('click', async () => {
      if (!mount) return;
      check.disabled = true;
      note('Searching…');
      try {
        const { lookupReference, approveReference, candidateExternalUrl }: any = await import('../../../sourceVerify/referenceVerify');
        const { renderSourceMatchList }: any = await import('../../../sourceVerify/prompt');
        const result = await lookupReference(bookId, refId);
        const shortlist = dedupeCandidateList([result.candidate || result.current, ...(result.alternates ?? [])].filter(Boolean));
        if (!shortlist.length) { note('No matching source found.'); check.disabled = false; return; }
        const scores = shortlist.map((c: any, i: number) => (typeof c.match_score === 'number' ? c.match_score : i === 0 ? result.score : null));
        renderSourceMatchList(mount, shortlist, {
          onSelect: async (candidate: any) => {
            note('Linking…');
            const res = await approveReference(bookId, refId, candidate);
            if (res?.success) {
              markSectionMatched(statusEl, candidate, candidateExternalUrl(candidate), root);
            } else {
              note(res?.message || 'Could not link source.');
              check.disabled = false;
            }
          },
          onNone: () => { mount.innerHTML = ''; check.disabled = false; },
        }, scores);
      } catch (e) {
        log.error('reference lookup failed', 'displayCitations/plainCitation', e);
        note('Lookup failed.');
        check.disabled = false;
      }
    });
  });
}
