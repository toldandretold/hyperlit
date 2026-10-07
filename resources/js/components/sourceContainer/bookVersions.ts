// "Versions / Translations" — the source container's rail of other visible
// editions of this work, from GET /api/book-versions/{book}: the translation
// family (translated_from lineage) plus other library versions of the same
// canonical_source. Hidden when there is nothing but the book itself.
//
// Labelling is the safety mechanism for machine translations: every MT entry
// names the model and its commissioner, upgraded to "co-translated by" once
// the owner has actually edited the copy (human_reviewed), and a muted note
// says when the original has been edited since the translation was made.
//
// Mirrors bookTranslation.ts's lifecycle: initBookVersions returns a handle
// destroyed by SourceContainerManager when the panel closes or rebuilds.

import { verbose } from '../../utilities/logger';
import { LANGUAGES } from '../../hyperlights/translateSelection';

const SECTION_ID = 'book-versions-section';

interface VersionEntry {
  book: string;
  title: string | null;
  language: string | null;
  creator: string | null;
  created_at: string | null;
  kind: 'original' | 'translation' | 'canonical_version';
  is_current: boolean;
  translation: {
    target: string | null;
    model: string | null;
    human_reviewed: boolean;
    original_edited_since: boolean;
  } | null;
}

export interface BookVersionsHandle {
  destroy(): void;
}

/**
 * The app's translate glyph (a→文), stroke currentColor so it follows the
 * link color. One line with no inter-tag whitespace: stray text nodes inside
 * the svg would leak into the link's textContent.
 */
const TRANSLATE_ICON_SVG = '<svg class="book-version-translate-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>';

/** 'zh-Hans' → '简体中文'; an unknown code shows as itself. */
function languageLabel(code: string | null | undefined): string | null {
  if (!code) return null;

  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

/**
 * 'zh-Hans' → 'Simplified Chinese · 简体中文' (English name + endonym), so a
 * reader who doesn't read the target script still knows what the link is.
 */
function languageDisplay(code: string | null | undefined): string | null {
  const endonym = languageLabel(code);
  if (!code) return endonym;
  let exonym: string | null = null;
  try {
    exonym = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? null;
  } catch {
    // Unknown code — the endonym (or the code itself) will do.
  }
  if (exonym && endonym && exonym !== endonym && exonym !== code) return `${exonym} · ${endonym}`;

  return endonym ?? exonym;
}

/** 'accounts/fireworks/models/kimi-k3' → 'Kimi K3'; unknown ids keep their last segment. */
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  if (model.includes('kimi-k3')) return 'Kimi K3';
  const tail = model.split('/').pop() ?? model;

  return tail.length > 0 ? tail : null;
}

/**
 * One compact list row for an OTHER edition (the current book is never
 * listed), built with textContent — creators are user data. The LINK is the
 * edition's identity (its language, or its title for a same-work version);
 * the full citation lives one click away on the book itself.
 */
function renderEntry(entry: VersionEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'book-version-entry';

  const name = document.createElement('a');
  name.className = 'book-version-title';
  name.href = `/${encodeURIComponent(entry.book)}`;

  const meta = document.createElement('p');
  meta.className = 'book-version-meta';
  const lang = languageDisplay(entry.language);
  if (entry.kind === 'translation' && entry.translation) {
    name.textContent = lang ?? 'Translation';
    const model = modelLabel(entry.translation.model);
    meta.textContent = entry.translation.human_reviewed
      ? `machine translation${model ? ` (${model})` : ''}, co-translated by ${entry.creator ?? 'a reader'}`
      : `machine translation${model ? ` (${model})` : ''}, commissioned by ${entry.creator ?? 'a reader'}`;
  } else if (entry.kind === 'original') {
    name.textContent = lang ? `Original · ${lang}` : 'Original';
    meta.textContent = '';
  } else {
    // Same work, same language — the title is what distinguishes versions.
    name.textContent = entry.title || entry.book;
    meta.textContent = ['another version', entry.creator ? `by ${entry.creator}` : null].filter(Boolean).join(' · ');
  }
  li.appendChild(name);
  if (meta.textContent) li.appendChild(meta);

  if (entry.translation?.original_edited_since) {
    const stale = document.createElement('p');
    stale.className = 'book-version-stale';
    stale.textContent = 'The original has been edited since this translation was made.';
    li.appendChild(stale);
  }

  return li;
}

/**
 * The MT provenance line under the CITATION: on a translation copy, the
 * citation (and any Citation Verified badge) describe the ORIGINAL work, so
 * the disclosure belongs where the citation is read, not only in the rail.
 */
function renderProvenance(noteEl: HTMLElement, current: VersionEntry, original: VersionEntry | undefined): void {
  const t = current.translation!;
  const model = modelLabel(t.model);
  const lang = languageLabel(current.language);
  const who = t.human_reviewed
    ? `co-translated by ${current.creator ?? 'a reader'}`
    : `commissioned by ${current.creator ?? 'a reader'}`;
  noteEl.textContent = `Machine translation${model ? ` (${model})` : ''}${lang ? ` into ${lang}` : ''}, ${who}. `
    + 'The citation and any verification describe the original work';
  if (original) {
    noteEl.append(' — ');
    const a = document.createElement('a');
    a.href = `/${encodeURIComponent(original.book)}`;
    a.textContent = 'read the original';
    noteEl.appendChild(a);
  }
  noteEl.append('.');
  noteEl.hidden = false;
}

export function initBookVersions(container: HTMLElement, bookId: string): BookVersionsHandle | null {
  const section = container.querySelector<HTMLElement>(`#${SECTION_ID}`);
  const heading = section?.querySelector<HTMLElement>('.book-versions-heading');
  const list = section?.querySelector<HTMLUListElement>('.book-versions-list');
  if (!section || !heading || !list) return null;

  // Sub-book overlays share the source card; versions are of the root book.
  const rootBook = String(bookId).split('/')[0] ?? String(bookId);
  let destroyed = false;

  void (async () => {
    let versions: VersionEntry[] = [];
    try {
      const resp = await fetch(`/api/book-versions/${encodeURIComponent(rootBook)}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok && Array.isArray(data.versions)) versions = data.versions;
    } catch {
      return; // leave the section hidden — a rail is never worth an error
    }
    if (destroyed) return;

    // The provenance disclosure is independent of the rail: it renders even
    // when the original is invisible to this viewer (rail empty, note not).
    const current = versions.find((v) => v.is_current);
    const noteEl = container.querySelector<HTMLElement>('.citation-translation-note');
    if (noteEl && current?.kind === 'translation' && current.translation) {
      renderProvenance(noteEl, current, versions.find((v) => v.kind === 'original' && !v.is_current));
    }

    // Only OTHER editions are listed — the reader is already on this book.
    const others = versions.filter((v) => !v.is_current);
    if (others.length === 0) return;

    const hasTranslations = others.some((v) => v.kind === 'translation');
    const hasOtherVersions = others.some((v) => v.kind !== 'translation');
    // The translate glyph rides the HEADING whenever translations are listed.
    heading.innerHTML = hasTranslations ? TRANSLATE_ICON_SVG : '';
    heading.append(hasTranslations && hasOtherVersions
      ? 'Versions & Translations'
      : hasTranslations ? 'Translations' : 'Versions');

    list.textContent = '';
    for (const entry of others) list.appendChild(renderEntry(entry));
    section.hidden = false;
    verbose.init('book versions rail rendered', '/components/sourceContainer/bookVersions');
  })();

  return {
    destroy(): void {
      destroyed = true;
    },
  };
}
