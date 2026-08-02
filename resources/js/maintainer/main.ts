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
      completeness: null, artifacts: [], suggested: 'inspect', flags: [] });
  }
}

function renderList(): void {
  const list = el<HTMLDivElement>('mt-flags-list');
  list.innerHTML = '';
  el<HTMLParagraphElement>('mt-flags-empty').hidden = entries.length > 0;

  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'mt-flag-item';
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;
    if (selected?.book === entry.book) item.classList.add('mt-selected');

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

  // Detail strip: why it's flagged.
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

  // Action bar.
  el<HTMLDivElement>('mt-actions').hidden = false;
  el<HTMLSpanElement>('mt-actions-book').textContent = entry.title;
  setStatus('');
}

function setStatus(text: string): void {
  el<HTMLSpanElement>('mt-actions-status').textContent = text;
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
  const gone = selected.book;
  entries = entries.filter((e) => e.book !== gone);
  selected = null;
  renderList();
  setStatus(`${resolution}: ${gone}`);
  if (entries.length > 0) {
    select(entries[0]!);
  } else {
    el<HTMLDivElement>('mt-actions').hidden = true;
  }
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
    setStatus(`reconvert failed (${resp.status})`);
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
  window.setTimeout(() => setStatus(''), 4000);
};

el<HTMLButtonElement>('mt-export').addEventListener('click', () => downloadBundle('conversion'));
el<HTMLButtonElement>('mt-export-harvest').addEventListener('click', () => downloadBundle('harvest'));
el<HTMLButtonElement>('mt-reconvert').addEventListener('click', () => void reconvertSelected());
el<HTMLButtonElement>('mt-resolve').addEventListener('click', () => void resolveSelected('reconverted'));
el<HTMLButtonElement>('mt-dismiss').addEventListener('click', () => void resolveSelected('dismissed'));

void loadQueue();
