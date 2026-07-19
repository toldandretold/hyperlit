/**
 * /maintainer — the triage page's wiring (standalone, non-SPA, admin-only;
 * see MaintainerController). Left: the open-flag queue; middle: the flagged
 * book in the REAL reader (same-origin iframe); right: the original source
 * file; bottom: dev-bundle / reconvert / resolve / dismiss actions.
 */

import { log } from '../utilities/logger';

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
  const resp = await fetch('/api/maintainer/flags', { credentials: 'include' });
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
  history.replaceState(null, '', `/maintainer?book=${encodeURIComponent(entry.book)}`);

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
  const originalUrl = `/api/maintainer/original/${encodeURIComponent(entry.book)}`;
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

async function resolveSelected(resolution: 'reconverted' | 'dismissed'): Promise<void> {
  if (!selected) return;
  const resp = await fetch(`/api/maintainer/flags/${encodeURIComponent(selected.book)}/resolve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
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

  const resp = await fetch(`/api/books/${encodeURIComponent(entry.book)}/reconvert`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
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

el<HTMLButtonElement>('mt-export').addEventListener('click', () => {
  if (!selected) return;
  setStatus('building bundle…');
  window.location.href = `/api/maintainer/export/${encodeURIComponent(selected.book)}`;
  window.setTimeout(() => setStatus(''), 4000);
});
el<HTMLButtonElement>('mt-reconvert').addEventListener('click', () => void reconvertSelected());
el<HTMLButtonElement>('mt-resolve').addEventListener('click', () => void resolveSelected('reconverted'));
el<HTMLButtonElement>('mt-dismiss').addEventListener('click', () => void resolveSelected('dismissed'));

void loadQueue();
