/**
 * /maintainer/journal-import — the journal pipeline console (standalone, non-SPA, admin-only;
 * see Maintainer\JournalImportController).
 *
 * One entry, two pages. The INDEX picks a journal from the existing registry; the DETAIL page
 * (`window.__journalImport.slug`) works one journal's articles. Which one is running is decided
 * by that global, not by the URL, so the blade stays the source of truth.
 *
 * The unit on the detail page is the LANE, not the article: a canonical can carry sibling
 * library rows (pdf / html / ar5iv), and comparing what each produced is the whole point of the
 * page. Selecting a lane loads what we produced beside what we produced it from.
 */

import { log } from '../utilities/logger';
import { ensureCsrfToken } from '../utilities/auth/csrf';
import {
  applySourceFrameTheme, skinnableContentType, sourceIsSkinnable,
} from '../utilities/sourceFrameTheme';

interface JournalRow {
  slug: string;
  display_name: string;
  publisher: string | null;
  issn_l: string | null;
  openalex_source_id: string;
  is_diamond: boolean;
  diamond_provenance: string | null;
  works_count: number | null;
  cited_by_count: number | null;
  last_harvested_at: string | null;
  harvest_runs: number;
  harvest_spend: number;
  articles_total: number;
  articles_imported: number;
  articles_eligible: number;
}

interface FetchTrace {
  won_host?: string;
  won_source?: string;
  completeness?: string;
  body_verdict?: string;
  body_reason?: string;
}

interface Lane {
  book: string;
  lane: string;
  foundation_source: string | null;
  conversion_method: string | null;
  has_nodes: boolean;
  listed: boolean;
  visibility: string | null;
  completeness: string | null;
  completeness_reason: string | null;
  pdf_url_status: string | null;
  is_version: boolean;
  open_flags: number;
  maintainer_note: string | null;
  artifacts: string[];
  fetch_trace: FetchTrace | null;
}

interface Article {
  canonical_id: string;
  title: string | null;
  author: string | null;
  year: string | null;
  volume: string | null;
  issue: string | null;
  doi: string | null;
  cited_by_count: number | null;
  is_oa: boolean;
  fetchable: boolean;
  version_book: string | null;
  lanes: Lane[];
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const has = (id: string): boolean => document.getElementById(id) !== null;

let statusTimer: number | undefined;

function setStatus(text: string): void {
  const node = document.getElementById('ji-status') || document.getElementById('ji-actions-status');
  if (!node) return;
  node.textContent = text;
  node.classList.add('ji-visible');
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => node.classList.remove('ji-visible'), 4000);
}

// ── Index page ─────────────────────────────────────────────────────────────

let journals: { started: JournalRow[]; next: JournalRow[] } = { started: [], next: [] };

async function loadIndex(): Promise<void> {
  const resp = await fetch('/api/maintainer/journal-import/journals', { credentials: 'include' });
  if (!resp.ok) {
    log.error(`Journal list fetch failed (${resp.status})`, 'maintainer-journal-import');
    setStatus(`could not load journals (${resp.status})`);
    return;
  }

  journals = await resp.json();
  const total = journals.started.length + journals.next.length;
  const imported = journals.started.reduce((n, j) => n + j.articles_imported, 0);
  el<HTMLElement>('ji-summary').textContent =
    `${total} journal${total === 1 ? '' : 's'} · ${journals.started.length} started · ${imported} article${imported === 1 ? '' : 's'} imported`;
  renderIndex();
}

function renderIndex(): void {
  const filter = (el<HTMLInputElement>('ji-filter')?.value || '').trim().toLowerCase();
  const match = (j: JournalRow): boolean =>
    !filter
    || j.display_name.toLowerCase().includes(filter)
    || (j.publisher || '').toLowerCase().includes(filter)
    || (j.issn_l || '').toLowerCase().includes(filter);

  renderJournalList('ji-started-list', 'ji-started-empty', journals.started.filter(match), true);
  renderJournalList('ji-next-list', 'ji-next-empty', journals.next.filter(match), false);
}

function renderJournalList(listId: string, emptyId: string, rows: JournalRow[], started: boolean): void {
  const list = el<HTMLDivElement>(listId);
  list.textContent = '';
  el<HTMLElement>(emptyId).hidden = rows.length > 0;

  for (const j of rows) {
    const item = document.createElement('a');
    item.className = 'ji-journal';
    item.setAttribute('role', 'listitem');
    item.href = `/maintainer/journal-import/${encodeURIComponent(j.slug)}`;

    const name = document.createElement('span');
    name.className = 'ji-journal-name';
    name.textContent = j.display_name;
    item.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'ji-journal-meta';
    const bits: string[] = [];
    if (j.publisher) bits.push(j.publisher);
    if (j.cited_by_count) bits.push(`${j.cited_by_count.toLocaleString()} citations`);
    if (j.works_count) bits.push(`${j.works_count.toLocaleString()} works`);
    meta.textContent = bits.join(' · ');
    item.appendChild(meta);

    const stats = document.createElement('span');
    stats.className = 'ji-journal-stats';
    if (started) {
      stats.textContent = `${j.articles_imported} imported · ${j.articles_eligible} left`;
    } else {
      stats.textContent = j.articles_total ? `${j.articles_total} enumerated` : 'not enumerated';
    }
    item.appendChild(stats);

    if (j.is_diamond) {
      const badge = document.createElement('span');
      badge.className = 'ji-badge ji-badge-diamond';
      badge.textContent = '◆ diamond';
      badge.title = j.diamond_provenance || '';
      item.appendChild(badge);
    }

    list.appendChild(item);
  }
}

// ── Detail page ────────────────────────────────────────────────────────────

let articles: Article[] = [];
let selected: Lane | null = null;
/** Set instead of `selected` when an article with no lanes is picked (the import bar's target). */
let selectedArticle: Article | null = null;
/** Which lane the note editor is currently showing, so a re-render doesn't shut it under you. */
let noteStripBook: string | null = null;

async function loadDetail(slug: string): Promise<void> {
  const resp = await fetch(`/api/maintainer/journal-import/${encodeURIComponent(slug)}/articles`, {
    credentials: 'include',
  });
  if (!resp.ok) {
    log.error(`Journal articles fetch failed (${resp.status})`, 'maintainer-journal-import');
    setStatus(`could not load articles (${resp.status})`);
    return;
  }

  const data = await resp.json();
  articles = (data.articles ?? []) as Article[];

  const j = data.journal;
  el<HTMLElement>('ji-journal-name').textContent = j.display_name;
  const est = data.estimate ?? {};
  el<HTMLElement>('ji-journal-meta').textContent =
    `${est.already_harvested ?? 0} imported · ${est.eligible ?? 0} eligible · ${est.total ?? 0} enumerated`
    + (j.publisher ? ` · ${j.publisher}` : '');
  const link = el<HTMLAnchorElement>('ji-public-link');
  link.href = j.public_page;

  // The selected lane is a snapshot of the previous payload; re-point it at the fresh row so the
  // strip shows what the server now holds (a saved note can have opened a flag) rather than a
  // stale copy that merely looks right because the textarea kept what you typed.
  if (selected) {
    const fresh = articles.flatMap((a) => a.lanes).find((l) => l.book === selected?.book);
    if (fresh) {
      selected = fresh;
      renderDetailStrip(fresh);
    }
  }

  renderArticles();
}

function renderArticles(): void {
  const onlyImported = el<HTMLInputElement>('ji-only-imported')?.checked ?? false;
  const rows = onlyImported ? articles.filter((a) => a.lanes.length > 0) : articles;

  const list = el<HTMLDivElement>('ji-articles-list');
  list.textContent = '';
  el<HTMLElement>('ji-articles-empty').hidden = rows.length > 0;
  el<HTMLElement>('ji-articles-count').textContent =
    `${rows.length} article${rows.length === 1 ? '' : 's'}`;

  for (const article of rows) {
    list.appendChild(buildArticle(article));
  }
}

function buildArticle(article: Article): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ji-article';
  wrap.setAttribute('role', 'listitem');
  if (selectedArticle?.canonical_id === article.canonical_id) wrap.classList.add('ji-article-selected');

  const title = document.createElement('div');
  title.className = 'ji-article-title';
  title.textContent = article.title || '(untitled)';
  title.tabIndex = 0;
  // Selecting the ARTICLE (not a lane) is how an un-imported work is acted on: without this,
  // clicking one of the 106 rows with nothing under it did nothing at all.
  const pick = (): void => { selectArticle(article); };
  title.addEventListener('click', pick);
  title.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
  });
  wrap.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'ji-article-meta';
  const bits: string[] = [];
  if (article.year) bits.push(String(article.year));
  if (article.volume) bits.push(`vol ${article.volume}${article.issue ? `(${article.issue})` : ''}`);
  if (article.cited_by_count) bits.push(`cited ${article.cited_by_count}`);
  if (!article.lanes.length) bits.push(article.fetchable ? 'not imported' : 'nothing fetchable');
  meta.textContent = bits.join(' · ');
  wrap.appendChild(meta);

  for (const lane of article.lanes) {
    wrap.appendChild(buildLane(lane));
  }

  return wrap;
}

function buildLane(lane: Lane): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ji-lane';
  if (selected?.book === lane.book) row.classList.add('ji-lane-selected');
  row.tabIndex = 0;

  const name = document.createElement('span');
  name.className = `ji-lane-name ji-lane-${lane.lane}`;
  name.textContent = lane.lane;
  row.appendChild(name);

  if (lane.is_version) {
    const star = document.createElement('span');
    star.className = 'ji-badge ji-badge-version';
    star.textContent = '★ version';
    star.title = 'The promoted version — what /j, the shelf and readers resolve to';
    row.appendChild(star);
  }

  // Evidence badges: what the conversion is, how complete, what the gates said.
  const badges: Array<[string, string, string]> = [];
  if (lane.conversion_method) badges.push(['method', lane.conversion_method, '']);
  if (!lane.has_nodes) badges.push(['warn', 'no content', lane.pdf_url_status || '']);
  if (lane.completeness && lane.completeness !== 'verified_full') {
    badges.push(['warn', lane.completeness, lane.completeness_reason || '']);
  }
  if (lane.fetch_trace?.body_verdict === 'absent') {
    badges.push(['warn', 'body absent', lane.fetch_trace.body_reason || '']);
  }
  if (lane.fetch_trace?.won_host) badges.push(['dim', lane.fetch_trace.won_host, 'winning OA host']);
  if (lane.open_flags) badges.push(['flag', `${lane.open_flags} flag${lane.open_flags === 1 ? '' : 's'}`, '']);
  if (!lane.listed && lane.has_nodes) badges.push(['dim', 'unlisted', 'imported but not public']);

  for (const [kind, text, title] of badges) {
    const b = document.createElement('span');
    b.className = `ji-badge ji-badge-${kind}`;
    b.textContent = text;
    if (title) b.title = title;
    row.appendChild(b);
  }

  const select = (): void => { void selectLane(lane); };
  row.addEventListener('click', select);
  row.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  });

  return row;
}

/**
 * The book id you paste into a dev command, plus the note that rides the case bundle. Separate
 * from selectLane so a reload can refresh it in place: after saving a note the lane's flag count
 * changes, and re-running the whole selection would rebuild both iframes for nothing.
 */
function renderDetailStrip(lane: Lane): void {
  el<HTMLElement>('ji-detail-strip').hidden = false;
  el<HTMLElement>('ji-bookid').textContent = lane.book;
  el<HTMLAnchorElement>('ji-bookid-open').href = `/${lane.book}`;
  el<HTMLElement>('ji-bookid-meta').textContent =
    `${lane.lane} · ${lane.conversion_method ?? 'unknown'}`
    + (lane.open_flags ? ` · ${lane.open_flags} open flag${lane.open_flags === 1 ? '' : 's'}` : '');
  el<HTMLTextAreaElement>('ji-note').value = lane.maintainer_note ?? '';

  // The dot is the whole point of collapsing the editor: with it shut you still need to be able
  // to see, at a glance down the lanes, which ones you have already written up.
  const hasNote = !!lane.maintainer_note?.trim();
  const toggle = el<HTMLButtonElement>('ji-note-toggle');
  el<HTMLElement>('ji-note-dot').hidden = !hasNote;
  toggle.setAttribute('aria-label', hasNote ? 'note (saved)' : 'note');
  toggle.title = hasNote ? 'A note is saved for this lane' : 'Write a note for the case bundle';

  // Collapse when the LANE changes — an editor left open over a different lane's note is how you
  // save the right words against the wrong book. Not on every render: the strip re-renders after
  // a save, and shutting the panel there would hide ✓ fixed / ✕ dismiss just as you reach them.
  if (noteStripBook !== lane.book) {
    setNoteOpen(false);
    noteStripBook = lane.book;
  }

  // Nothing to close when nothing is open.
  el<HTMLButtonElement>('ji-resolve').hidden = lane.open_flags === 0;
  el<HTMLButtonElement>('ji-dismiss').hidden = lane.open_flags === 0;
}

/** Expand or collapse the note editor, keeping the toggle's ARIA state honest. */
function setNoteOpen(open: boolean): void {
  el<HTMLElement>('ji-note-row').hidden = !open;
  el<HTMLButtonElement>('ji-note-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  el<HTMLButtonElement>('ji-note-toggle').classList.toggle('ji-note-toggle-open', open);
  if (open) el<HTMLTextAreaElement>('ji-note').focus();
}

async function selectLane(lane: Lane): Promise<void> {
  selected = lane;
  selectedArticle = null;
  renderArticles();

  el<HTMLElement>('ji-import-bar').hidden = true;
  el<HTMLElement>('ji-actions').hidden = false;
  el<HTMLElement>('ji-actions-book').textContent = `${lane.lane} · ${lane.book}`;

  // Reconvert needs something to reconvert FROM. The two lanes reach it differently: the PDF
  // lane replays its OCR cache through the shared /maintainer/conversion path, the HTML lane
  // re-runs the paste engine over its stored page.
  const isHtmlLane = lane.lane === 'html';
  const reconvert = el<HTMLButtonElement>('ji-reconvert');
  const hasStoredPage = lane.artifacts.includes('fetched_page.html');
  const hasPdfSource = lane.artifacts.some((a) => a.startsWith('original.') || a === 'ocr_response.json');
  reconvert.disabled = isHtmlLane ? !hasStoredPage : !hasPdfSource;
  reconvert.title = reconvert.disabled
    ? 'Nothing on disk to reconvert from — this is a re-fetch case'
    : (isHtmlLane
      ? 'Re-run the converter over the stored page — no network, no cost'
      : 'Reconvert from the OCR cache (shared /maintainer/conversion path)');

  // Re-acquiring a PDF means re-running the whole OA ladder, which is a retract-and-re-harvest,
  // not a button — the same answer /maintainer/conversion gives.
  const refetch = el<HTMLButtonElement>('ji-refetch');
  refetch.disabled = !isHtmlLane;
  refetch.title = isHtmlLane
    ? 'Fetch the publisher page again — for when what we stored is not the article'
    : 'PDF lanes re-acquire by retract + re-harvest, not from here';

  // Only a converted, gate-passing lane can become the version — the same rule the promoter
  // enforces server-side, surfaced here so the button never lies about what it will do.
  const promotable = lane.has_nodes && !lane.is_version
    && lane.conversion_method !== 'html_scrape_unverified';
  const promote = el<HTMLButtonElement>('ji-promote');
  promote.disabled = !promotable;
  promote.title = lane.is_version
    ? 'Already the version readers get'
    : (promotable ? 'Make this lane the version readers get' : 'Not promotable: no content, or the page was never confirmed to be the article');

  renderDetailStrip(lane);

  // Left pane: what we produced.
  const converted = el<HTMLIFrameElement>('ji-converted');
  const convertedPlaceholder = el<HTMLElement>('ji-converted-placeholder');
  if (lane.has_nodes) {
    converted.src = `/${lane.book}`;
    convertedPlaceholder.hidden = true;
  } else {
    converted.src = 'about:blank';
    convertedPlaceholder.textContent = lane.pdf_url_status || 'nothing imported for this lane';
    convertedPlaceholder.hidden = false;
  }
  el<HTMLElement>('ji-converted-label').textContent = `converted output · ${lane.conversion_method ?? 'unknown'}`;

  // Right pane: what we produced it FROM. Probe first — a lane whose fetch failed has no file,
  // and pointing an iframe at a 404 renders the error page inside the pane.
  const source = el<HTMLIFrameElement>('ji-source');
  const sourcePlaceholder = el<HTMLElement>('ji-source-placeholder');
  const sourceUrl = `/api/maintainer/conversion/original/${encodeURIComponent(lane.book)}`;
  source.src = 'about:blank';
  sourcePlaceholder.hidden = false;
  sourcePlaceholder.textContent = 'checking…';
  el<HTMLElement>('ji-source-label').textContent = `source · ${sourceKindOf(lane)}`;

  try {
    const probe = await fetch(sourceUrl, { method: 'HEAD', credentials: 'include' });
    if (selected?.book !== lane.book) return; // selection moved while probing
    if (probe.ok) {
      // Paint the fetched page in the operator's theme once it lands. A PDF can't be skinned, so
      // the pane falls back to a light canvas — the viewer paints its own background anyway.
      // Sandbox the fetched page's SCRIPTS. We serve it from our own origin, so left alone the
      // publisher's JS runs same-origin with this admin console and could drive the maintainer
      // API as the logged-in admin (the session cookie is HttpOnly, but same-origin fetch doesn't
      // need to read it). `allow-same-origin` WITHOUT `allow-scripts` is the exact combination we
      // want: nothing executes, but the document keeps our origin so the theme injection below
      // still reaches it. (allow-scripts + allow-same-origin together would let a frame remove
      // its own sandbox — with no scripts there is nothing to do that.)
      // PDFs are left unsandboxed: they execute nothing of ours and the browser's viewer is
      // fussy enough already.
      // Decide the canvas NOW, from the artifacts — not inside onload. A PDF frame may never
      // fire load, which would leave the class at the PREVIOUS lane's value and paint a PDF on a
      // dark canvas (or a themed page on a white one).
      // What the server SAID it is beats what we think is on disk (see skinnableContentType).
      const skinnable = skinnableContentType(probe.headers.get('content-type'))
        ?? sourceIsSkinnable(lane.artifacts);
      const pane = document.querySelector('.ji-source');
      pane?.classList.toggle('ji-source-unskinned', !skinnable);
      // Must be set BEFORE the src assignment — sandbox applies at load time.
      if (skinnable) source.setAttribute('sandbox', 'allow-same-origin');
      else source.removeAttribute('sandbox');
      source.onload = (): void => {
        if (!skinnable) return;
        pane?.classList.toggle('ji-source-unskinned', !applySourceFrameTheme(source));
      };
      source.src = sourceUrl;
      sourcePlaceholder.hidden = true;
    } else {
      sourcePlaceholder.textContent = 'no source file on disk';
    }
  } catch {
    if (selected?.book === lane.book) sourcePlaceholder.textContent = 'no source file on disk';
  }
}

/** What the right pane is showing, from the artifacts we know exist. */
function sourceKindOf(lane: Lane): string {
  if (lane.artifacts.includes('original.pdf')) return 'original.pdf';
  if (lane.artifacts.includes('fetched_page.html')) return 'fetched_page.html';
  if (lane.artifacts.includes('original.html')) return 'original.html';
  const other = lane.artifacts.find((a) => a.startsWith('original.'));
  return other ?? 'none';
}

// ── Shared chrome ──────────────────────────────────────────────────────────

function wireHelp(): void {
  const toggle = document.getElementById('ji-help-toggle');
  const panel = document.getElementById('ji-help-panel');
  const close = document.getElementById('ji-help-close');
  if (!toggle || !panel) return;

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden === true));
  close?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });
}

/** The action bar is draggable and remembers where you put it (as on /maintainer/conversion). */
function wireActionBar(): void {
  const bar = document.getElementById('ji-actions');
  const grip = document.getElementById('ji-actions-grip');
  if (!bar || !grip) return;

  try {
    const saved = localStorage.getItem('ji_actions_pos');
    if (saved) {
      const { left, top } = JSON.parse(saved) as { left: number; top: number };
      bar.style.left = `${left}px`;
      bar.style.top = `${top}px`;
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
    }
  } catch { /* a bad saved position must never stop the page rendering */ }

  let dx = 0;
  let dy = 0;
  grip.addEventListener('pointerdown', (e: PointerEvent) => {
    const rect = bar.getBoundingClientRect();
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    grip.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent): void => {
      bar.style.left = `${ev.clientX - dx}px`;
      bar.style.top = `${ev.clientY - dy}px`;
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
    };
    const up = (): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      try {
        const rect2 = bar.getBoundingClientRect();
        localStorage.setItem('ji_actions_pos', JSON.stringify({ left: rect2.left, top: rect2.top }));
      } catch { /* storage unavailable — position just won't persist */ }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  grip.addEventListener('dblclick', () => {
    bar.style.left = '';
    bar.style.top = '';
    bar.style.right = '';
    bar.style.bottom = '';
    try { localStorage.removeItem('ji_actions_pos'); } catch { /* nothing to clear */ }
  });
}

/**
 * Select an ARTICLE rather than a lane, and offer to fetch it. Clears the panes: there is no
 * output yet, and leaving the previous lane's book on screen next to a different article's title
 * is exactly the kind of thing that gets the wrong version promoted.
 */
function selectArticle(article: Article): void {
  selected = null;
  selectedArticle = article;
  renderArticles();

  el<HTMLElement>('ji-detail-strip').hidden = true;
  el<HTMLElement>('ji-actions').hidden = true;
  el<HTMLElement>('ji-import-bar').hidden = false;
  el<HTMLElement>('ji-import-title').textContent = article.title || '(untitled)';

  const importable = article.fetchable;
  for (const id of ['ji-import-pdf', 'ji-import-html', 'ji-import-both']) {
    const b = el<HTMLButtonElement>(id);
    b.disabled = !importable;
    b.title = importable ? b.title : 'Nothing to fetch from: no DOI, no OA url, no PDF url';
  }
  el<HTMLElement>('ji-import-status').textContent = article.lanes.length
    ? 'already has lane(s) — re-importing adds the missing one'
    : '';

  const converted = el<HTMLIFrameElement>('ji-converted');
  converted.src = 'about:blank';
  el<HTMLElement>('ji-converted-placeholder').textContent = 'not imported yet';
  el<HTMLElement>('ji-converted-placeholder').hidden = false;
  el<HTMLElement>('ji-converted-label').textContent = 'converted output';

  const source = el<HTMLIFrameElement>('ji-source');
  source.src = 'about:blank';
  el<HTMLElement>('ji-source-placeholder').textContent = 'nothing fetched yet';
  el<HTMLElement>('ji-source-placeholder').hidden = false;
  el<HTMLElement>('ji-source-label').textContent = 'source';
}

/**
 * Fire one queued action and follow it to the end.
 *
 * Everything here either hits a publisher or runs OCR, so the server queues it and hands back a
 * run id; this polls that row. `setter` writes to whichever status line belongs to the bar that
 * fired it, so a long import doesn't silently report into the other one.
 */
async function runAction(
  body: Record<string, string>,
  setter: (text: string) => void,
  buttons: string[],
): Promise<void> {
  const slug = detailSlugOf();
  if (!slug) return;

  const headers = await csrfHeaders();
  if (!headers) return;

  for (const id of buttons) el<HTMLButtonElement>(id).disabled = true;
  setter('dispatching…');

  try {
    const resp = await fetch(`/api/maintainer/journal-import/${encodeURIComponent(slug)}/run`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await resp.json().catch(() => ({})) as {
      run_id?: string; message?: string; already_running?: boolean; action?: string;
    };
    if (!resp.ok || !payload.run_id) {
      setter(payload.message || `failed (${resp.status})`);
      return;
    }
    // Joining a run you didn't press — a bulk import fired while an enumerate is still going —
    // would otherwise report that other job's progress as if it were yours.
    if (payload.already_running && payload.action && payload.action !== body.action) {
      setter(`waiting: "${payload.action}" is already running on this journal`);
    }
    await pollRun(payload.run_id, setter);
  } catch (e) {
    log.error('Journal import action failed', 'maintainer-journal-import', e);
    setter('failed — see logs');
  } finally {
    for (const id of buttons) el<HTMLButtonElement>(id).disabled = false;
  }
}

/** Poll a run row to completion, then reload the list so the new/changed lane shows. */
async function pollRun(runId: string, setter: (text: string) => void): Promise<void> {
  for (;;) {
    await new Promise((r) => window.setTimeout(r, 2500));
    const resp = await fetch(`/api/maintainer/journal-import/runs/${encodeURIComponent(runId)}`, {
      credentials: 'include',
    });
    if (!resp.ok) {
      setter(`lost the run (${resp.status})`);
      return;
    }
    const run = await resp.json() as {
      status: string; step_detail: string | null; error: string | null;
      counts: { summary?: string };
    };

    if (run.status === 'completed') {
      setter(run.counts.summary ? `done — ${run.counts.summary}` : 'done');
      const slug = detailSlugOf();
      if (slug) await loadDetail(slug);
      return;
    }
    if (run.status === 'failed') {
      setter(run.error ? `failed: ${run.error}` : 'failed');
      return;
    }
    setter(run.step_detail || run.status);
  }
}

/**
 * The PDF lane's reconvert is the SHARED one (/api/books/{book}/reconvert + import-progress) —
 * that book has an original.pdf and an OCR cache, and duplicating that pipeline here would give
 * the app two reconvert implementations to keep in step.
 */
async function reconvertPdfLane(book: string): Promise<void> {
  const headers = await csrfHeaders();
  if (!headers) return;

  const button = el<HTMLButtonElement>('ji-reconvert');
  button.disabled = true;
  setStatus('dispatching…');

  try {
    const resp = await fetch(`/api/books/${encodeURIComponent(book)}/reconvert`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { message?: string };
      setStatus(body.message || `reconvert failed (${resp.status})`);
      return;
    }

    for (;;) {
      await new Promise((r) => window.setTimeout(r, 2500));
      const p = await fetch(`/api/import-progress/${encodeURIComponent(book)}`, { credentials: 'include' });
      if (!p.ok) continue;
      const progress = await p.json() as { status?: string; percent?: number; stage?: string };
      setStatus(`${progress.status ?? '…'} ${progress.percent ?? 0}% ${progress.stage ?? ''}`);
      if (progress.status === 'complete' || progress.status === 'failed') {
        if (progress.status === 'complete') {
          setStatus('reconverted — reloading');
          const slug = detailSlugOf();
          if (slug) await loadDetail(slug);
        } else {
          setStatus('reconvert FAILED — see logs');
        }
        return;
      }
    }
  } catch (e) {
    log.error('PDF reconvert failed', 'maintainer-journal-import', e);
    setStatus('reconvert failed — see logs');
  } finally {
    button.disabled = false;
  }
}

const detailSlugOf = (): string | undefined =>
  (window as unknown as { __journalImport?: { slug: string } }).__journalImport?.slug;

async function csrfHeaders(): Promise<Record<string, string> | null> {
  const token = await ensureCsrfToken();
  if (!token) {
    setStatus('session error — refresh and retry');
    return null;
  }
  return { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' };
}

/**
 * Make the selected lane the version readers get. Reloads the article list afterwards rather
 * than patching state locally: promotion moves the pointer, the listing AND shelf membership,
 * and a half-updated view of that is worse than a round-trip.
 */
async function promoteSelected(): Promise<void> {
  if (!selected) return;
  if (selected.is_version) {
    setStatus('already the version');
    return;
  }

  const headers = await csrfHeaders();
  if (!headers) return;

  const button = el<HTMLButtonElement>('ji-promote');
  button.disabled = true;
  setStatus('promoting…');

  try {
    const resp = await fetch(`/api/maintainer/journal-import/promote/${encodeURIComponent(selected.book)}`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    const body = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      setStatus(body.message || `promote failed (${resp.status})`);
      return;
    }

    const demoted = (body.demoted ?? []) as string[];
    setStatus(demoted.length ? `promoted — unlisted ${demoted.length} sibling` : 'promoted');
    const slug = (window as unknown as { __journalImport?: { slug: string } }).__journalImport?.slug;
    if (slug) await loadDetail(slug);
  } catch (e) {
    log.error('Promote failed', 'maintainer-journal-import', e);
    setStatus('promote failed — see logs');
  } finally {
    button.disabled = false;
  }
}

/**
 * Save the maintainer's read of this lane. It lives in the open flags' details and travels with
 * the case bundle, so the dev side sees the diagnosis next to the artifacts. A lane nobody has
 * flagged gets one opened for it server-side — you noticing IS the report.
 */
async function saveNote(): Promise<void> {
  if (!selected) return;

  const headers = await csrfHeaders();
  if (!headers) return;

  const button = el<HTMLButtonElement>('ji-note-save');
  const note = el<HTMLTextAreaElement>('ji-note').value;
  button.disabled = true;
  setStatus('saving note…');

  try {
    const resp = await fetch(
      `/api/maintainer/conversion/flags/${encodeURIComponent(selected.book)}/note`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      },
    );
    const body = await resp.json().catch(() => ({})) as { message?: string; saved?: number };
    if (!resp.ok) {
      setStatus(body.message || `note failed (${resp.status})`);
      return;
    }
    setStatus(note.trim() ? 'note saved — it rides the bundle' : 'note cleared');
    // The flag count on the lane may have just changed (a note can open a case).
    const slug = detailSlugOf();
    if (slug) await loadDetail(slug);
  } catch (e) {
    log.error('Save note failed', 'maintainer-journal-import', e);
    setStatus('note failed — see logs');
  } finally {
    button.disabled = false;
  }
}

/**
 * Close this lane's case without leaving the page.
 *
 * Deliberately the journal-import endpoint, not the shared conversion one: that one treats
 * approval as the listing gate and would publish whatever lane you resolved — including the loser,
 * leaving two public versions of one article. Here listing only follows if this lane is already
 * the promoted one; ★ make version stays the only way to publish.
 */
async function resolveCase(resolution: 'reconverted' | 'dismissed'): Promise<void> {
  if (!selected) return;

  const headers = await csrfHeaders();
  if (!headers) return;

  const buttons = ['ji-resolve', 'ji-dismiss'];
  for (const id of buttons) el<HTMLButtonElement>(id).disabled = true;
  setStatus('closing case…');

  try {
    const resp = await fetch(
      `/api/maintainer/journal-import/resolve/${encodeURIComponent(selected.book)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution }),
      },
    );
    const body = await resp.json().catch(() => ({})) as {
      message?: string; resolved?: number; listed?: boolean;
    };
    if (!resp.ok) {
      setStatus(body.message || `close failed (${resp.status})`);
      return;
    }

    setStatus(`case closed (${body.resolved ?? 0} flag${body.resolved === 1 ? '' : 's'})`
      + (body.listed ? ' — lane is now listed' : ''));
    const slug = detailSlugOf();
    if (slug) await loadDetail(slug);
  } catch (e) {
    log.error('Close case failed', 'maintainer-journal-import', e);
    setStatus('close failed — see logs');
  } finally {
    for (const id of buttons) el<HTMLButtonElement>(id).disabled = false;
  }
}

function wireDetailActions(): void {
  document.getElementById('ji-open-reader')?.addEventListener('click', () => {
    if (selected) window.open(`/${selected.book}`, '_blank', 'noopener');
  });
  document.getElementById('ji-promote')?.addEventListener('click', () => { void promoteSelected(); });

  // Two bundles, two fix loops (BookExport::KIND_*): `conversion` blames the converter and
  // replays through run_regression.py; `harvest` blames acquisition and ships canonical_source +
  // fetch_trace.json. Picking one IS the diagnosis, so neither is a default.
  const bundle = (kind: 'conversion' | 'harvest') => (): void => {
    if (!selected) return;
    setStatus(`building ${kind} bundle…`);
    // origin= lands in the bundle manifest, so the importing side knows the case came off a
    // journal lane rather than the generic conversion queue.
    window.location.href =
      `/api/maintainer/conversion/export/${encodeURIComponent(selected.book)}`
      + `?kind=${kind}&origin=journal-import`;
    window.setTimeout(() => setStatus(''), 4000);
  };
  document.getElementById('ji-export')?.addEventListener('click', bundle('conversion'));
  document.getElementById('ji-export-harvest')?.addEventListener('click', bundle('harvest'));

  document.getElementById('ji-reconvert')?.addEventListener('click', () => {
    if (!selected) return;
    if (selected.lane !== 'html') {
      void reconvertPdfLane(selected.book);
      return;
    }
    void runAction(
      { action: 'reconvert_html', book: selected.book },
      setStatus,
      ['ji-reconvert', 'ji-refetch'],
    );
  });

  document.getElementById('ji-refetch')?.addEventListener('click', () => {
    if (!selected) return;
    if (!window.confirm('Re-fetch this page from the publisher? The stored copy is replaced.')) return;
    void runAction(
      { action: 'refetch_html', book: selected.book },
      setStatus,
      ['ji-reconvert', 'ji-refetch'],
    );
  });

  const importButtons = ['ji-import-pdf', 'ji-import-html', 'ji-import-both'];
  const setImportStatus = (text: string): void => {
    el<HTMLElement>('ji-import-status').textContent = text;
  };
  const startImport = (lanes: 'pdf' | 'html' | 'both') => (): void => {
    if (!selectedArticle) return;
    if (lanes !== 'html'
      && !window.confirm('The PDF lane runs OCR, which is charged to your account. Continue?')) {
      return;
    }
    void runAction(
      { action: 'import', lanes, canonical_id: selectedArticle.canonical_id },
      setImportStatus,
      importButtons,
    );
  };
  document.getElementById('ji-import-pdf')?.addEventListener('click', startImport('pdf'));
  document.getElementById('ji-import-html')?.addEventListener('click', startImport('html'));
  document.getElementById('ji-import-both')?.addEventListener('click', startImport('both'));

  const bookId = document.getElementById('ji-bookid');
  const copyBookId = (): void => {
    if (!selected) return;
    void navigator.clipboard?.writeText(selected.book).then(
      () => setStatus('book id copied'),
      () => setStatus('copy failed — select and copy manually'),
    );
  };
  bookId?.addEventListener('click', copyBookId);
  bookId?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyBookId(); }
  });

  document.getElementById('ji-note-toggle')?.addEventListener('click', () => {
    // `hidden` types as boolean | "until-found", so coerce rather than pass it straight through.
    setNoteOpen(!!el<HTMLElement>('ji-note-row').hidden);
  });
  document.getElementById('ji-note-save')?.addEventListener('click', () => { void saveNote(); });
  document.getElementById('ji-resolve')?.addEventListener('click', () => { void resolveCase('reconverted'); });
  document.getElementById('ji-dismiss')?.addEventListener('click', () => { void resolveCase('dismissed'); });

  document.getElementById('ji-only-imported')?.addEventListener('change', renderArticles);
}

/**
 * The two JOURNAL-scoped buttons.
 *
 * Everything else on this page targets one article, which left a journal nobody had enumerated
 * with an empty list and no way to fill it — the article rows every other control hangs off did
 * not exist yet. Enumerate creates them (free: OpenAlex only, no publisher, no OCR); import works
 * the queue in bulk.
 */
function wireJournalActions(): void {
  const buttons = ['ji-enumerate', 'ji-bulk-import'];
  const setJournalStatus = (text: string): void => {
    const node = document.getElementById('ji-journal-status');
    if (node) node.textContent = text;
  };

  document.getElementById('ji-enumerate')?.addEventListener('click', () => {
    void runAction({ action: 'enumerate' }, setJournalStatus, buttons);
  });

  document.getElementById('ji-bulk-import')?.addEventListener('click', () => {
    const lanes = (el<HTMLSelectElement>('ji-bulk-lanes').value || 'html') as 'pdf' | 'html' | 'both';
    const limit = el<HTMLSelectElement>('ji-bulk-limit').value || '5';
    const howMany = limit === '0' ? 'EVERY eligible work' : `up to ${limit} works`;

    // Two separate things worth stopping for: spending money, and unbounded scope. Either one
    // alone deserves the prompt — "all eligible" on the free HTML lane still hammers a publisher.
    if (lanes !== 'html' || limit === '0') {
      const cost = lanes === 'html'
        ? 'The HTML lane is free, but this fetches from the publisher repeatedly.'
        : 'The PDF lane runs OCR, which is charged to your account.';
      if (!window.confirm(`Import ${howMany} (${lanes}) for this journal?\n\n${cost}`)) return;
    }

    void runAction({ action: 'import_all', lanes, limit }, setJournalStatus, buttons);
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────

wireHelp();

const detailSlug = (window as unknown as { __journalImport?: { slug: string } }).__journalImport?.slug;

if (detailSlug) {
  wireActionBar();
  wireDetailActions();
  wireJournalActions();
  void loadDetail(detailSlug);
} else if (has('ji-started-list')) {
  el<HTMLInputElement>('ji-filter')?.addEventListener('input', renderIndex);
  void loadIndex();
}
