/**
 * The conversion-lint half of /maintainer/journal-import: "search this journal for problems".
 *
 * Owns the lint payload (`GET …/lint`), the summary + before/after strip above the article list,
 * the snapshot buttons, and the findings list in the detail strip. main.ts owns the article list
 * and the reader pane, and asks this module what a lane's lint is when it draws either.
 *
 * Three things about the payload shape decide how this is written:
 *
 *  - It arrives in INSTALMENTS. A cold journal is linted across several requests (the server
 *    stops at a time budget and reports `pending`), so `refreshLint` keeps asking until nothing
 *    is pending, painting what it has each time. The comparison and the page-furniture findings
 *    only exist once it is complete — the server withholds them from a partial answer.
 *
 *  - It goes STALE on its own. A reconvert_all drains for hours, and each book that comes back
 *    changes the numbers; main.ts calls `refreshLint` from its drain poll so the before/after
 *    strip moves while you watch rather than only at the end.
 *
 *  - Journal console only. The shelf console shares main.ts but has none of this markup, so
 *    every entry point checks for its container and is a no-op without it.
 */

import { log } from '../../utilities/logger';
import { drainResponse } from '../../utilities/drainResponse';
import { csrfHeaders, postJson } from '../shared/http';
import {
  DETECTOR_LABELS, detectorDeltas, detectorLabel, lintTotals, summarize,
  type BookLint, type LintCompare, type LintFinding, type LintVerdict,
} from './lintView';

interface LintPayload {
  pending: number;
  total: number;
  books: Record<string, BookLint>;
  compare: LintCompare | null;
  /** How many verdicts this journal holds — any at all makes the cases download worth offering. */
  reviewed: number;
}

export interface LintPanelOptions {
  /** `/api/maintainer/journal-import/{slug}` — the journal-scoped base. */
  apiBase: () => string;
  /** The lint changed: redraw the article list and the selected lane's strip. */
  onChange: () => void;
  /** A finding was confirmed or un-confirmed: the lane's note (and case flag) changed server-side. */
  onNoteChanged: () => void;
  /** One line of feedback in the detail strip's status area. */
  setStatus: (text: string) => void;
}

const SOURCE = 'maintainer-journal-import';

let options: LintPanelOptions | null = null;
let lint = new Map<string, BookLint>();
let compare: LintCompare | null = null;
let pending = 0;
let total = 0;
let loaded = false;
/** Bumped by every refresh, so an older instalment loop stops when a newer one starts. */
let generation = 0;
let retryTimer: number | undefined;
/** The findings list stays open or shut across lanes — it is the operator's preference, not the lane's. */
let findingsOpen = true;
let dismissedOpen = false;
let reviewed = 0;

const node = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

/** Is this the journal console (the shelf console has no lint markup)? */
function present(): boolean {
  return options !== null && node('ji-lint-bar') !== null;
}

export function lintState(): ReadonlyMap<string, BookLint> {
  return lint;
}

export function lintFor(book: string): BookLint | null {
  return lint.get(book) ?? null;
}

export function lintComparison(): LintCompare | null {
  return compare;
}

/** Everything linted, nothing outstanding — the only state a snapshot may be taken from. */
export function lintComplete(): boolean {
  return loaded && pending === 0;
}

export function initLintPanel(opts: LintPanelOptions): void {
  options = opts;
  if (!present()) return;

  node<HTMLButtonElement>('ji-lint-snapshot')?.addEventListener('click', () => {
    if (compare && !window.confirm(
      'Replace the existing snapshot with the journal as it is now?\n\n'
      + 'The current before/after comparison is discarded.',
    )) return;
    void takeSnapshot();
  });
  node<HTMLButtonElement>('ji-lint-cases')?.addEventListener('click', () => {
    if (!options) return;
    options.setStatus('building the cases archive…');
    // A plain navigation: the response is an attachment, so the page stays where it is.
    window.location.href = `${options.apiBase()}/lint/cases`;
    window.setTimeout(() => options?.setStatus(''), 6000);
  });
  node<HTMLButtonElement>('ji-lint-sample')?.addEventListener('click', () => {
    if (!options) return;
    options.setStatus('building the sample archive — this can take a minute…');
    window.location.href = `${options.apiBase()}/lint/cases?sample=1`;
    window.setTimeout(() => options?.setStatus(''), 15000);
  });
  node<HTMLButtonElement>('ji-lint-clear')?.addEventListener('click', () => { void clearSnapshot(); });
  node<HTMLButtonElement>('ji-findings-toggle')?.addEventListener('click', () => {
    findingsOpen = !findingsOpen;
    options?.onChange();
  });
}

/**
 * Load the lint, re-asking until the server has checked every lane. Safe to call at any time:
 * a newer call supersedes an older one's retry loop.
 */
export async function refreshLint(): Promise<void> {
  if (!present() || !options) return;
  const mine = ++generation;
  window.clearTimeout(retryTimer);

  let payload: LintPayload;
  try {
    const resp = await fetch(`${options.apiBase()}/lint`, {
      headers: { Accept: 'application/json' }, credentials: 'include',
    });
    if (!resp.ok) {
      await drainResponse(resp);
      log.error(`Lint fetch failed (${resp.status})`, SOURCE);
      paintSummary(`problem check failed (${resp.status})`);
      return;
    }
    payload = (await resp.json()) as LintPayload;
  } catch (e) {
    log.error('Lint fetch failed', SOURCE, e);
    return;
  }
  if (mine !== generation) return;   // superseded while in flight

  lint = new Map(Object.entries(payload.books ?? {}));
  compare = payload.compare ?? null;
  pending = payload.pending ?? 0;
  total = payload.total ?? lint.size;
  reviewed = payload.reviewed ?? 0;
  loaded = true;

  paintBar();
  options.onChange();

  if (pending > 0) {
    retryTimer = window.setTimeout(() => { void refreshLint(); }, 300);
  }
}

/**
 * Take a snapshot if the journal has none — called just before a reconvert_all, so the run it is
 * about to start always has a "before" to be compared with. Never overwrites one the operator
 * took on purpose, and silently does nothing when the lint is not complete (the server would
 * refuse a partial snapshot anyway, and a reconvert must not wait on it).
 */
export async function ensureSnapshot(): Promise<boolean> {
  if (!present() || !lintComplete() || compare) return false;
  return takeSnapshot();
}

async function takeSnapshot(): Promise<boolean> {
  if (!options) return false;
  const button = node<HTMLButtonElement>('ji-lint-snapshot');
  if (button) button.disabled = true;
  try {
    const { status, data } = await postJson<{ message?: string }>(`${options.apiBase()}/lint/snapshot`, {});
    if (status !== 200) {
      paintSummary(data.message ?? `snapshot failed (${status})`);
      return false;
    }
    await refreshLint();
    return true;
  } catch (e) {
    log.error('Lint snapshot failed', SOURCE, e);
    paintSummary('snapshot failed — refresh and retry');
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function clearSnapshot(): Promise<void> {
  if (!options) return;
  if (!window.confirm('Discard the snapshot and stop comparing?')) return;
  try {
    const headers = await csrfHeaders();
    if (!headers) throw new Error('no session token');
    await drainResponse(await fetch(`${options.apiBase()}/lint/snapshot`, {
      method: 'DELETE', credentials: 'include', headers: { ...headers, Accept: 'application/json' },
    }));
    // The "new only" filter means nothing without a snapshot; leaving it ticked would empty the list.
    const onlyNew = node<HTMLInputElement>('ji-only-new');
    if (onlyNew) onlyNew.checked = false;
    await refreshLint();
  } catch (e) {
    log.error('Lint snapshot delete failed', SOURCE, e);
  }
}

// ── The strip above the article list ───────────────────────────────────────

function paintSummary(text: string): void {
  const summary = node('ji-lint-summary');
  if (summary) summary.textContent = text;
}

function paintBar(): void {
  const bar = node('ji-lint-bar');
  if (!bar) return;
  bar.hidden = false;

  const { findings, books } = lintTotals(lint);
  if (pending > 0) {
    paintSummary(`checking for problems… ${total - pending} of ${total} lanes`);
  } else if (total === 0) {
    paintSummary('nothing imported to check yet');
  } else if (findings === 0) {
    paintSummary(`no problems found in ${total} lane${total === 1 ? '' : 's'}`);
  } else {
    paintSummary(`${findings} possible problem${findings === 1 ? '' : 's'} in ${books} of ${total} lanes`);
  }

  const snapshot = node<HTMLButtonElement>('ji-lint-snapshot');
  if (snapshot) {
    snapshot.disabled = pending > 0 || total === 0;
    snapshot.textContent = compare ? 're-snapshot' : 'snapshot';
    snapshot.title = compare
      ? 'Replace the snapshot with the journal as it is now'
      : 'Record today\'s problems, so that after a reconvert you can see what it fixed and what it broke';
  }

  const cases = node<HTMLButtonElement>('ji-lint-cases');
  if (cases) {
    cases.hidden = reviewed === 0;
    cases.textContent = `⤓ reviewed cases (${reviewed})`;
  }

  const sampleButton = node<HTMLButtonElement>('ji-lint-sample');
  if (sampleButton) sampleButton.hidden = pending > 0 || total === 0;

  paintCompare();
}

/**
 * Record a verdict on one finding, then reload: a false alarm leaves every count, and a confirmed
 * one has just been written into the lane's note server-side.
 */
async function review(book: string, finding: Pick<LintFinding, 'detector' | 'excerpt' | 'startLine'>, verdict: LintVerdict): Promise<void> {
  if (!options) return;
  try {
    const { status, data } = await postJson<{ message?: string }>(`${options.apiBase()}/lint/review`, {
      book, detector: finding.detector, excerpt: finding.excerpt, startLine: finding.startLine, verdict,
    });
    if (status !== 200) {
      options.setStatus(data.message ?? `could not save that (${status})`);
      options.onChange();   // re-enable the button that was pressed
      return;
    }
    options.setStatus(
      verdict === 'real' ? 'confirmed — added to this lane\'s note, it rides the case bundle'
        : verdict === 'false_alarm' ? 'dismissed as a false alarm — it stays dismissed after a reconvert'
          : 'verdict withdrawn',
    );
    await refreshLint();
    options.onNoteChanged();
  } catch (e) {
    log.error('Lint review failed', SOURCE, e);
    options.setStatus('could not save that — refresh and retry');
    options.onChange();
  }
}

function paintCompare(): void {
  const strip = node('ji-lint-compare');
  const body = node('ji-lint-compare-body');
  if (!strip || !body) return;

  strip.hidden = compare === null;
  if (!compare) return;

  body.textContent = '';
  const piece = (text: string, className = ''): void => {
    const span = document.createElement('span');
    span.textContent = text;
    if (className) span.className = className;
    body.appendChild(span);
  };

  const taken = new Date(compare.taken_at);
  piece(`since snapshot ${taken.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}:`,
    'ji-lint-compare-when');

  // What the comparison is ABOUT comes before what it found — "nothing changed" means one thing
  // when 900 lanes were reconverted and the opposite when none have been yet.
  piece(`${compare.changed} of ${compare.books} lanes changed`);
  if (compare.waiting > 0) {
    piece(`${compare.waiting} still converting (left out until they are back)`, 'ji-lint-waiting');
  }

  const deltas = detectorDeltas(compare);
  for (const d of deltas) {
    piece(`${d.label} ${d.before} → ${d.after} ${d.direction === 'up' ? '▲' : '▼'}`,
      d.direction === 'up' ? 'ji-lint-up' : 'ji-lint-down');
  }
  if (deltas.length === 0 && compare.changed > 0) piece('no change in any count');

  if (compare.gone > 0) piece(`${compare.gone} gone`, 'ji-lint-down');
  piece(
    compare.new_total > 0
      ? `${compare.new_total} new in ${compare.new_books} lane${compare.new_books === 1 ? '' : 's'}`
      : 'nothing new',
    compare.new_total > 0 ? 'ji-lint-up' : '',
  );

  // Only offer the filter when it would show something.
  const onlyNewLabel = node('ji-only-new-label');
  if (onlyNewLabel) onlyNewLabel.hidden = compare.new_total === 0;
}

// ── A lane's badge, and its findings in the detail strip ───────────────────

/** [kind, text, tooltip] badges for one lane, in main.ts's badge-tuple shape. */
export function lintBadges(book: string): Array<[string, string, string]> {
  const found = lint.get(book);
  if (!found || found.findings_total === 0) return [];

  const badges: Array<[string, string, string]> = [];
  if (found.new > 0) {
    badges.push(['flag', `▲ ${found.new} new`,
      'Problems that were not in the snapshot — this reconvert introduced them']);
  }
  badges.push(['lint', `${found.findings_total} problem${found.findings_total === 1 ? '' : 's'}`
    + (found.confirmed > 0 ? ` · ${found.confirmed} ✓` : ''),
    summarize(found.counts) + (found.confirmed > 0 ? `\n${found.confirmed} confirmed real` : '')]);
  return badges;
}

/**
 * Paint the selected lane's findings into the detail strip. `onJump` scrolls the reader pane to
 * a node; findings with no single node (a journal-wide page-furniture string) are listed but not
 * clickable. Each finding carries the two verdicts a human can give it; the ones already judged
 * false alarms sit folded underneath, where the verdict can be undone.
 */
export function renderFindings(book: string | null, onJump: (finding: LintFinding) => void): void {
  const toggle = node<HTMLButtonElement>('ji-findings-toggle');
  const list = node('ji-findings');
  if (!toggle || !list) return;

  const found = book ? lint.get(book) : null;
  const dismissed = found?.dismissed ?? [];
  if (!book || !found || (found.findings_total === 0 && dismissed.length === 0)) {
    toggle.hidden = true;
    list.hidden = true;
    list.textContent = '';
    return;
  }

  toggle.hidden = false;
  toggle.textContent = `problems (${found.findings_total})`;
  toggle.setAttribute('aria-expanded', findingsOpen ? 'true' : 'false');
  toggle.classList.toggle('ji-note-toggle-open', findingsOpen);
  toggle.title = summarize(found.counts);

  list.hidden = !findingsOpen;
  list.textContent = '';
  if (!findingsOpen) return;

  for (const finding of found.findings) {
    list.appendChild(buildFinding(book, finding, onJump));
  }
  if (found.findings_total > found.findings.length) {
    const more = document.createElement('div');
    more.className = 'ji-finding-more';
    more.textContent = `…and ${found.findings_total - found.findings.length} more of the same kinds`;
    list.appendChild(more);
  }

  if (dismissed.length > 0) {
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'ji-finding-more ji-finding-fold';
    fold.textContent = `${dismissedOpen ? '▾' : '▸'} ${dismissed.length} dismissed as false alarm${dismissed.length === 1 ? '' : 's'}`;
    fold.setAttribute('aria-expanded', dismissedOpen ? 'true' : 'false');
    fold.addEventListener('click', () => {
      dismissedOpen = !dismissedOpen;
      options?.onChange();
    });
    list.appendChild(fold);
    if (dismissedOpen) {
      for (const finding of dismissed) list.appendChild(buildDismissed(book, finding));
    }
  }
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function verdictButton(text: string, title: string, className: string, act: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ji-finding-verdict ${className}`;
  button.textContent = text;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', () => {
    button.disabled = true;
    act();
  });
  return button;
}

function buildFinding(book: string, finding: LintFinding, onJump: (finding: LintFinding) => void): HTMLElement {
  const jumpable = finding.startLine !== '';
  const row = document.createElement('div');
  row.className = 'ji-finding';
  if (finding.is_new) row.classList.add('ji-finding-new');
  if (finding.confirmed) row.classList.add('ji-finding-confirmed');

  // The jump target is its own button: the verdict buttons sit beside it, and a button cannot
  // hold another button.
  const main = document.createElement(jumpable ? 'button' : 'div');
  main.className = 'ji-finding-main';
  if (jumpable) {
    (main as HTMLButtonElement).type = 'button';
    main.title = `${DETECTOR_LABELS[finding.detector]?.hint ?? ''}\n\nClick to jump to it in the converted output.`.trim();
    main.addEventListener('click', () => {
      row.parentElement?.querySelector('.ji-finding-active')?.classList.remove('ji-finding-active');
      row.classList.add('ji-finding-active');
      onJump(finding);
    });
  } else {
    row.classList.add('ji-finding-static');
    main.title = DETECTOR_LABELS[finding.detector]?.hint ?? '';
  }
  if (finding.is_new) main.appendChild(span('ji-finding-tag', 'new'));
  main.appendChild(span('ji-finding-kind', detectorLabel(finding.detector)));
  main.appendChild(span('ji-finding-excerpt', finding.excerpt));
  row.appendChild(main);

  if (finding.confirmed) {
    row.appendChild(verdictButton('✓ real', 'Confirmed real — click to withdraw (removes it from the note)',
      'ji-finding-verdict-on', () => { void review(book, finding, null); }));
  } else {
    row.appendChild(verdictButton('✓', 'This is a real problem — add it to this lane\'s note for the case bundle',
      'ji-finding-verdict-real', () => { void review(book, finding, 'real'); }));
  }
  row.appendChild(verdictButton('✗', 'False alarm — not a problem; hide it and stop counting it',
    'ji-finding-verdict-false', () => { void review(book, finding, 'false_alarm'); }));

  return row;
}

function buildDismissed(book: string, finding: BookLint['dismissed'][number]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ji-finding ji-finding-static ji-finding-dismissed';
  const main = document.createElement('div');
  main.className = 'ji-finding-main';
  main.appendChild(span('ji-finding-kind', detectorLabel(finding.detector)));
  main.appendChild(span('ji-finding-excerpt', finding.excerpt));
  row.appendChild(main);
  row.appendChild(verdictButton('undo', 'Not a false alarm after all — count it again',
    'ji-finding-verdict-undo', () => { void review(book, finding, null); }));
  return row;
}
