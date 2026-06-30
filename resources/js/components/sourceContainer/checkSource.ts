// Source status — the panel's provenance display + the verify action. Renders:
//   • category pills: "Citation Linked" (linked to a canonical) and "Official source text"
//     (the book IS its canonical's auto_version_book), and
//   • a "Librarian" attribution: a human uploader → /u/{username}, an automated process →
//     the provider (OpenAlex / Open Library / …) → its page for the work, else anonymous;
//   • for an owner of an UNLINKED book, the [check source] button that runs the verify flow.
// The reusable lookup/verify engine lives in resources/js/sourceVerify. Mirrors aiReview/index.ts;
// peer calls route through `self` (SourceContainerManager).
import { book } from '../../app';
import { openDatabase } from '../../indexedDB/index';
import { lookupSource } from '../../sourceVerify/lookup';
import { verifySource } from '../../sourceVerify/verify';
import { renderSourceMatchPrompt } from '../../sourceVerify/prompt';
import { getRecord } from './helpers';
import type { LibraryRecord } from '../../indexedDB/types';

const NON_LINKING_METHODS = new Set(['user_rejected', 'no_match_v1']);

const LINK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const BOOK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';

const PILL_BASE = 'font-size: 12px; color: var(--hyperlit-aqua); display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--hyperlit-aqua) 35%, transparent); border-radius: 999px;';
const DETAIL_STYLE = 'font-size: 12px; color: var(--color-text-secondary); margin-top: 8px; line-height: 1.5;';
const INLINE_LINK = 'color: var(--hyperlit-aqua); text-decoration: underline;';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Category predicates ───────────────────────────────────────────────────────

export function isCitationLinked(record: LibraryRecord | null | undefined): boolean {
  if (!record) return false;
  return !!record.canonical_source_id && !NON_LINKING_METHODS.has(record.canonical_match_method || '');
}

export function isOfficialSourceText(record: LibraryRecord | null | undefined): boolean {
  if (!record || !isCitationLinked(record)) return false;
  const autoVersion = record.canonical?.auto_version_book;
  if (autoVersion && autoVersion === record.book) return true;
  // Fallbacks for records fetched without the canonical join.
  return record.conversion_method === 'pdf_ocr_auto_raw' || record.creator === 'canonicalizer_v1';
}

// ── Provider / link derivation ────────────────────────────────────────────────

/** A link to the work on the external database (canonical identifiers preferred, then library's). */
export function externalSourceLink(record: LibraryRecord): { label: string; url: string } | null {
  const c = record.canonical;
  const openalex = c?.openalex_id || record.openalex_id;
  const olKey = c?.open_library_key || record.open_library_key;
  const doi = c?.doi || record.doi;
  const oaUrl = c?.oa_url || record.oa_url;
  const sourceUrl = c?.source_url;

  if (openalex) return { label: 'OpenAlex', url: `https://openalex.org/${openalex}` };
  if (olKey) return { label: 'Open Library', url: `https://openlibrary.org${olKey}` };
  if (doi) return { label: 'DOI', url: `https://doi.org/${doi}` };
  if (oaUrl) return { label: 'source', url: oaUrl };
  if (sourceUrl) return { label: 'source', url: sourceUrl };
  return null;
}

function providerFromFoundation(foundation?: string | null): string | null {
  switch (foundation) {
    case 'openalex_ingest': return 'OpenAlex';
    case 'open_library_ingest': return 'Open Library';
    case 'semantic_scholar_ingest': return 'Semantic Scholar';
    default: return null;
  }
}

// ── HTML builders ─────────────────────────────────────────────────────────────

interface CategoryDef { cat: string; svg: string; label: string; detail: string; }

/** The verification categories that apply to this record, each with its expandable explanation. */
function categoryDefs(record: LibraryRecord): CategoryDef[] {
  const defs: CategoryDef[] = [];
  const link = externalSourceLink(record);
  const viewLink = link
    ? ` <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" style="${INLINE_LINK}">view on ${escapeHtml(link.label)} ↗</a>`
    : '';

  if (isCitationLinked(record) && !(isOfficialSourceText(record))) {
    defs.push({
      cat: 'linked',
      svg: LINK_SVG,
      label: 'Citation Verified',
      detail: `The citation details for this source have been verified against an external bibliographic database. The text content has not been verified. ${viewLink}`,
    });
  }
  if (isOfficialSourceText(record)) {
    defs.push({
      cat: 'official',
      svg: BOOK_SVG,
      label: 'Source Text Verified',
      detail: `This source text was converted from an official version held in an external database.${viewLink}`,
    });
  }
  return defs;
}

/** Pills (each expands its explanation on click) + the hidden explanation panels. */
function categoriesHtml(record: LibraryRecord): string {
  const defs = categoryDefs(record);
  if (!defs.length) return '';

  const pills = defs.map((d) =>
    `<span class="source-cat-pill" data-cat="${d.cat}" role="button" tabindex="0" aria-expanded="false" title="What does this mean?" style="${PILL_BASE} cursor: pointer;">${d.svg} ${escapeHtml(d.label)}</span>`,
  ).join('');

  const details = defs.map((d) =>
    `<div class="source-cat-detail" data-cat="${d.cat}" style="display: none; ${DETAIL_STYLE}">${d.detail}</div>`,
  ).join('');

  return `<div id="source-categories" style="display: flex; flex-wrap: wrap; gap: 8px;">${pills}</div>${details}`;
}

/**
 * Delegated click/keyboard wiring for the category pills: clicking a pill expands its explanation
 * (closing any other). Attached to the persistent #check-source-section, so re-renders are covered.
 */
export function wireSourceStatus(section: HTMLElement): void {
  if ((section as any)._sourceStatusWired) return;
  (section as any)._sourceStatusWired = true;

  const toggle = (pill: HTMLElement) => {
    const cat = pill.getAttribute('data-cat');
    const detail = section.querySelector(`.source-cat-detail[data-cat="${cat}"]`) as HTMLElement | null;
    if (!detail) return;
    const willOpen = detail.style.display === 'none';
    section.querySelectorAll('.source-cat-detail').forEach((d: any) => { d.style.display = 'none'; });
    section.querySelectorAll('.source-cat-pill').forEach((p: any) => p.setAttribute('aria-expanded', 'false'));
    if (willOpen) {
      detail.style.display = 'block';
      pill.setAttribute('aria-expanded', 'true');
    }
  };

  const onActivate = (e: any) => {
    const pill = e.target?.closest?.('.source-cat-pill');
    if (!pill || !section.contains(pill)) return;
    e.preventDefault();
    e.stopPropagation();
    toggle(pill);
  };

  section.addEventListener('click', onActivate);
  section.addEventListener('keydown', (e: any) => {
    if (e.key === 'Enter' || e.key === ' ') onActivate(e);
  });
}

function checkButtonHtml(): string {
  return `
    <div id="source-categories">
      <button type="button" id="check-source-btn" style="padding: 6px 12px; font-size: 12px; color: var(--hyperlit-aqua); border: 1px solid color-mix(in srgb, var(--hyperlit-aqua) 40%, transparent); background: transparent; border-radius: 4px; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px;">
        ${LINK_SVG} Check source
      </button>
    </div>`;
}

export function librarianHtml(record: LibraryRecord): string {
  const creator = record.creator || null;
  let inner: string;

  if (creator === 'canonicalizer_v1') {
    const link = externalSourceLink(record);
    const provider = link?.label || providerFromFoundation(record.canonical?.foundation_source || record.foundation_source) || 'an automated process';
    inner = link
      ? `Added automatically from <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" style="color: var(--hyperlit-aqua); text-decoration: underline;">${escapeHtml(provider)}</a>`
      : `Added automatically from ${escapeHtml(provider)}`;
  } else if (creator) {
    inner = `Uploaded by <a href="/u/${encodeURIComponent(creator)}" style="color: var(--hyperlit-aqua); text-decoration: underline;">${escapeHtml(creator)}</a>`;
  } else {
    inner = 'Uploaded anonymously';
  }

  return `
    <h3>Librarian</h3>
    <p style="font-size: 12px; color: var(--color-text-secondary); margin: 0;">${inner}</p>`;
}

/** The inner content of the source-status section (pills/button + Librarian) — also used on re-render. */
function sourceStatusInnerHtml(record: LibraryRecord, canEdit: boolean): string {
  let top = '';
  if (isCitationLinked(record)) {
    top = categoriesHtml(record);
  } else if (canEdit) {
    top = checkButtonHtml();
  }
  return `${top}<div id="source-librarian" style="margin-top: 12px; padding-top: 10px">${librarianHtml(record)}</div>`;
}

/** The #check-source-section block injected by buildSourceHtml. */
export function sourceStatusSectionHtml(
  record: LibraryRecord | null,
  canEdit: boolean,
  accessDenied: boolean,
): string {
  if (!record || accessDenied) return '';
  return `<div id="check-source-section" style="margin-top: 12px; padding-top: 2px">${sourceStatusInnerHtml(record, !!canEdit)}</div>`;
}

// ── The verify action (button → lookup → confirm → verify → re-render) ─────────

function setMessage(section: HTMLElement, message: string): void {
  let note = section.querySelector('#check-source-note') as HTMLElement | null;
  if (!note) {
    note = document.createElement('p');
    note.id = 'check-source-note';
    note.style.cssText = 'font-size: 12px; color: var(--color-label); margin: 8px 0 0 0;';
    section.appendChild(note);
  }
  note.textContent = message;
}

function resetButton(section: HTMLElement): void {
  const btn = section.querySelector('#check-source-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `${LINK_SVG} Check source`;
  }
}

export async function handleCheckSource(self: any): Promise<void> {
  const section = self.container.querySelector('#check-source-section') as HTMLElement | null;
  if (!section) return;

  const btn = section.querySelector('#check-source-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
  }
  section.querySelector('#check-source-note')?.remove();
  section.querySelector('#check-source-prompt')?.remove();

  const result = await lookupSource(book);

  if (!result.success) {
    setMessage(section, result.message || 'Lookup failed. Please try again.');
    resetButton(section);
    return;
  }

  // A fresh match (`candidate`) OR an existing auto-link awaiting confirmation (`current`).
  const candidate = result.candidate || result.current;
  if (!candidate) {
    setMessage(section, 'No matching source found.');
    resetButton(section);
    return;
  }

  const mount = document.createElement('div');
  mount.id = 'check-source-prompt';
  section.appendChild(mount);

  renderSourceMatchPrompt(
    mount,
    candidate,
    {
      onYes: async () => {
        mount.innerHTML = '<p style="font-size: 12px; color: var(--color-label); margin: 8px 0 0 0;">Linking…</p>';
        const verified = await verifySource(book, candidate);
        if (verified.success) {
          // Re-render the section from the now-linked record (verifySource merged it into IDB).
          try {
            const db = await openDatabase();
            const record = await getRecord(db, 'library', book);
            if (record) section.innerHTML = sourceStatusInnerHtml(record, true);
          } catch {
            section.innerHTML = sourceStatusInnerHtml({ book } as LibraryRecord, true);
          }
          self.refreshCitationDisplay?.();
        } else {
          mount.remove();
          setMessage(section, verified.message || 'Could not link source.');
          resetButton(section);
        }
      },
      onNo: () => {
        mount.remove();
        resetButton(section);
      },
    },
    result.score,
  );
}
