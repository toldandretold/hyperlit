/**
 * Conversion-lint presentation, as pure functions (a zero-import leaf, like articleFilters.ts).
 *
 * The server ranks every lane by the structural defects its stored nodes show
 * (App\Services\Conversion\ConversionLint). This file turns that payload into what the console
 * prints: plain-word labels, a one-line summary per lane, and the worst-first ordering of the
 * article list. No DOM here, so the words and the ordering are testable on their own.
 */

export interface LintFinding {
  detector: string;
  /** The node's positional id — '' when the finding has no single node (a journal-wide one). */
  startLine: string;
  excerpt: string;
  key: string;
  /** Not in the snapshot: this reconvert introduced it. */
  is_new: boolean;
  /** A human looked and said it is real — it is in the lane's note and rides the case bundle. */
  confirmed: boolean;
}

/** What a human can say about a finding; null withdraws the verdict. */
export type LintVerdict = 'real' | 'false_alarm' | null;

export interface BookLint {
  score: number;
  counts: Record<string, number>;
  /** Capped by the server; `findings_total` is the real number. */
  findings: LintFinding[];
  findings_total: number;
  new: number;
  confirmed: number;
  /** Judged false alarms: counted nowhere above, listed so the verdict can be undone. */
  dismissed: Array<Omit<LintFinding, 'is_new' | 'confirmed'>>;
}

export interface LintCompare {
  taken_at: string;
  taken_by: string | null;
  books: number;
  compared: number;
  /** Books whose content has changed since the snapshot — how much of the journal this is about. */
  changed: number;
  /** Books in the snapshot with no content right now: still queued behind a reconvert. */
  waiting: number;
  detectors: Record<string, [number, number]>;
  gone: number;
  new_total: number;
  new_books: number;
}

/** Just enough of a lane / article for the ranking. */
export interface LintableLane {
  book: string;
  is_version: boolean;
}

export interface LintableArticle {
  lanes: LintableLane[];
}

/**
 * Detector → the words the console shows. Ordered worst first (the server's weights), which is
 * also the order a summary lists them in. An unknown detector still renders, under its raw key —
 * a new one added server-side must not silently vanish from the page.
 */
export const DETECTOR_LABELS: Record<string, { label: string; hint: string }> = {
  body_footnote_twin: {
    label: 'footnote text in the body',
    hint: 'A body paragraph that opens with a note number and carries that footnote\'s own text — the note was left in the body as well as (or instead of) being linked.',
  },
  fragment_blockquote: {
    label: 'false blockquote',
    hint: 'A blockquote that starts lower-case right after a paragraph that stopped mid-sentence — text split at a page break and wrapped as a quotation.',
  },
  split_sentence: {
    label: 'split sentence',
    hint: 'A paragraph that starts lower-case right after one that stopped mid-sentence — one paragraph cut in two, usually at a page break.',
  },
  orphan_definition: {
    label: 'footnote nobody points to',
    hint: 'A footnote definition with no marker in the text — the marker was lost.',
  },
  missing_definition: {
    label: 'marker with no footnote',
    hint: 'A footnote marker in the text whose definition is missing.',
  },
  raw_marker: {
    label: 'unconverted marker',
    hint: 'A raw footnote marker such as [^7] left in the text.',
  },
  long_heading: {
    label: 'very long heading',
    hint: 'A sub-heading over 160 characters — usually a paragraph promoted to a heading.',
  },
  glued_heading_digit: {
    label: 'heading ends in a digit',
    hint: 'A heading like "Introduction1" — a footnote marker that was not converted.',
  },
  colon_heading: {
    label: 'heading ends in a colon',
    hint: 'A heading ending in ":" — usually a list lead-in promoted to a heading.',
  },
  chrome_leak: {
    label: 'page header/footer in the text',
    hint: 'A short string repeated across this journal\'s articles — a running header or footer glued into the text.',
  },
};

const DETECTOR_ORDER = Object.keys(DETECTOR_LABELS);

export function detectorLabel(detector: string): string {
  return DETECTOR_LABELS[detector]?.label ?? detector;
}

/** Known detectors in severity order, then any the page has never heard of. */
function ordered(detectors: string[]): string[] {
  const rank = (d: string): number => {
    const i = DETECTOR_ORDER.indexOf(d);
    return i === -1 ? DETECTOR_ORDER.length : i;
  };
  return [...detectors].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** "false blockquote ×2, footnote nobody points to ×1" — worst kind first. */
export function summarize(counts: Record<string, number>): string {
  return ordered(Object.keys(counts).filter((d) => (counts[d] ?? 0) > 0))
    .map((d) => `${detectorLabel(d)} ×${counts[d] ?? 0}`)
    .join(', ');
}

/**
 * The lint an ARTICLE is judged by: its promoted lane's, because that is what readers get. A
 * losing sibling's problems are not the article's — they are why it lost. With no promoted lane
 * linted (nothing promoted yet, or it is still converting) the worst lane stands in.
 */
export function articleLint(
  article: LintableArticle,
  lint: ReadonlyMap<string, BookLint>,
): BookLint | null {
  const promoted = article.lanes.find((l) => l.is_version && lint.has(l.book));
  if (promoted) return lint.get(promoted.book) ?? null;

  let worst: BookLint | null = null;
  for (const lane of article.lanes) {
    const found = lint.get(lane.book);
    if (found && (!worst || found.score > worst.score)) worst = found;
  }
  return worst;
}

/**
 * Articles with something to look at, worst first. Findings a reconvert INTRODUCED outrank any
 * score: one new problem in a clean article is the regression the comparison exists to catch,
 * and it must not sit below an article that has merely always been messy. Ties keep the list's
 * existing order (most-cited first), so the sort is stable on purpose.
 */
export function worstFirst<T extends LintableArticle>(
  articles: T[],
  lint: ReadonlyMap<string, BookLint>,
): T[] {
  return articles
    .map((article, index) => ({ article, index, found: articleLint(article, lint) }))
    .filter((row) => row.found !== null && row.found.score > 0)
    .sort((a, b) => (b.found!.new - a.found!.new)
      || (b.found!.score - a.found!.score)
      || (a.index - b.index))
    .map((row) => row.article);
}

/** Only the articles a reconvert made worse. */
export function withNewFindings<T extends LintableArticle>(
  articles: T[],
  lint: ReadonlyMap<string, BookLint>,
): T[] {
  return articles.filter((a) => a.lanes.some((l) => (lint.get(l.book)?.new ?? 0) > 0));
}

export interface DetectorDelta {
  detector: string;
  label: string;
  before: number;
  after: number;
  direction: 'down' | 'up' | 'same';
}

/** Per-detector before → after, changed ones only, regressions first. */
export function detectorDeltas(compare: LintCompare): DetectorDelta[] {
  return ordered(Object.keys(compare.detectors))
    .map((detector): DetectorDelta => {
      const [before, after] = compare.detectors[detector] ?? [0, 0];
      return {
        detector,
        label: detectorLabel(detector),
        before,
        after,
        direction: after > before ? 'up' : after < before ? 'down' : 'same',
      };
    })
    .filter((d) => d.direction !== 'same')
    .sort((a, b) => Number(b.direction === 'up') - Number(a.direction === 'up'));
}

/** Totals for the one-line summary above the article list. */
export function lintTotals(lint: ReadonlyMap<string, BookLint>): { findings: number; books: number } {
  let findings = 0;
  let books = 0;
  for (const found of lint.values()) {
    if (found.findings_total > 0) books += 1;
    findings += found.findings_total;
  }
  return { findings, books };
}
