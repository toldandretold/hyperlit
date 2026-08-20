// Import-queue widget: a fixed corner pill ("Importing 2/7…" / "Waiting in
// queue — 3 ahead") that expands to a per-item panel with a progress bar on
// the processing import, queued items below, and batch actions (email me when
// done / view shelf / dismiss).
//
// Registered through ButtonRegistry (pages: ['home','user']) — the DOM is
// rebuilt from the module-singleton poller state on every page entry, because
// cross-template SPA navs replace document.body wholesale. NON-modal by
// design: no focus trap; the pill is a real <button aria-expanded>, Escape
// collapses and returns focus to it. Class names deliberately avoid the
// overlay-gate patterns (-overlay|-backdrop|-modal|-sheet|-menu).

import { verbose } from '../../utilities/logger';
import { importStageLabel } from '../../utilities/importStageLabels';
import {
  getImportQueueState,
  initImportQueuePollingFromHint,
  isBatchClaimed,
  isBatchRelevant,
  refreshImportQueue,
  subscribeImportQueue,
  type ImportQueueBatch,
  type ImportQueueItem,
  type ImportQueueState,
} from './importQueuePoller';

const ROOT_ID = 'import-queue-root';

let unsubscribe: (() => void) | null = null;
let expanded = false;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

// Set while a batch is being REGISTERED (book-id probes + the create POST +
// the first poll) so the widget shows instantly on drop, already expanded,
// instead of a "look at the corner" hint card. Cleared the moment real batch
// rows arrive (or the registration fails).
let preparingCount: number | null = null;
let preparingError: string | null = null;

function csrfToken(): string {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta instanceof HTMLMetaElement ? meta.content : '';
}

async function postAction(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-CSRF-TOKEN': csrfToken() },
      credentials: 'include',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function visibleBatches(state: ImportQueueState | null): ImportQueueBatch[] {
  if (!state) return [];
  return state.batches.filter((b) => isBatchRelevant(b) && !isBatchClaimed(b));
}

function totals(batches: ImportQueueBatch[]): { total: number; done: number; failed: number; active: number } {
  let total = 0;
  let done = 0;
  let failed = 0;
  let active = 0;
  for (const b of batches) {
    for (const i of b.items) {
      total++;
      if (i.status === 'complete') done++;
      else if (i.status === 'failed' || i.status === 'upload_failed') failed++;
      else active++;
    }
  }
  return { total, done, failed, active };
}

function pillText(state: ImportQueueState, batches: ImportQueueBatch[]): string {
  const t = totals(batches);
  if (t.active === 0) {
    return t.failed > 0 ? `Imported ${t.done}/${t.total}` : `✓ ${t.done} imported`;
  }
  const anyProcessing = batches.some((b) => b.items.some((i) => i.status === 'processing'));
  if (!anyProcessing && state.queue.waiting_for_turn && state.queue.jobs_ahead > 0) {
    return `In queue — ${state.queue.jobs_ahead} ahead`;
  }
  return `Importing ${Math.min(t.done + t.failed + 1, t.total)}/${t.total}…`;
}

function itemStatusFragment(item: ImportQueueItem): HTMLElement {
  const status = document.createElement('div');
  status.className = 'import-queue-row-status';

  if (item.status === 'processing') {
    const label = document.createElement('span');
    label.textContent = importStageLabel(item.stage) || 'Processing…';
    const bar = document.createElement('div');
    bar.className = 'import-queue-bar';
    const fill = document.createElement('div');
    fill.className = 'import-queue-bar-fill';
    fill.style.width = `${Math.min(item.percent ?? 0, 100)}%`;
    bar.appendChild(fill);
    status.append(label, bar);
  } else if (item.status === 'queued') {
    status.textContent = 'Queued';
  } else if (item.status === 'pending_upload') {
    status.textContent = 'Uploading…';
  } else if (item.status === 'complete') {
    status.textContent = '✓ Done';
    status.classList.add('is-done');
  } else {
    status.textContent = item.error ? `✗ ${item.error}` : '✗ Failed';
    status.classList.add('is-failed');
    status.title = item.error || '';
  }

  return status;
}

function buildItemRow(item: ImportQueueItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'import-queue-row';
  row.dataset.status = item.status;

  const name = document.createElement('div');
  name.className = 'import-queue-row-name';
  if (item.status === 'complete') {
    const link = document.createElement('a');
    link.href = `/${item.book}`;
    link.textContent = item.title || item.filename || item.book;
    name.appendChild(link);
  } else {
    name.textContent = item.title || item.filename || item.book;
  }

  row.append(name, itemStatusFragment(item));
  return row;
}

function buildBatchSection(batch: ImportQueueBatch): HTMLElement {
  const section = document.createElement('div');
  section.className = 'import-queue-batch';

  const heading = document.createElement('div');
  heading.className = 'import-queue-batch-heading';
  heading.textContent = batch.label;
  section.appendChild(heading);

  for (const item of batch.items) {
    section.appendChild(buildItemRow(item));
  }

  const actions = document.createElement('div');
  actions.className = 'import-queue-actions';

  const activeLeft = batch.items.some((i) => ['pending_upload', 'queued', 'processing'].includes(i.status));

  if (activeLeft && !batch.notify_email) {
    const notifyBtn = document.createElement('button');
    notifyBtn.type = 'button';
    notifyBtn.className = 'import-queue-action';
    notifyBtn.textContent = 'Email me when done';
    notifyBtn.addEventListener('click', async () => {
      notifyBtn.disabled = true;
      const ok = await postAction(`/api/import-batches/${batch.id}/notify`);
      notifyBtn.textContent = ok ? "We'll email you." : 'Sign in to get emails';
      void refreshImportQueue();
    });
    actions.appendChild(notifyBtn);
  } else if (batch.notify_email && activeLeft) {
    const note = document.createElement('span');
    note.className = 'import-queue-note';
    note.textContent = "We'll email you when done.";
    actions.appendChild(note);
  }

  if (batch.shelf) {
    const shelfLink = document.createElement('a');
    shelfLink.className = 'import-queue-action';
    shelfLink.textContent = 'View shelf';
    shelfLink.href = batch.shelf.creator
      ? `/u/${encodeURIComponent(batch.shelf.creator)}/shelf/${encodeURIComponent(batch.shelf.slug || batch.shelf.id)}`
      : '#';
    // Shelf deep links need the user page's inline blade script
    // (window.activeShelfDeepLink) to run — full load, never SPA-routed.
    shelfLink.setAttribute('data-full-nav', '');
    actions.appendChild(shelfLink);
  }

  if (!activeLeft) {
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'import-queue-action';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', async () => {
      dismissBtn.disabled = true;
      await postAction(`/api/import-batches/${batch.id}/dismiss`);
      void refreshImportQueue();
      render(getImportQueueState());
    });
    actions.appendChild(dismissBtn);
  }

  if (actions.childElementCount > 0) {
    section.appendChild(actions);
  }

  return section;
}

/** Instant post-drop shell: pill + expanded panel with an indeterminate row. */
function renderPreparing(root: HTMLElement, count: number): void {
  root.hidden = false;
  root.innerHTML = '';

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'import-queue-pill';
  pill.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  pill.setAttribute('aria-controls', 'import-queue-panel');
  pill.textContent = preparingError
    ? 'Import failed to start'
    : `Importing ${count} text${count === 1 ? '' : 's'}…`;
  pill.addEventListener('click', () => setExpanded(!expanded));
  root.appendChild(pill);

  if (expanded) {
    const panel = document.createElement('div');
    panel.id = 'import-queue-panel';
    panel.className = 'import-queue-panel';

    const row = document.createElement('div');
    row.className = 'import-queue-row import-queue-preparing';
    const name = document.createElement('div');
    name.className = 'import-queue-row-name';
    const status = document.createElement('div');
    status.className = 'import-queue-row-status';

    if (preparingError) {
      name.textContent = 'Could not start the import';
      status.textContent = `✗ ${preparingError}`;
      status.classList.add('is-failed');

      const actions = document.createElement('div');
      actions.className = 'import-queue-actions';
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'import-queue-action';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.addEventListener('click', () => clearImportQueuePreparing());
      actions.appendChild(dismissBtn);
      row.append(name, status);
      panel.append(row, actions);
    } else {
      name.textContent = 'Preparing your imports…';
      const bar = document.createElement('div');
      bar.className = 'import-queue-bar';
      const fill = document.createElement('div');
      fill.className = 'import-queue-bar-fill is-indeterminate';
      bar.appendChild(fill);
      status.appendChild(bar);
      row.append(name, status);
      panel.appendChild(row);
    }
    root.appendChild(panel);
  }
}

/**
 * A batch drop just happened: show the widget NOW, panel expanded, so the
 * progress plays out in place instead of behind a "check the corner" card.
 * Returns false when this page hosts no widget (e.g. journal) — the caller
 * falls back to the drop-overlay message.
 */
export function showImportQueuePreparing(count: number): boolean {
  const root = document.getElementById(ROOT_ID);
  if (!root) return false;
  preparingCount = count;
  preparingError = null;
  expanded = true;
  render(getImportQueueState());
  return true;
}

/** Batch registration failed — swap the placeholder for a dismissible error. */
export function failImportQueuePreparing(message: string): void {
  if (preparingCount === null) return; // nothing pending — caller shows its own UI
  preparingError = message;
  expanded = true;
  render(getImportQueueState());
}

/** Drop the placeholder entirely (dismiss / caller shows its own error UI). */
export function clearImportQueuePreparing(): void {
  preparingCount = null;
  preparingError = null;
  render(getImportQueueState());
}

function setExpanded(on: boolean): void {
  expanded = on;
  render(getImportQueueState());
  if (!on) {
    const pill = document.querySelector('.import-queue-pill');
    if (pill instanceof HTMLElement) pill.focus();
  }
}

function render(state: ImportQueueState | null): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  const batches = visibleBatches(state);

  // Real rows have landed — the preparing placeholder has served its purpose.
  if (batches.length > 0) {
    preparingCount = null;
    preparingError = null;
  }

  if (batches.length === 0) {
    if (preparingCount !== null) {
      renderPreparing(root, preparingCount);
      return;
    }
    root.innerHTML = '';
    root.hidden = true;
    return;
  }
  if (!state) return; // unreachable (no batches without state) — for tsc

  root.hidden = false;
  root.innerHTML = '';

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'import-queue-pill';
  pill.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  pill.setAttribute('aria-controls', 'import-queue-panel');
  pill.textContent = pillText(state, batches);
  pill.addEventListener('click', () => setExpanded(!expanded));
  root.appendChild(pill);

  if (expanded) {
    const panel = document.createElement('div');
    panel.id = 'import-queue-panel';
    panel.className = 'import-queue-panel';

    if (state.queue.waiting_for_turn && state.queue.jobs_ahead > 0) {
      const waiting = document.createElement('div');
      waiting.className = 'import-queue-waiting';
      waiting.textContent = `Other imports are ahead of yours — ${state.queue.jobs_ahead} in the queue before your turn.`;
      panel.appendChild(waiting);
    }

    for (const batch of batches) {
      panel.appendChild(buildBatchSection(batch));
    }
    root.appendChild(panel);
  }
}

export function initImportQueue(): void {
  destroyImportQueue();

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.hidden = true;
  document.body.appendChild(root);

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && expanded) {
      const root = document.getElementById(ROOT_ID);
      if (root && !root.hidden) {
        e.stopPropagation();
        setExpanded(false);
      }
    }
  };
  document.addEventListener('keydown', keydownHandler);

  unsubscribe = subscribeImportQueue((state) => render(state));
  render(getImportQueueState());
  initImportQueuePollingFromHint();

  verbose.init('Import queue widget initialized', '/components/importQueue/importQueue.ts');
}

export function destroyImportQueue(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  document.getElementById(ROOT_ID)?.remove();
}
