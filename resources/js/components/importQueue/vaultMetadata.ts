// Vault metadata: read what a dropped folder already SAYS about its notes —
// each note's YAML front matter and the folder's .bib file(s) — so the library
// record is born with the right author / year / DOI / licence instead of a
// filename for a title.
//
// It also extracts the IDENTITY hints a note carries (the `hyperlit:` URL and
// `book:` id a Hyperlit export writes, a DOI, and the hypercite links in its
// body), which the batch uploader sends to POST /api/import-batches/resolve to
// find notes that are ALREADY books in Hyperlit (see vaultResolve.ts).
//
// Pure logic — no DOM, no network. The YAML reader is a deliberate subset:
// `key: value` scalars and `key:` + `- item` lists (plus inline `[a, b]`),
// which is everything Hyperlit's exporter, Obsidian's property editor and
// Zotero-style templates write. Anything else is ignored, never thrown on.
//
// The server strips the same block from the body (MarkdownProcessor) — keep
// the "is this really front matter" rule here in step with
// App\Services\DocumentImport\FrontMatter.

import { parseBibtexFields } from '../../utilities/bibtexProcessor';
import { splitAuthors } from '../../utilities/authorList';

export type FrontMatterValue = string | string[];

export interface FrontMatter {
  /** Keys lowercased. Empty when the note has no front-matter block. */
  fields: Record<string, FrontMatterValue>;
  /** The note with the front-matter block removed. */
  body: string;
  hasBlock: boolean;
}

export interface BibEntry {
  /** Entry type, lowercased (`article`, `book`, ...). */
  type: string;
  key: string;
  /** The entry's source text, `@type{key, ... }`. */
  raw: string;
  /** Fields keyed by lowercased name. */
  fields: Record<string, string>;
}

/** What a note says about WHICH work it is — sent to the resolve endpoint. */
export interface VaultIdentity {
  /** The Hyperlit book id a newer export writes as `book:`. */
  book?: string;
  /** The `hyperlit:` front-matter URL (or the .bib entry's url as a fallback). */
  hyperlitUrl?: string;
  doi?: string;
  /** First path segment of every `…/{segment}#hypercite_…` link in the body. */
  hyperciteTargets: string[];
}

/** The import fields derived for one note. Mirrors POST /import-file. */
export interface VaultNoteMetadata {
  title?: string;
  author?: string;
  year?: string;
  url?: string;
  publisher?: string;
  journal?: string;
  type?: string;
  language?: string;
  note?: string;
  bibtex?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  booktitle?: string;
  chapter?: string;
  editor?: string;
  school?: string;
  doi?: string;
  license?: string;
  license_url?: string;
}

/* ── YAML front matter ──────────────────────────────────────────────────── */

const KEY_LINE = /^([A-Za-z_][\w .-]*?)\s*:(?:\s+(.*))?$/;
const LIST_ITEM = /^\s*-\s+(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map(unquote).filter((item) => item !== '');
}

/**
 * Split a note into its front-matter fields and its body.
 *
 * A block only counts when it opens on the very first line with `---`, closes
 * with a `---` (or `...`) line, holds at least one `key:` line, and every
 * other line is a list item, an indented continuation, a comment or blank. A
 * document that merely STARTS with a horizontal rule fails that test and is
 * returned untouched.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const none: FrontMatter = { fields: {}, body: text, hasBlock: false };
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return none;

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === '---' || line === '...') {
      close = i;
      break;
    }
  }
  if (close < 0) return none;

  const fields: Record<string, FrontMatterValue> = {};
  let listKey: string | null = null;
  let sawKey = false;

  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const item = LIST_ITEM.exec(line);
    if (item && listKey) {
      const list = fields[listKey];
      const value = unquote(item[1] ?? '');
      if (Array.isArray(list) && value !== '') list.push(value);
      continue;
    }

    // An indented line that isn't a list item is a continuation / nested map —
    // legal YAML we don't read. Skip it without disqualifying the block.
    if (/^\s/.test(line)) continue;

    const key = KEY_LINE.exec(line);
    if (!key) return none; // prose between two rules — not front matter

    sawKey = true;
    const name = (key[1] ?? '').trim().toLowerCase();
    const rawValue = (key[2] ?? '').trim();
    if (rawValue === '') {
      fields[name] = [];
      listKey = name;
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      fields[name] = parseInlineList(rawValue);
      listKey = null;
    } else {
      fields[name] = unquote(rawValue);
      listKey = null;
    }
  }

  if (!sawKey) return none;

  // A `key:` with nothing under it is an empty value, not an empty list.
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value) && value.length === 0) delete fields[name];
  }

  const body = lines.slice(close + 1).join('\n').replace(/^\s*\n/, '');
  return { fields, body, hasBlock: true };
}

function scalar(fields: Record<string, FrontMatterValue>, ...names: string[]): string {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length === 1 && value[0]?.trim()) return value[0].trim();
  }
  return '';
}

function list(fields: Record<string, FrontMatterValue>, ...names: string[]): string[] {
  for (const name of names) {
    const value = fields[name];
    if (Array.isArray(value) && value.length) return value.map((v) => v.trim()).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
  }
  return [];
}

/* ── .bib files ─────────────────────────────────────────────────────────── */

/**
 * Split a multi-entry .bib file into its entries. Brace-matched from each
 * top-level `@type{`, so nested braces in a title or abstract never end an
 * entry early. `@comment` / `@string` / `@preamble` blocks are skipped.
 */
export function parseBibFile(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const opener = /@([A-Za-z]+)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(text)) !== null) {
    const type = (match[1] ?? '').toLowerCase();
    const start = match.index;
    let depth = 1;
    let i = opener.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth !== 0) break; // unterminated tail — keep what parsed cleanly
    opener.lastIndex = i;

    if (type === 'comment' || type === 'string' || type === 'preamble') continue;

    const raw = text.slice(start, i);
    const key = /@[A-Za-z]+\s*\{\s*([^,\s]+)\s*,/.exec(raw)?.[1]?.trim();
    if (!key) continue;
    entries.push({ type, key, raw, fields: parseBibtexFields(raw) });
  }

  return entries;
}

function basenameOf(path: string): string {
  const clean = path.replace(/\\/g, '/');
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/**
 * Index .bib entries for pairing with files: by the basename(s) in an entry's
 * `file` field (Hyperlit writes the note filename; Zotero writes
 * `Title:path/to/file.pdf:application/pdf`, several separated by `;`) and by
 * citation key. All keys lowercased; the first entry to claim a key keeps it.
 */
export function indexBibEntries(entries: BibEntry[]): { byFile: Map<string, BibEntry>; byKey: Map<string, BibEntry> } {
  const byFile = new Map<string, BibEntry>();
  const byKey = new Map<string, BibEntry>();

  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, entry);

    const file = entry.fields.file;
    if (!file) continue;
    const candidates = new Set<string>([file]);
    for (const part of file.split(';')) {
      candidates.add(part);
      for (const piece of part.split(':')) candidates.add(piece);
    }
    for (const candidate of candidates) {
      const base = basenameOf(candidate.trim()).toLowerCase();
      if (base.includes('.') && !byFile.has(base)) byFile.set(base, entry);
    }
  }

  return { byFile, byKey };
}

/**
 * The .bib entry describing a file: matched on the entry's `file` field, then
 * the note's `citekey` front matter, then a `@citekey.md` / `citekey.md`
 * filename (the Zotero-integration naming convention).
 */
export function bibEntryFor(
  index: { byFile: Map<string, BibEntry>; byKey: Map<string, BibEntry> },
  filename: string,
  frontMatter: FrontMatter | null,
): BibEntry | null {
  const base = basenameOf(filename).toLowerCase();
  const byFile = index.byFile.get(base);
  if (byFile) return byFile;

  const citekey = frontMatter ? scalar(frontMatter.fields, 'citekey', 'citationkey', 'citation-key') : '';
  if (citekey) {
    const byKey = index.byKey.get(citekey.replace(/^@/, '').toLowerCase());
    if (byKey) return byKey;
  }

  const stem = base.replace(/\.[^.]+$/, '').replace(/^@/, '');
  return index.byKey.get(stem) ?? null;
}

/* ── Identity + metadata ────────────────────────────────────────────────── */

/** A bare DOI (`10.1234/abc`) from a DOI, a `doi:` prefix or a doi.org URL. */
export function normaliseDoi(raw: string): string {
  const doi = raw.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : '';
}

const HYPERCITE_LINK = /https?:\/\/[^\s/()<>"']+\/([^\s/#()<>"']+)#hypercite_[A-Za-z0-9_-]+/g;

/** First path segment (book id or slug) of every hypercite link in a text. */
export function hyperciteTargetsIn(text: string): string[] {
  const targets = new Set<string>();
  let match: RegExpExecArray | null;
  HYPERCITE_LINK.lastIndex = 0;
  while ((match = HYPERCITE_LINK.exec(text)) !== null) {
    if (!match[1]) continue;
    try {
      targets.add(decodeURIComponent(match[1]));
    } catch {
      targets.add(match[1]);
    }
  }
  return [...targets];
}

/**
 * True for the generated hub note of a Hyperlit export: its `hyperlit:` URL
 * names the shelf / archive PAGE (`/a/…`, `/u/…/shelf/…`), not a book. A
 * pinned overview book used as the hub keeps its own single-segment book URL
 * and is NOT a hub by this test — it imports (or resolves) like any note.
 */
export function isExportHubNote(frontMatter: FrontMatter): boolean {
  const url = scalar(frontMatter.fields, 'hyperlit');
  if (!url) return false;
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length > 1 && (segments[0] === 'a' || segments[0] === 'u');
  } catch {
    return false;
  }
}

export function identityForNote(frontMatter: FrontMatter, bib: BibEntry | null, text: string): VaultIdentity {
  const identity: VaultIdentity = { hyperciteTargets: hyperciteTargetsIn(text) };

  const book = scalar(frontMatter.fields, 'book');
  if (/^[A-Za-z0-9_-]+$/.test(book)) identity.book = book;

  const hyperlitUrl = scalar(frontMatter.fields, 'hyperlit') || bib?.fields.url || '';
  if (/^https?:\/\//i.test(hyperlitUrl)) identity.hyperlitUrl = hyperlitUrl;

  const doi = normaliseDoi(scalar(frontMatter.fields, 'doi') || bib?.fields.doi || '');
  if (doi) identity.doi = doi;

  return identity;
}

export function hasIdentityHint(identity: VaultIdentity | null): boolean {
  return !!identity && !!(identity.book || identity.hyperlitUrl || identity.doi);
}

const BIB_FIELD_TO_IMPORT: ReadonlyArray<[string, keyof VaultNoteMetadata]> = [
  ['title', 'title'], ['journal', 'journal'], ['pages', 'pages'], ['publisher', 'publisher'],
  ['school', 'school'], ['note', 'note'], ['volume', 'volume'], ['number', 'issue'],
  ['booktitle', 'booktitle'], ['chapter', 'chapter'], ['editor', 'editor'], ['langid', 'language'],
];

const FRONT_MATTER_TO_IMPORT: ReadonlyArray<[string[], keyof VaultNoteMetadata]> = [
  [['title'], 'title'], [['journal', 'container-title'], 'journal'], [['volume'], 'volume'],
  [['issue', 'number'], 'issue'], [['pages'], 'pages'], [['publisher'], 'publisher'],
  [['language', 'lang'], 'language'], [['license', 'licence'], 'license'],
  [['license_url', 'licence_url'], 'license_url'], [['booktitle'], 'booktitle'],
  [['editor'], 'editor'], [['school'], 'school'],
];

function yearIn(raw: string): string {
  return /\b(\d{4})\b/.exec(raw)?.[1] ?? '';
}

/** Strip TeX escapes / protective braces from a .bib value used as a plain field. */
function plainBibValue(raw: string): string {
  return raw.replace(/\\([&%$#_{}])/g, '$1').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The .bib entry as it should be STORED on the new book: the vault-only `file`
 * field is dropped, and for a Hyperlit export the `url` (which names the
 * ORIGINAL Hyperlit book, not the work's source) is replaced by the source URL.
 */
function storedBibtex(entry: BibEntry, isHyperlitExport: boolean, sourceUrl: string): string {
  const lines = entry.raw.split('\n').filter((line) => {
    if (/^\s*file\s*=/.test(line)) return false;
    if (isHyperlitExport && /^\s*url\s*=/.test(line)) return false;
    return true;
  });
  if (isHyperlitExport && sourceUrl) {
    const closing = lines.length - 1;
    if (closing > 0 && lines[closing]?.trim() === '}') {
      lines.splice(closing, 0, `  url = {${sourceUrl}},`);
    }
  }
  return lines.join('\n');
}

/**
 * The import fields for one note. Front matter wins per field; the .bib entry
 * fills what front matter left blank and supplies the stored `bibtex`.
 */
export function metadataForNote(frontMatter: FrontMatter, bib: BibEntry | null): VaultNoteMetadata {
  const meta: VaultNoteMetadata = {};
  const fm = frontMatter.fields;
  const isHyperlitExport = !!scalar(fm, 'hyperlit');

  for (const [names, field] of FRONT_MATTER_TO_IMPORT) {
    const value = scalar(fm, ...names);
    if (value) meta[field] = value;
  }

  const authors = list(fm, 'authors', 'author', 'creators');
  if (authors.length) meta.author = authors.join('; ');

  const year = yearIn(scalar(fm, 'year', 'date', 'issued', 'published'));
  if (year) meta.year = year;

  const doi = normaliseDoi(scalar(fm, 'doi'));
  if (doi) meta.doi = doi;

  // `source` is the work's own URL in a Hyperlit export; a plain `url` key is
  // the same thing in other vaults. `hyperlit` is identity, never the source.
  const source = scalar(fm, 'source', 'url');
  if (/^https?:\/\//i.test(source)) meta.url = source;

  if (bib) {
    for (const [bibField, field] of BIB_FIELD_TO_IMPORT) {
      const value = bib.fields[bibField];
      if (!meta[field] && value) meta[field] = plainBibValue(value);
    }
    if (!meta.author && bib.fields.author) {
      meta.author = splitAuthors(bib.fields.author).map(plainBibValue).filter(Boolean).join('; ');
    }
    if (!meta.year && bib.fields.year) {
      const bibYear = yearIn(bib.fields.year);
      if (bibYear) meta.year = bibYear;
    }
    if (!meta.doi && bib.fields.doi) {
      const bibDoi = normaliseDoi(bib.fields.doi);
      if (bibDoi) meta.doi = bibDoi;
    }
    if (!meta.url && !isHyperlitExport && /^https?:\/\//i.test(bib.fields.url ?? '')) {
      meta.url = bib.fields.url;
    }
    if (['article', 'book', 'incollection', 'phdthesis', 'misc'].includes(bib.type)) meta.type = bib.type;
    meta.bibtex = storedBibtex(bib, isHyperlitExport, meta.url ?? '');
  }

  if (!meta.url && meta.doi) meta.url = `https://doi.org/${meta.doi}`;
  if (!meta.type && (meta.author || meta.year)) {
    meta.type = meta.journal ? 'article' : meta.publisher ? 'book' : 'misc';
  }
  if (meta.title && meta.title.length > 255) meta.title = meta.title.slice(0, 255);

  return meta;
}
