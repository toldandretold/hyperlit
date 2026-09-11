/**
 * authorList — the ONE author-list vocabulary for the frontend.
 *
 * Conventions (mirrored server-side in app/Support/AuthorList.php):
 *   - Flat author strings (library.author, canonical_source.author, LLM metadata)
 *     hold the FULL list joined with "; ".
 *   - BibTeX author fields hold the full list joined with " and " (the BibTeX
 *     standard). Corporate names there must be brace-protected: {UN and Friends}.
 *   - Parsers tolerate both: split on ";" when present, otherwise on " and ".
 *     Splitting on ";" first protects corporate names containing " and "
 *     ("Institute for War and Peace Reporting") inside semicolon-joined lists.
 *   - A raw UUID author means an anonymous creator: it is ATOMIC — never split,
 *     never surname-extracted, passed through bibtex joins untouched so the
 *     anonymisation round-trip (buildBibtexEntry → formatBibtexToCitation) holds.
 *
 * Display rules:
 *   - In-text (APA-ish): 1 → "Munger"; 2 → "Munger & Bakker"; 3+ → "Munger et al."
 *   - Reference list: ≤ REFERENCE_LIST_MAX listed in full ("A, B & C");
 *     more → first REFERENCE_LIST_HEAD + ", et al." (Chicago 17th bibliography rule).
 *
 * Pure functions, no DOM, no state.
 */

/** List-all ceiling for reference-list rendering (Chicago 17th: up to ten). */
export const REFERENCE_LIST_MAX = 10;
/** Names shown before ", et al." when the list exceeds REFERENCE_LIST_MAX. */
export const REFERENCE_LIST_HEAD = 7;

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/** True when the author field is a raw user UUID (anonymous creator sentinel). */
export function isUuidAuthor(raw: string): boolean {
  return UUID_RE.test(raw);
}

/** Values that are already display-resolved anonymity labels — never reformatted. */
function isAnonLabel(raw: string): boolean {
  return raw === 'Anon' || raw === 'Anon (me)';
}

/** Strip ONE outer protective brace level for display: "{WHO}" → "WHO". */
export function stripOuterBraces(name: string): string {
  const m = (name ?? '').trim().match(/^\{([^{}]*)\}$/);
  return m ? m[1]!.trim() : (name ?? '').trim();
}

/**
 * Split a flat author string into individual names.
 * Brace-wrapped segments ({World Health Organization}) are atomic and KEEP
 * their braces (the atomicity marker) — bibtex re-joins need them, and
 * surnameOf/display strip them at the point of use.
 */
export function splitAuthors(raw: string): string[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  if (isUuidAuthor(trimmed) || isAnonLabel(trimmed)) return [trimmed];

  // Protect brace groups so neither separator can split inside them.
  const protectedGroups: string[] = [];
  const masked = trimmed.replace(/\{[^{}]*\}/g, (group) => {
    protectedGroups.push(group);
    return `\u0000${protectedGroups.length - 1}\u0000`;
  });

  const parts = masked.includes(';')
    ? masked.split(/\s*;\s*/)
    : masked.split(/\s+and\s+/i);

  return parts
    .map((part) =>
      part
        .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => protectedGroups[Number(i)]!)
        .trim(),
    )
    .filter((name) => name.length > 0);
}

/** Lowercase surname particles kept attached to the family name in-text. */
const SURNAME_PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'ten', 'ter', 'de', 'du', 'da', 'das', 'dos',
  'del', 'della', 'di', 'la', 'le', 'al', 'el', 'bin', 'ibn',
]);

/**
 * Extract the family name for in-text use.
 * "Munger, Kevin" → "Munger"; "Kevin Munger" → "Munger";
 * "Ludwig van Beethoven" → "van Beethoven" (particles kept); mononyms → themselves.
 * Known limit: an unbraced corporate name in word form yields its last word —
 * brace it ({Open Science Collaboration}) to keep it whole.
 */
export function surnameOf(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  if (isUuidAuthor(trimmed) || isAnonLabel(trimmed)) return trimmed;

  const braced = trimmed.match(/^\{([^{}]*)\}$/);
  if (braced) return braced[1]!.trim();

  const commaIdx = trimmed.indexOf(',');
  if (commaIdx > 0) return trimmed.slice(0, commaIdx).trim();

  const words = trimmed.split(/\s+/);
  let start = words.length - 1;
  while (start > 0 && SURNAME_PARTICLES.has(words[start - 1]!.toLowerCase())) {
    start--;
  }
  return words.slice(start).join(' ');
}

/**
 * In-text author segment (APA-ish): the part before the year in "(Munger et al. 2026)".
 * UUID → "Anon"; empty → "Unknown".
 */
export function formatInTextAuthors(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'Unknown';
  if (isUuidAuthor(trimmed)) return 'Anon';

  const authors = splitAuthors(trimmed);
  if (authors.length === 0) return 'Unknown';
  if (authors.length === 1) return surnameOf(authors[0]!) || 'Unknown';
  if (authors.length === 2) return `${surnameOf(authors[0]!)} & ${surnameOf(authors[1]!)}`;
  return `${surnameOf(authors[0]!)} et al.`;
}

/**
 * Reference-list author string: full names, "A, B & C" joining, et-al cutoff
 * past REFERENCE_LIST_MAX. UUID / "Anon" / "Anon (me)" pass through untouched.
 */
export function formatAuthorsForReference(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || isUuidAuthor(trimmed) || isAnonLabel(trimmed)) return trimmed;

  const authors = splitAuthors(trimmed).map(stripOuterBraces);
  if (authors.length <= 1) return authors[0] ?? trimmed;
  if (authors.length > REFERENCE_LIST_MAX) {
    return `${authors.slice(0, REFERENCE_LIST_HEAD).join(', ')}, et al.`;
  }
  return `${authors.slice(0, -1).join(', ')} & ${authors[authors.length - 1]!}`;
}

/**
 * Join a flat author string into a BibTeX author field value (" and " separated).
 * UUIDs pass through untouched; an " and "-joined string with no ";" round-trips
 * unchanged.
 */
export function authorsToBibtexField(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || isUuidAuthor(trimmed) || isAnonLabel(trimmed)) return trimmed;
  const authors = splitAuthors(trimmed);
  return authors.length > 0 ? authors.join(' and ') : trimmed;
}
