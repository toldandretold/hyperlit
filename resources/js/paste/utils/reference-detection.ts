/**
 * Is this block a bibliography entry, or is it body prose?
 *
 * Ported from the conversion pipeline, which already answered this question
 * properly and has the fixtures to prove it:
 *   - app/Python/shared/refkeys.py                                (shape + chrome)
 *   - app/Python/digestion/bibliographyExtraction/bibliography.py (the cohort gate)
 *
 * THE GOVERNING PRINCIPLE (bibliography.py:44-47): a reference declares its shape
 * UP FRONT. Every predicate here is start-anchored. Prose that merely CONTAINS a
 * buried "(2001)" or "Smith, J." mid-sentence must not qualify. The paste engine's
 * previous predicate — "starts with a capital AND contains any four digits
 * anywhere" — accepted sentences like "The East India Company's directors faced
 * something similar in 1773 when Parliament passed the Regulating Act", which is
 * how book_1788040795553 acquired a References section built from its own body.
 *
 * THE ARCHITECTURE IS TWO LAYERS, AND THE SECOND ONE IS THE PRODUCT.
 * `isReferenceShaped` is LOOSE by design (its final rule accepts any capitalised
 * paragraph containing a year) and is only safe once something else has vouched
 * for LOCATION. That vouching is `collectReferenceRun`. Never call the loose
 * predicate on unscoped document content — use `hasReferenceStructure` there.
 * The Python side pins this same contract in a test comment at
 * tests/conversion/unit/test_bibliography.py:99-102.
 */

/** A heading-less run is believed only when it is this dense. */
const MIN_RUN_LENGTH = 3;

/** Non-matching blocks tolerated between two confirmed entries (the sandwich cap). */
const MAX_SANDWICH_GAP = 3;

/** A tolerated miss must be shorter than this — a long block is prose, not an entry. */
const MAX_MISS_LENGTH = 500;

/** Ordinal-prefixed candidates need at least this many before the density gate applies. */
const MIN_ORDINALS_FOR_DENSITY = 3;

/** Below this density, ordinal-prefixed candidates are endnotes, not a numbered bibliography. */
const MIN_ORDINAL_DENSITY = 0.5;

// ---------------------------------------------------------------------------
// LAYER 1 — article chrome (reject)
// ---------------------------------------------------------------------------

/**
 * Journal front/back-matter that sits alongside a reference list and is shaped
 * exactly like an entry: it starts with a capital and carries a year, which is
 * all the loose predicate's final rule asks for. Rejected wherever it appears,
 * INCLUDING under a real References heading — the collector walks past the end
 * of a section whenever it recognises nothing inside it.
 *
 * Port of _ARTICLE_CHROME_RE (refkeys.py:149-175). Keep the anchoring exactly:
 * `submitted|received|revised|accepted` demands a following "5 November 2018"
 * date so that a genuine entry merely OPENING with one of those words survives
 * ("Received Wisdom and Other Essays, A. Author, 1998.").
 */
const ARTICLE_CHROME_RE = new RegExp(
  '^\\s*(?:' +
    'article\\s+copyright\\b' +
    '|copyright\\s*[:©]' +
    '|©\\s*\\d{4}' +
    '|orcid(?:\\s+id)?\\s*[:.]' +
    '|(?:how\\s+)?to\\s+cite\\s+this\\s+(?:article|paper|work)\\b' +
    '|cite\\s+this\\s+(?:article|paper|work)\\s+as\\b' +
    '|published\\s+by\\s+.{0,80}?\\bon\\s+\\d{1,2}\\s+\\w+\\s+\\d{4}\\s*$' +
    '|(?:submitted|received|revised|accepted)\\s+on\\s+\\d{1,2}\\s+\\w+\\s+\\d{4}\\b' +
    '|competing\\s+interests?\\s*[:.]' +
    '|conflicts?\\s+of\\s+interest\\s*[:.]' +
    '|correspondence\\s*[:.]' +
    '|e-?mail\\s*[:.]' +
    '|received\\s*[:.].{0,60}accepted\\s*[:.]' +
    '|this\\s+is\\s+an\\s+open[- ]access\\s+article\\b' +
  ')',
  'i',
);

/** True when a block is journal front/back-matter, never a bibliography entry. */
export function isArticleChrome(text: string | null | undefined): boolean {
  return ARTICLE_CHROME_RE.test(text || '');
}

const CITE_LABEL_RE = /^\s*(?:how\s+)?to\s+cite\s+this\s+(?:article|paper|work)\b/i;

/**
 * The self-citation an article prints for itself is shaped exactly like a
 * bibliography entry, because it IS one — of this very work. Nothing in the line
 * distinguishes it; the only signal is the label paragraph above it, so this is a
 * look-behind rather than a pattern. Port of _follows_cite_label (refkeys.py:182-195).
 */
export function followsCiteLabel(el: Element | null | undefined): boolean {
  let previous = el?.previousElementSibling ?? null;
  let hops = 0;
  while (previous && hops < 2) {
    if (previous.tagName === 'P') {
      return CITE_LABEL_RE.test(normalizeText(previous.textContent));
    }
    previous = previous.previousElementSibling;
    hops += 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// LAYER 2 — shape
// ---------------------------------------------------------------------------

/** A leading "1." / "12)" enumerator, stripped before the structural test. */
const ORDINAL_PREFIX_RE = /^\s*\d{1,4}[.)]\s+/;

/**
 * "Marcuse, H." / "Ostrom, Elinor"  — surname, comma, initial or given name.
 * "Author … (2001)"                 — author-year, year within 40 chars of the start.
 * Port of _REF_STRUCTURE_RE (bibliography.py:49-52).
 */
const REF_STRUCTURE_RE =
  /^\s*[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+,\s+(?:[A-ZÀ-ÖØ-Þ]\.|[A-ZÀ-ÖØ-Þ][a-zà-ÿß])|^\s*[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+.{0,40}?\(\d{4}[a-z]?\)/;

/**
 * Numbered "[1]" / bracket-year "[2023]" / em-dash repeat-author / noble-particle
 * OPENER. Port of _REF_STRUCTURE_START_RE (bibliography.py:54-59).
 */
const REF_STRUCTURE_START_RE =
  /^\s*(?:\[\d+\]|\[\d{4}\]|[—–‒―⸺⸻-]{1,3}[.,\s]|(?:von|van|de|du|da|del|della|le|la|los|las|den|der|het|ten|ter)\s+[A-ZÀ-ÖØ-Þ])/i;

/**
 * Vancouver style: "Adger W, Barnett J, Brown K: Title. Nat Clim Change 2013, 3:112-117"
 * — surname plus dotless initials, colon before the title. Ported up from
 * refkeys.py:236-237, where it sits behind an ordinal prefix; the paste port leans
 * on the strict predicate directly, so it needs the shape at this level too.
 */
const VANCOUVER_RE = /^\s*[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+\s+[A-Z]{1,3}[,:]/;

/**
 * A surname followed by 1-3 dotless initials — "Walz A, " / "Braendle J. ".
 * Weaker than full structure: used only to tolerate a YEARLESS entry sandwiched
 * inside an otherwise solid run. Port of _MISS_AUTHOR_SHAPE_RE (bibliography.py:129).
 */
const MISS_AUTHOR_SHAPE_RE = /^\s*[A-ZÀ-ÖØ-Þ][\w'’-]+\s+[A-Z]{1,3}\b[,.]?\s/;

/**
 * STRICT: does this text carry genuine reference structure?
 *
 * This is the predicate for any context where location has NOT been vouched for
 * (no heading, arbitrary web content). It is what rejects the four phantom
 * entries from book_1788040795553 — none of them opens with "Surname," or
 * carries a "(year)" near its start.
 */
export function hasReferenceStructure(text: string | null | undefined): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;
  if (isArticleChrome(trimmed)) return false;

  if (matchesStructure(trimmed)) return true;

  // A numbered bibliography ("1. Caso, R. (2019)…") declares its shape after the
  // enumerator. The enumerator alone is never enough — a numbered prose list item
  // ("3. In 2019 we surveyed…") still fails every branch below.
  const withoutOrdinal = trimmed.replace(ORDINAL_PREFIX_RE, '');
  return withoutOrdinal !== trimmed && matchesStructure(withoutOrdinal);
}

function matchesStructure(text: string): boolean {
  if (REF_STRUCTURE_RE.test(text)) return true;
  if (REF_STRUCTURE_START_RE.test(text)) return true;
  // Vancouver needs its colon near the front, or any "Surname AB," prose opener
  // would qualify.
  return VANCOUVER_RE.test(text) && text.slice(0, 120).includes(':');
}

/**
 * LOOSE: does this text look like a bibliography entry?
 *
 * Port of is_likely_reference rules 1-5 (refkeys.py:198-261). Rule 5 — "starts
 * with a capital and contains a year" — makes this predicate unusable on its own.
 * ONLY call it on blocks already scoped to a reference section by a heading.
 */
export function isReferenceShaped(text: string | null | undefined): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;

  // Must contain a 4-digit year.
  if (!/\d{4}/.test(trimmed)) return false;

  if (isArticleChrome(trimmed)) return false;

  // 1. Numbered: "[1] Author… (year)"
  if (/^\s*\[\d+\]/.test(trimmed)) return true;

  // 1b. Ordinal-numbered, with a reference-shaped remainder.
  const withoutOrdinal = trimmed.replace(ORDINAL_PREFIX_RE, '');
  if (withoutOrdinal !== trimmed) {
    if (/^[A-ZÀ-ÖØ-Þ][a-zA-ZÀ-ÿßẞ'’-]+,\s/.test(withoutOrdinal)) return true;
    if (/^[A-ZÀ-ÖØ-Þ][\s\S]{0,60}?\(\d{4}[a-z]?\)/.test(withoutOrdinal)) return true;
    if (VANCOUVER_RE.test(withoutOrdinal) && withoutOrdinal.slice(0, 120).includes(':')) return true;
    // Lowercase-branded author: "ephemera collective. 2021. Title…"
    if (/^[a-zà-ÿ][\w'’-]*(?:\s+[\w'’-]+){0,3}[.,]\s+\(?(?:19|20)\d{2}[a-z]?\)?[.,]/.test(withoutOrdinal)) {
      return true;
    }
  }

  // 2. Bracketed year: "[2023] Author…"
  if (/^\s*\[\d{4}\]/.test(trimmed)) return true;

  // 3. Noble particle: "von Name, A. (2023)…"
  if (/^\s*(?:von|van|de|du|da|del|della|le|la|los|las|den|der|het|ten|ter)\s+[A-ZÀ-ÖØ-Þ]/i.test(trimmed)) {
    return true;
  }

  // 4. Em-dash repeat-author: "—. 2019. Title…"
  if (/^\s*[—–‒―⸺⸻-]{1,3}[.,\s]/.test(trimmed)) return true;

  // 5. THE CATCH-ALL — any capitalised opener. Safe only behind the cohort gate.
  const firstChar = trimmed.charAt(0);
  return firstChar !== firstChar.toLowerCase() && firstChar === firstChar.toUpperCase();
}

/**
 * Strict location check used when deciding whether an intervening heading is an
 * OCR artifact rather than a real section boundary: body text scatters its years
 * far from the start, a bibliography entry always has "Author. Year." near the
 * beginning. Port of the peek at bibliography.py:100-104.
 */
export function hasEarlyYear(text: string | null | undefined, window = 80): boolean {
  return /\d{4}/.test(normalizeText(text).slice(0, window));
}

// ---------------------------------------------------------------------------
// LAYER 3 — the cohort gate
// ---------------------------------------------------------------------------

export interface ReferenceRunOptions {
  /**
   * True when the caller has already scoped `blocks` to a section introduced by a
   * matched References heading. Switches the member predicate from strict
   * structure to the loose shape test, and stops a non-member from ending the run.
   */
  headingAnchored?: boolean;
  minRunLength?: number;
  maxSandwichGap?: number;
}

/**
 * Decide which of `blocks` are bibliography entries.
 *
 * `blocks` must be in DOCUMENT ORDER. For the heading-anchored path pass only the
 * blocks inside the section; for the heading-less path pass every candidate block
 * in the document — the run is grown backwards from the tail, which is where a
 * bibliography lives.
 */
export function collectReferenceRun(
  blocks: readonly Element[],
  options: ReferenceRunOptions = {},
): Element[] {
  const {
    headingAnchored = false,
    minRunLength = MIN_RUN_LENGTH,
    maxSandwichGap = MAX_SANDWICH_GAP,
  } = options;

  const isMember = headingAnchored ? isReferenceShaped : hasReferenceStructure;

  const accepted: Element[] = [];
  let pending: Element[] = [];

  /** A block that fails the member test but may still be an entry if the run resumes. */
  const isTolerableMiss = (el: Element, text: string): boolean =>
    pending.length < maxSandwichGap &&
    text.length > 0 &&
    text.length < MAX_MISS_LENGTH &&
    !isArticleChrome(text) &&
    !followsCiteLabel(el) &&
    (MISS_AUTHOR_SHAPE_RE.test(text) || hasReferenceStructure(text));

  if (headingAnchored) {
    // The heading has vouched for location: walk forward, skipping what we do not
    // recognise rather than ending the section on it.
    for (const el of blocks) {
      const text = normalizeText(el.textContent);
      if (!text) continue;

      if (isMember(text) && !followsCiteLabel(el)) {
        accepted.push(...pending);
        pending = [];
        accepted.push(el);
      } else if (isTolerableMiss(el, text)) {
        pending.push(el);
      } else {
        pending = [];
      }
    }
  } else {
    // No heading. Grow the run backwards from the document tail and stop at the
    // first block that is neither a member nor a tolerable miss.
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const el = blocks[i];
      if (!el) continue;
      const text = normalizeText(el.textContent);
      if (!text) continue;

      if (isMember(text) && !followsCiteLabel(el)) {
        accepted.unshift(...pending);
        pending = [];
        accepted.unshift(el);
      } else if (accepted.length > 0 && isTolerableMiss(el, text)) {
        pending.unshift(el);
      } else {
        break;
      }
    }

    // A short heading-less run is body prose that happened to pass, not a
    // bibliography. Every member already carries genuine structure (isMember is
    // the strict predicate here), so density is the remaining requirement.
    if (accepted.length < minRunLength) return [];
  }

  return applyOrdinalDensityGate(accepted);
}

/**
 * Entries carrying a plain "N." / "N)" enumerator are a real numbered bibliography
 * only when their numbers form a DENSE ascending run (1..16 scores 1.0). Scattered
 * ordinals (42, 64, 68, 81 scores 0.1) are numbered ENDNOTES whose openers happen
 * to look author-shaped; keeping them mints phantom references AND steals their
 * text from the footnote system. Applies only to the ordinal-prefixed subset.
 * Port of bibliography.py:165-184.
 */
function applyOrdinalDensityGate(accepted: readonly Element[]): Element[] {
  const ordinals: Array<{ el: Element; n: number }> = [];
  for (const el of accepted) {
    const match = normalizeText(el.textContent).match(/^\s*(\d{1,4})[.)]\s/);
    if (match?.[1]) ordinals.push({ el, n: parseInt(match[1], 10) });
  }

  if (ordinals.length < MIN_ORDINALS_FOR_DENSITY) return [...accepted];

  const nums = ordinals.map((o) => o.n).sort((a, b) => a - b);
  const span = (nums[nums.length - 1] ?? 0) - (nums[0] ?? 0) + 1;
  const density = span > 0 ? new Set(nums).size / span : 0;
  if (span > 0 && density >= MIN_ORDINAL_DENSITY) return [...accepted];

  const dropped = new Set(ordinals.map((o) => o.el));
  return accepted.filter((el) => !dropped.has(el));
}

function normalizeText(text: string | null | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}
