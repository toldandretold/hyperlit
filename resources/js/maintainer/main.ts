/**
 * /maintainer/conversion — the triage page's wiring (standalone, non-SPA, admin-only;
 * see MaintainerController). Left: the open-flag queue; middle: the flagged
 * book in the REAL reader (same-origin iframe); right: the original source
 * file; bottom: dev-bundle / reconvert / resolve / dismiss actions.
 */

import { log } from '../utilities/logger';
import { ensureCsrfToken } from '../utilities/auth/csrf';

interface QueueFlag {
  source: string;
  reason: string | null;
  report_count: number;
  details: Record<string, unknown>;
  created_at: string | null;
}

interface QueueEntry {
  book: string;
  title: string;
  creator: string | null;
  conversion_method: string | null;
  completeness: string | null;
  artifacts: string[];
  fixture: 'fixtures' | 'fixtures-local' | null;
  suggested: 'reconvert' | 're-fetch' | 'inspect';
  flags: QueueFlag[];
}

declare global {
  interface Window {
    __maintainer?: { book: string | null };
  }
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let entries: QueueEntry[] = [];
let selected: QueueEntry | null = null;

// "⚗ regressions" filter: only cases with a captured regression fixture — i.e. the books
// currently in the pulled-and-fixed review loop. The local DB accumulates open flags from every
// bundle ever imported, so without this the actual review set drowns. Sticky across visits.
const REGRESSIONS_KEY = 'maintainer_regressions_only';
let regressionsOnly = localStorage.getItem(REGRESSIONS_KEY) === '1';

function visibleEntries(): QueueEntry[] {
  return regressionsOnly ? entries.filter((e) => e.fixture !== null) : entries;
}

// ── Queue list ────────────────────────────────────────────────────────────

async function loadQueue(): Promise<void> {
  const resp = await fetch('/api/maintainer/conversion/flags', { credentials: 'include' });
  if (!resp.ok) {
    log.error(`Maintainer queue fetch failed (${resp.status})`, 'maintainer');
    return;
  }
  entries = ((await resp.json()).entries ?? []) as QueueEntry[];
  renderList();

  // Deep link (?book= — server passes it through window.__maintainer).
  const wanted = window.__maintainer?.book;
  const match = wanted ? entries.find((e) => e.book === wanted) : null;
  if (match) {
    select(match);
  } else if (wanted) {
    // Not in the queue (already resolved, or direct link) — still show it.
    select({ book: wanted, title: wanted, creator: null, conversion_method: null,
      completeness: null, artifacts: [], fixture: null, suggested: 'inspect', flags: [] });
  }
}

function renderList(): void {
  const list = el<HTMLDivElement>('mt-flags-list');
  list.innerHTML = '';

  // Regressions toggle: only shown when at least one case HAS a fixture (on prod
  // that's the committed committable set; locally, everything import-cases captured).
  const withFixture = entries.filter((e) => e.fixture !== null).length;
  const toggle = el<HTMLButtonElement>('mt-regressions-toggle');
  toggle.hidden = withFixture === 0;
  if (withFixture === 0) regressionsOnly = false;
  toggle.textContent = `⚗ regressions (${withFixture})`;
  toggle.setAttribute('aria-pressed', String(regressionsOnly));
  toggle.classList.toggle('mt-toggled', regressionsOnly);

  const shown = visibleEntries();
  el<HTMLParagraphElement>('mt-flags-empty').hidden = shown.length > 0;

  for (const entry of shown) {
    const item = document.createElement('div');
    item.className = 'mt-flag-item';
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;
    if (selected?.book === entry.book) item.classList.add('mt-selected');

    // "⤓ conversion / ⤓ harvest" marker — this case's bundle was already
    // downloaded (stamped into the flag details by the export endpoint, so it
    // survives reloads and is visible to every admin).
    const exported = entry.flags
      .map((f) => f.details?.exported_kind)
      .filter((k): k is string => k === 'conversion' || k === 'harvest')
      .pop();
    if (exported) {
      item.classList.add('mt-exported');
      const mark = document.createElement('span');
      mark.className = 'mt-flag-export';
      mark.dataset.kind = exported;
      mark.textContent = `⤓ ${exported}`;
      mark.title = 'Case bundle downloaded';
      item.appendChild(mark);
    }

    const title = document.createElement('div');
    title.className = 'mt-flag-title';
    title.textContent = entry.title;

    const meta = document.createElement('div');
    meta.className = 'mt-flag-meta';
    const badge = document.createElement('span');
    badge.className = 'mt-flag-badge';
    badge.dataset.action = entry.suggested;
    badge.textContent = entry.suggested;
    meta.appendChild(badge);
    // ⚗ = this case has a captured regression fixture (it's in the review loop).
    if (entry.fixture) {
      const fx = document.createElement('span');
      fx.className = 'mt-flag-badge';
      fx.dataset.action = 'regression';
      fx.textContent = '⚗ regression';
      fx.title = entry.fixture === 'fixtures'
        ? 'Regression fixture captured (committable — permissive license)'
        : 'Regression fixture captured (fixtures-local — git-ignored, non-permissive/unknown license)';
      meta.appendChild(fx);
    }
    // Lane badge: this case's conversion was the PASTE engine (a user's
    // paste-glitch report, pasted_page.html on disk) or a scrape — its fix
    // loop is tests/paste, not app/Python.
    if (entry.artifacts.includes('pasted_page.html')) {
      const lane = document.createElement('span');
      lane.className = 'mt-flag-badge';
      lane.dataset.action = 'pasted';
      lane.textContent = 'pasted';
      meta.appendChild(lane);
    } else if (entry.artifacts.includes('fetched_page.html')) {
      const lane = document.createElement('span');
      lane.className = 'mt-flag-badge';
      lane.dataset.action = 'scraped';
      lane.textContent = 'scraped';
      meta.appendChild(lane);
    }
    const sources = entry.flags
      .map((f) => `${f.source}×${f.report_count}`)
      .join(' · ');
    meta.appendChild(document.createTextNode(
      `${sources}${entry.conversion_method ? ` · ${entry.conversion_method}` : ''}`,
    ));

    item.append(title, meta);
    const go = (): void => select(entry);
    item.addEventListener('click', go);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
    list.appendChild(item);
  }
}

// ── Selection: load both panes ────────────────────────────────────────────

function select(entry: QueueEntry): void {
  selected = entry;
  renderList();
  history.replaceState(null, '', `/maintainer/conversion?book=${encodeURIComponent(entry.book)}`);

  // Middle: the real reader.
  el<HTMLIFrameElement>('mt-reader').src = `/${entry.book}`;
  el<HTMLParagraphElement>('mt-reader-placeholder').hidden = true;

  renderDetailStrip(entry);

  // Right: the original file (HEAD-probe so a 404 hides the pane cleanly).
  const originalUrl = `/api/maintainer/conversion/original/${encodeURIComponent(entry.book)}`;
  const frame = el<HTMLIFrameElement>('mt-original');
  const placeholder = el<HTMLParagraphElement>('mt-original-placeholder');
  frame.src = 'about:blank';
  placeholder.hidden = true;
  void fetch(originalUrl, { method: 'HEAD', credentials: 'include' }).then((r) => {
    if (selected?.book !== entry.book) return; // superseded by a newer click
    if (r.ok) {
      frame.src = originalUrl;
    } else {
      placeholder.hidden = false;
    }
  });

  // Action bar. Reconvert needs a source on disk (original.* / OCR cache /
  // main-text.md) — without one the server can only 404 ("No source file
  // found"), so disable the button up front for re-fetch/inspect cases.
  el<HTMLDivElement>('mt-actions').hidden = false;
  el<HTMLSpanElement>('mt-actions-book').textContent = entry.title;
  const reconvertBtn = el<HTMLButtonElement>('mt-reconvert');
  const hasSource = entry.artifacts.some(
    (a) => a.startsWith('original.') || a === 'ocr_response.json' || a === 'epub_original',
  );
  // Deep-linked books outside the queue get a synthetic entry with no artifact
  // info — leave the button enabled there rather than guessing.
  reconvertBtn.disabled = entry.flags.length > 0 && !hasSource;
  reconvertBtn.title = hasSource
    ? ''
    : 'No source file on disk — nothing to reconvert from. This is a re-fetch case: retract it (a future harvest re-fetches through the gated ladder), or resolve/dismiss.';
  setStatus('');
}

function setStatus(text: string): void {
  el<HTMLSpanElement>('mt-actions-status').textContent = text;
}

/**
 * The detail strip above the reader: the user's complaint per flag, plus the
 * MAINTAINER's own note — editable in place, stored in the flags' details, so
 * it rides the case bundle to local dev and the LLM reads both diagnoses.
 */
function renderDetailStrip(entry: QueueEntry): void {
  const detail = el<HTMLDivElement>('mt-detail');
  detail.innerHTML = '';
  detail.hidden = entry.flags.length === 0;
  for (const flag of entry.flags) {
    const line = document.createElement('div');
    const issueTypes = Array.isArray(flag.details?.issueTypes) ? flag.details.issueTypes as string[] : [];
    const signals = Array.isArray(flag.details?.signals) ? flag.details.signals as string[] : [];
    line.textContent = `[${flag.source} ×${flag.report_count}] `
      + (flag.reason ?? '')
      + (issueTypes.length ? ` — ${issueTypes.join(', ')}` : '')
      + (signals.length ? ` — ${signals.join(', ')}` : '');
    detail.appendChild(line);
  }
  if (entry.flags.length > 0) {
    detail.appendChild(buildNoteRow(entry));
  }
}

function buildNoteRow(entry: QueueEntry): HTMLDivElement {
  const existing = entry.flags
    .map((f) => f.details?.maintainer_note)
    .filter((n): n is string => typeof n === 'string' && n !== '')
    .pop() ?? '';

  const row = document.createElement('div');
  row.className = 'mt-note-row';

  const label = document.createElement('span');
  label.className = 'mt-note-label';
  label.textContent = existing ? `[maintainer] ${existing}` : '';
  if (existing) row.appendChild(label);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mt-note-btn';
  btn.textContent = existing ? '✎ edit note' : '✎ add note';
  btn.title = 'Your diagnosis rides the case bundle to dev alongside the user report';
  btn.addEventListener('click', () => {
    row.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'mt-note-editor';
    ta.rows = 2;
    ta.maxLength = 4000;
    ta.placeholder = 'What YOU see — e.g. "endnotes were parsed as references; markers 12–19 unlinked"';
    ta.value = existing;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mt-note-btn';
    save.textContent = 'save';
    save.addEventListener('click', () => void saveNote(entry, ta.value.trim()));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mt-note-btn';
    cancel.textContent = 'cancel';
    cancel.addEventListener('click', () => {
      row.replaceWith(buildNoteRow(entry));
    });
    row.append(ta, save, cancel);
    ta.focus();
  });
  row.appendChild(btn);

  return row;
}

async function saveNote(entry: QueueEntry, note: string): Promise<void> {
  const headers = await csrfHeaders();
  if (!headers) return;
  const resp = await fetch(`/api/maintainer/conversion/flags/${encodeURIComponent(entry.book)}/note`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (!resp.ok) {
    setStatus(`note save failed (${resp.status})`);
    return;
  }
  // Mirror the server-side stamp locally, then re-render the strip.
  for (const flag of entry.flags) {
    if (note === '') {
      delete flag.details?.maintainer_note;
    } else {
      flag.details = { ...flag.details, maintainer_note: note };
    }
  }
  setStatus(note === '' ? 'note cleared' : 'note saved — rides the case bundle');
  if (selected?.book === entry.book) renderDetailStrip(entry);
}

// ── Actions ───────────────────────────────────────────────────────────────

/** Session POSTs need the XSRF token — the standalone page must bootstrap it
 *  itself (no SPA boot here); tokenless POSTs 419. */
async function csrfHeaders(): Promise<Record<string, string> | null> {
  const token = await ensureCsrfToken();
  if (!token) {
    setStatus('session error — refresh and retry');
    return null;
  }
  return { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' };
}

/** Remove the handled book from the queue and advance to the next flag. */
function dropSelectedFromQueue(statusText: string): void {
  if (!selected) return;
  const gone = selected.book;
  entries = entries.filter((e) => e.book !== gone);
  selected = null;
  renderList();
  setStatus(statusText);
  const shown = visibleEntries();
  if (shown.length > 0) {
    select(shown[0]!);
  } else {
    el<HTMLDivElement>('mt-actions').hidden = true;
  }
}

async function resolveSelected(resolution: 'reconverted' | 'dismissed'): Promise<void> {
  if (!selected) return;
  const headers = await csrfHeaders();
  if (!headers) return;
  const resp = await fetch(`/api/maintainer/conversion/flags/${encodeURIComponent(selected.book)}/resolve`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution }),
  });
  if (!resp.ok) {
    setStatus(`resolve failed (${resp.status})`);
    return;
  }
  // Harvested versions are public+unlisted until a human approves them —
  // the server lists the book when this resolve was that approval.
  const body = await resp.json().catch(() => ({ listed: false })) as { listed?: boolean };
  dropSelectedFromQueue(`${resolution}: ${selected.book}${body.listed ? ' — now listed' : ''}`);
}

/**
 * Harvest false positive: the fetched content was never the work (landing
 * page / captcha / contents-only), so the version should not exist at all.
 * The server re-checks body presence — a body_present 422 means "this might
 * be a REAL book"; the human confirms a second time and we retry with force.
 */
async function retractSelected(): Promise<void> {
  if (!selected) return;
  const entry = selected;
  if (!window.confirm(`Retract ${entry.title}?\nThe harvested version is DELETED (it should never have been approved), its canonical is freed for a legitimate re-fetch, and the flag closes as "retracted".`)) {
    return;
  }

  const post = async (force: boolean): Promise<Response | null> => {
    const headers = await csrfHeaders();
    if (!headers) return null;
    return fetch(`/api/maintainer/conversion/flags/${encodeURIComponent(entry.book)}/retract`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
  };

  setStatus('retracting…');
  let resp = await post(false);
  if (!resp) return;
  if (resp.status === 422) {
    const body = await resp.json() as { refusal?: string; message?: string };
    if (body.refusal !== 'body_present') {
      setStatus(body.message ?? `retract refused (${resp.status})`);
      return;
    }
    if (!window.confirm(`${body.message ?? 'The stored text looks like a REAL body.'}`)) {
      setStatus('');
      return;
    }
    resp = await post(true);
    if (!resp) return;
  }
  if (!resp.ok) {
    setStatus(`retract failed (${resp.status})`);
    return;
  }
  dropSelectedFromQueue(`retracted: ${entry.book}`);
}

async function reconvertSelected(): Promise<void> {
  if (!selected) return;
  const entry = selected;
  if (!window.confirm(`Reconvert ${entry.title} from its source?\nContent is replaced; annotations re-attach automatically.`)) {
    return;
  }

  const btn = el<HTMLButtonElement>('mt-reconvert');
  btn.disabled = true;
  setStatus('dispatching…');

  const headers = await csrfHeaders();
  if (!headers) {
    btn.disabled = false;
    return;
  }
  const resp = await fetch(`/api/books/${encodeURIComponent(entry.book)}/reconvert`, {
    method: 'POST',
    credentials: 'include',
    headers,
  });
  if (!resp.ok) {
    btn.disabled = false;
    const body = await resp.json().catch(() => ({} as { message?: string }));
    setStatus(body.message ? `reconvert failed: ${body.message}` : `reconvert failed (${resp.status})`);
    return;
  }

  // Poll progress until the job lands, then reload the reader iframe.
  const poll = window.setInterval(() => {
    void (async () => {
      const p = await fetch(`/api/import-progress/${encodeURIComponent(entry.book)}`, { credentials: 'include' });
      if (!p.ok) return;
      const progress = await p.json() as { status?: string; percent?: number; stage?: string };
      setStatus(`${progress.status ?? '…'} ${progress.percent ?? 0}% ${progress.stage ?? ''}`);
      if (progress.status === 'complete' || progress.status === 'failed') {
        window.clearInterval(poll);
        btn.disabled = false;
        if (progress.status === 'complete') {
          setStatus('reconverted — reloading reader');
          const frame = el<HTMLIFrameElement>('mt-reader');
          frame.src = `/${entry.book}`;
        } else {
          setStatus('reconvert FAILED — see logs');
        }
      }
    })();
  }, 2500);
}

// ── Wiring ────────────────────────────────────────────────────────────────

el<HTMLButtonElement>('mt-flags-toggle').addEventListener('click', () => {
  const columns = el<HTMLDivElement>('mt-columns');
  const collapsed = columns.classList.toggle('mt-collapsed');
  el<HTMLButtonElement>('mt-flags-toggle').setAttribute('aria-expanded', String(!collapsed));
});

el<HTMLButtonElement>('mt-regressions-toggle').addEventListener('click', () => {
  regressionsOnly = !regressionsOnly;
  localStorage.setItem(REGRESSIONS_KEY, regressionsOnly ? '1' : '0');
  renderList();
  // If the selection was filtered out, jump to the first visible case.
  const shown = visibleEntries();
  if (regressionsOnly && selected && !shown.some((e) => e.book === selected!.book) && shown.length > 0) {
    select(shown[0]!);
  }
});

// Draggable action bar — the ⋮⋮ grip moves it anywhere (it can sit over
// content you need to see); position persists; double-click resets to the
// default bottom-center. Pointer capture keeps the drag alive over iframes
// (plus body.mt-dragging kills their pointer-events as a belt).
const ACTIONS_POS_KEY = 'mt_actions_pos';
{
  const bar = el<HTMLDivElement>('mt-actions');
  const grip = el<HTMLSpanElement>('mt-actions-grip');

  const place = (x: number, y: number): void => {
    const w = bar.offsetWidth || 300;
    const h = bar.offsetHeight || 46;
    const left = Math.min(Math.max(4, x), window.innerWidth - w - 4);
    const top = Math.min(Math.max(4, y), window.innerHeight - h - 4);
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
    bar.style.bottom = 'auto';
    bar.style.transform = 'none';
  };

  try {
    const saved = localStorage.getItem(ACTIONS_POS_KEY);
    if (saved) {
      const pos = JSON.parse(saved) as { x: number; y: number };
      place(pos.x, pos.y);
    }
  } catch { /* corrupt saved position — default placement stands */ }

  let dragFrom: { px: number; py: number; bx: number; by: number } | null = null;
  grip.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    const rect = bar.getBoundingClientRect();
    dragFrom = { px: e.clientX, py: e.clientY, bx: rect.left, by: rect.top };
    document.body.classList.add('mt-dragging');
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragFrom) return;
    place(dragFrom.bx + (e.clientX - dragFrom.px), dragFrom.by + (e.clientY - dragFrom.py));
  });
  const endDrag = (): void => {
    if (!dragFrom) return;
    dragFrom = null;
    document.body.classList.remove('mt-dragging');
    const rect = bar.getBoundingClientRect();
    try {
      localStorage.setItem(ACTIONS_POS_KEY, JSON.stringify({ x: rect.left, y: rect.top }));
    } catch { /* storage full/blocked — position just won't persist */ }
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  grip.addEventListener('dblclick', () => {
    try { localStorage.removeItem(ACTIONS_POS_KEY); } catch { /* ignore */ }
    bar.style.left = '';
    bar.style.top = '';
    bar.style.bottom = '';
    bar.style.transform = '';
  });
}

// Workflow help panel (the ? button) — toggle, ✕, and Escape all close it.
const helpPanel = el<HTMLDivElement>('mt-help-panel');
const helpToggle = el<HTMLButtonElement>('mt-help-toggle');
const setHelp = (open: boolean): void => {
  helpPanel.hidden = !open;
  helpToggle.setAttribute('aria-expanded', String(open));
};
helpToggle.addEventListener('click', () => setHelp(!!helpPanel.hidden)); // hidden types as boolean|"until-found"
el<HTMLButtonElement>('mt-help-close').addEventListener('click', () => setHelp(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !helpPanel.hidden) setHelp(false);
});

// Two case kinds, two fix loops (see BookExport::KIND_*): `conversion` blames
// the converter and replays through run_regression.py; `harvest` blames
// acquisition and ships canonical_source + fetch_trace.json instead. Passing
// no kind lets book:export auto-detect from the book.
const downloadBundle = (kind?: 'conversion' | 'harvest'): void => {
  if (!selected) return;
  setStatus('building bundle…');
  const qs = kind ? `?kind=${kind}` : '';
  window.location.href = `/api/maintainer/conversion/export/${encodeURIComponent(selected.book)}${qs}`;
  // Optimistically mirror the server-side stamp so the ⤓ marker shows without
  // a queue refetch (the download navigation doesn't reload the page).
  if (kind && selected.flags.length > 0) {
    for (const flag of selected.flags) {
      flag.details = { ...flag.details, exported_kind: kind };
    }
    renderList();
  }
  window.setTimeout(() => setStatus(''), 4000);
};

el<HTMLButtonElement>('mt-export').addEventListener('click', () => downloadBundle('conversion'));
el<HTMLButtonElement>('mt-export-harvest').addEventListener('click', () => downloadBundle('harvest'));
el<HTMLButtonElement>('mt-reconvert').addEventListener('click', () => void reconvertSelected());
el<HTMLButtonElement>('mt-retract').addEventListener('click', () => void retractSelected());
el<HTMLButtonElement>('mt-resolve').addEventListener('click', () => void resolveSelected('reconverted'));
el<HTMLButtonElement>('mt-dismiss').addEventListener('click', () => void resolveSelected('dismissed'));

void loadQueue();
