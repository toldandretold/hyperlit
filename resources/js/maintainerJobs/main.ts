/**
 * /maintainer/jobs — job-failure triage wiring (standalone, non-SPA,
 * admin-only; see Maintainer\JobsController). Failures arrive already GROUPED
 * by job class + normalised exception, because the whole point of the page is
 * that 87 rows are usually 5 bugs. Per group: forget, retry, or pull a case
 * bundle for a dev machine.
 */

import { log } from '../utilities/logger';
import { ensureCsrfToken } from '../utilities/auth/csrf';

interface FailureGroup {
  key: string;
  job_class: string;
  job_name: string;
  queue: string;
  message: string;
  count: number;
  first_seen: string;
  last_seen: string;
  books: string[];
  paid: boolean;
  is_new: boolean;
}

interface QueueDepth {
  queue: string;
  pending: number;
  oldest_reserved: number | null;
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let groups: FailureGroup[] = [];

// ── Status line ───────────────────────────────────────────────────────────

let statusTimer: number | undefined;

function setStatus(text: string): void {
  const node = el<HTMLDivElement>('mj-status');
  node.textContent = text;
  node.classList.add('mj-visible');
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => node.classList.remove('mj-visible'), 4000);
}

async function csrfHeaders(): Promise<Record<string, string> | null> {
  const token = await ensureCsrfToken();
  if (!token) {
    setStatus('session error — refresh and retry');
    return null;
  }
  return { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' };
}

// ── Load ──────────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  const resp = await fetch('/api/maintainer/jobs/failures', { credentials: 'include' });
  if (!resp.ok) {
    log.error(`Job failure fetch failed (${resp.status})`, 'maintainer-jobs');
    setStatus(`could not load failures (${resp.status})`);
    return;
  }

  const data = await resp.json();
  groups = (data.groups ?? []) as FailureGroup[];
  renderQueues((data.queues ?? []) as QueueDepth[]);
  if (data.workers_hint) el<HTMLElement>('mj-workers-hint').textContent = data.workers_hint;
  renderGroups();
}

function renderQueues(queues: QueueDepth[]): void {
  const list = el<HTMLDivElement>('mj-queues-list');
  list.textContent = '';

  if (queues.length === 0) {
    const idle = document.createElement('div');
    idle.className = 'mj-queue mj-idle';
    idle.textContent = 'all queues idle';
    list.appendChild(idle);
    return;
  }

  for (const q of queues) {
    const box = document.createElement('div');
    box.className = 'mj-queue';

    const name = document.createElement('span');
    name.className = 'mj-queue-name';
    name.textContent = q.queue;

    const count = document.createElement('span');
    count.className = 'mj-queue-count';
    count.textContent = `${q.pending} waiting`;

    box.append(name, count);
    if (q.oldest_reserved) {
      const held = document.createElement('span');
      held.className = 'mj-queue-name';
      held.textContent = ` · oldest reserved ${new Date(q.oldest_reserved * 1000).toLocaleTimeString()}`;
      box.appendChild(held);
    }
    list.appendChild(box);
  }
}

function renderGroups(): void {
  const list = el<HTMLDivElement>('mj-groups-list');
  list.textContent = '';
  el<HTMLParagraphElement>('mj-groups-empty').hidden = groups.length > 0;

  const total = groups.reduce((n, g) => n + g.count, 0);
  const fresh = groups.filter((g) => g.is_new).length;
  el<HTMLElement>('mj-summary').textContent = groups.length === 0
    ? 'nothing failed'
    : `${groups.length} group${groups.length === 1 ? '' : 's'} · ${total} failure${total === 1 ? '' : 's'}${fresh ? ` · ${fresh} new` : ''}`;

  for (const group of groups) {
    list.appendChild(renderGroup(group));
  }
}

function renderGroup(group: FailureGroup): HTMLElement {
  const box = document.createElement('div');
  box.className = group.is_new ? 'mj-group mj-new' : 'mj-group';
  box.setAttribute('role', 'listitem');

  const top = document.createElement('div');
  top.className = 'mj-group-top';

  const job = document.createElement('span');
  job.className = 'mj-group-job';
  job.textContent = group.job_name;

  const count = document.createElement('span');
  count.className = 'mj-count';
  count.textContent = `×${group.count}`;

  top.append(job, count);

  if (group.is_new) {
    const badge = document.createElement('span');
    badge.className = 'mj-badge mj-badge-new';
    badge.textContent = 'new';
    top.appendChild(badge);
  }
  if (group.paid) {
    const badge = document.createElement('span');
    badge.className = 'mj-badge mj-badge-paid';
    badge.title = 'Retrying re-runs billable API work';
    badge.textContent = 'paid';
    top.appendChild(badge);
  }

  const when = document.createElement('span');
  when.className = 'mj-group-when';
  when.textContent = group.first_seen === group.last_seen
    ? `${group.queue} · ${group.last_seen}`
    : `${group.queue} · ${group.first_seen} → ${group.last_seen}`;
  top.appendChild(when);

  const msg = document.createElement('p');
  msg.className = 'mj-group-msg';
  msg.textContent = group.message;

  box.append(top, msg);

  if (group.books.length > 0) {
    const books = document.createElement('p');
    books.className = 'mj-group-books';
    books.appendChild(document.createTextNode('books: '));
    group.books.slice(0, 8).forEach((book, i) => {
      if (i > 0) books.appendChild(document.createTextNode(', '));
      const link = document.createElement('a');
      link.href = `/${book}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = book;
      books.appendChild(link);
    });
    if (group.books.length > 8) {
      books.appendChild(document.createTextNode(` +${group.books.length - 8} more`));
    }
    box.appendChild(books);
  }

  box.appendChild(renderActions(group));

  return box;
}

function renderActions(group: FailureGroup): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'mj-group-actions';

  const bundle = document.createElement('button');
  bundle.type = 'button';
  bundle.textContent = '⤓ case bundle';
  bundle.title = 'Download trace + payloads + worker log for a dev machine';
  bundle.addEventListener('click', () => {
    setStatus('building bundle…');
    window.location.href = `/api/maintainer/jobs/${group.key}/export`;
  });

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '↻ retry';
  retry.addEventListener('click', () => void retryGroup(group, retry));

  const forget = document.createElement('button');
  forget.type = 'button';
  forget.textContent = '✕ forget';
  forget.addEventListener('click', () => void forgetGroup(group, forget));

  actions.append(bundle, retry, forget);

  return actions;
}

// ── Actions ───────────────────────────────────────────────────────────────

async function retryGroup(group: FailureGroup, btn: HTMLButtonElement): Promise<void> {
  // Paid classes re-run real billable work — make that an explicit decision,
  // never a stray click. The server enforces this too (422 without the flag).
  if (group.paid && !window.confirm(
    `${group.job_name} does paid work (external API charged to the user).\n\n`
    + `Retrying ${group.count} job${group.count === 1 ? '' : 's'} runs — and charges — that work again.\n\nContinue?`,
  )) {
    return;
  }

  const headers = await csrfHeaders();
  if (!headers) return;

  btn.disabled = true;
  setStatus('re-queueing…');

  const resp = await fetch(`/api/maintainer/jobs/${group.key}/retry`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_paid: group.paid }),
  });

  if (!resp.ok) {
    btn.disabled = false;
    const body = await resp.json().catch(() => ({}));
    setStatus(body.message ?? `retry failed (${resp.status})`);
    return;
  }

  const { retried } = await resp.json();
  setStatus(`re-queued ${retried} job${retried === 1 ? '' : 's'} — watch the worker log`);
  await load();
}

async function forgetGroup(group: FailureGroup, btn: HTMLButtonElement): Promise<void> {
  if (!window.confirm(
    `Forget ${group.count} × ${group.job_name}?\n\nThis deletes those failed_jobs rows. The work does not get re-run.`,
  )) {
    return;
  }

  const headers = await csrfHeaders();
  if (!headers) return;

  btn.disabled = true;

  const resp = await fetch(`/api/maintainer/jobs/${group.key}`, {
    method: 'DELETE',
    credentials: 'include',
    headers,
  });

  if (!resp.ok) {
    btn.disabled = false;
    setStatus(`forget failed (${resp.status})`);
    return;
  }

  const { forgotten } = await resp.json();
  groups = groups.filter((g) => g.key !== group.key);
  renderGroups();
  setStatus(`forgot ${forgotten} row${forgotten === 1 ? '' : 's'}`);
}

async function markSeen(): Promise<void> {
  const headers = await csrfHeaders();
  if (!headers) return;

  const resp = await fetch('/api/maintainer/jobs/seen', {
    method: 'POST',
    credentials: 'include',
    headers,
  });
  if (!resp.ok) {
    setStatus(`could not save (${resp.status})`);
    return;
  }

  groups = groups.map((g) => ({ ...g, is_new: false }));
  renderGroups();
  setStatus('marked seen — next visit highlights only what is new');
}

// ── Help panel ────────────────────────────────────────────────────────────

function wireHelp(): void {
  const panel = el<HTMLDivElement>('mj-help-panel');
  const toggle = el<HTMLButtonElement>('mj-help-toggle');

  const setOpen = (open: boolean): void => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) el<HTMLButtonElement>('mj-help-close').focus();
    else toggle.focus();
  };

  // `hidden` is boolean | "until-found" in lib.dom — coerce, don't assume.
  toggle.addEventListener('click', () => setOpen(Boolean(panel.hidden)));
  el<HTMLButtonElement>('mj-help-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────

el<HTMLButtonElement>('mj-mark-seen').addEventListener('click', () => void markSeen());
wireHelp();
void load();
