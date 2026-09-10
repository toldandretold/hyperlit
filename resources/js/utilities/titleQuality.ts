// titleQuality — one definition of "is this string good enough to be a book's
// title", shared by everything that derives a title from a document's own text.
//
// Zero-import leaf. Two callers depend on agreeing:
//  - indexedDB/core/library.ts `syncFirstNodeToTitle`, which promotes the first
//    node's text to the title while you type, and
//  - components/sourceContainer/autoMetadata/local.ts, the source panel's wand.
// They used to disagree — the typing-time sync had no quality bar at all, so it
// would happily lock in "m" (a half-typed heading), "Introduction", or a 400-word
// first paragraph, and the wand would then refuse to touch the result.
//
// `titleIsUsable` is a verbatim port of CanonicalSourceMatcher::hasUsableTitle()
// — the SERVER gate that decides whether [check source] may search at all. Keep
// them in step; a table test pins them together.

/**
 * PHP's strlen() counts BYTES, so mirror it in UTF-8 rather than UTF-16 code
 * units — a 4-character CJK title is 12 bytes and passes the server's `< 5`
 * check, and the client must agree or it would refuse a title PHP would take.
 */
function byteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length;
  }
}

/** Mirrors DbLibraryController::upsert, which truncates titles to 15 words. */
export const TITLE_WORD_LIMIT = 15;

/**
 * Structural headings that pass the server's junk gate but are NOT titles.
 * Load-bearing, not cosmetic: hasUsableTitle() accepts any 5+ byte string
 * outside its own small regex, so an h1 of "Introduction" would sail through,
 * get searched against OpenAlex/Open Library, and can score above threshold
 * against an unrelated real work — minting a confident, plausible, WRONG
 * canonical link on a book that previously had none.
 */
const STRUCTURAL_HEADING_RE =
  /^(contents|table of contents|index|introduction|preface|foreword|abstract|summary|notes|endnotes|footnotes|bibliography|references|works cited|further reading|appendix|acknowledge?ments?|about|about the author|home|menu|navigation|skip to content|copyright|title page|chapter\s+[\w\d]+|part\s+[ivxlcdm\d]+|section\s+[\d.]+|figure\s+\d+|table\s+\d+)$/i;

/** Placeholder words that are not a title in any context. */
const PLACEHOLDER_RE = /^(untitled|new (book|document)|test|sample|draft)$/i;

export function isPlaceholderTitle(raw: string | null | undefined): boolean {
  const t = (raw ?? '').trim();
  return t === '' || PLACEHOLDER_RE.test(t);
}

/**
 * LOOKUP ELIGIBILITY — NOT permission to be a title.
 *
 * A port of CanonicalSourceMatcher::hasUsableTitle(): whether the server will
 * run a bibliographic search on this string. Its length floor and its
 * digits/repeated-character rules exist so we don't fire noise queries at
 * OpenAlex — they say nothing about whether a person may call their book this.
 *
 * Do NOT use this to decide whether a title may be SET. That conflation refused
 * to let a book be called "Aura", "Sula", "It" or "1984", and told a user their
 * own four-letter heading was "too short". Use headingIsPlausibleTitle for that.
 */
export function titleIsUsable(raw: string | null | undefined): boolean {
  const t = (raw ?? '').trim();

  if (t === '') return false;
  if (byteLength(t) < 5) return false;
  if (/^(untitled|new (book|document)|test|sample|draft)$/i.test(t)) return false;
  if (/^[\d\s]+$/.test(t)) return false;
  if (/^(.)\1+$/.test(t)) return false;

  return true;
}

/**
 * Why this text would be turned down as an AUTOMATICALLY-derived title, phrased
 * for a human — or null when it is fine.
 *
 * This bar is deliberately much lower than titleIsUsable. It only rejects things
 * that are structurally NOT a title: a placeholder, a section heading, a
 * navigation label, or a whole paragraph. Short titles, numeric titles and
 * repeated characters all pass — "It", "1984" and "mmmm" are things a person
 * can legitimately call their own book, and refusing them was wrong.
 *
 * Returning the REASON (not just a boolean) is what lets the wand say which
 * heading it turned down and why, instead of the flatly untrue "No heading
 * found".
 */
export function titleRejectionReason(text: string): string | null {
  const t = (text || '').trim();

  if (t === '') return 'it is empty';
  if (isPlaceholderTitle(t)) return 'it is a placeholder';
  if (t.length > 300) return 'it is a paragraph rather than a title';
  if (STRUCTURAL_HEADING_RE.test(t)) return "it is a section heading, not the work's title";

  // Nav chrome shouts in caps and is short ("MAIN MENU", "LOG IN"). A LONG
  // all-caps heading is a legitimate title style, so only reject short ones.
  const words = t.split(/\s+/).filter(Boolean);
  if (t === t.toUpperCase() && t !== t.toLowerCase() && words.length <= 2) {
    return 'it looks like a navigation label';
  }

  return null;
}

/**
 * May this text be used as a title we set on the user's behalf? Structural
 * check only — see titleRejectionReason. This is the bar for the typing-time
 * first-node sync and for the wand's suggestions; `titleIsUsable` is a
 * different question entirely (can the canonical lookup search it).
 */
export function headingIsPlausibleTitle(text: string): boolean {
  return titleRejectionReason(text) === null;
}

/**
 * Mirrors the server's truncation exactly — DbLibraryController::upsert does
 * `implode(' ', array_slice($words, 0, 15)) . '...'`, so the ellipsis hangs off
 * the 15th word. Applying it client-side keeps IndexedDB and Postgres holding
 * the same string (they used to disagree on any long title).
 */
export function truncateToWords(text: string, limit: number = TITLE_WORD_LIMIT): string {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(' ');
  return words.slice(0, limit).join(' ') + '...';
}
