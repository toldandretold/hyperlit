// Import-queue poller: ONE aggregate poll of /api/my-imports for ALL of the
// user's in-flight imports (the per-book pollers that used to run in parallel
// are what starved the throttle bucket). Module-level singleton: the STATE
// survives SPA navigation (replaceBodyContent destroys DOM, never modules);
// the widget DOM is rebuilt from this state by initImportQueue on each
// home/user page entry.
//
// Poll-gate discipline: we must not hit /api/my-imports on every page load for
// every user forever. A localStorage hint is set when polling starts (batch
// created / active batches seen) and cleared when the server reports nothing
// active — page entry only triggers a poll when the hint is set (same spirit
// as checkPendingVibeReview).

import { verbose } from '../../utilities/logger';
import { onCancelAllImportPolls } from '../../utilities/importPollRegistry';

export interface ImportQueueItem {
  book: string;
  title: string | null;
  filename: string | null;
  position: number;
  status: 'pending_upload' | 'upload_failed' | 'queued' | 'processing' | 'complete' | 'failed';
  percent: number | null;
  stage: string | null;
  detail: string | null;
  error: string | null;
}

export interface ImportQueueShelf {
  id: string;
  name: string;
  slug: string;
  creator?: string;
}

export interface ImportQueueBatch {
  id: string;
  label: string;
  source: string;
  notify_email: boolean;
  shelf: ImportQueueShelf | null;
  counts: Record<string, number>;
  items: ImportQueueItem[];
  created_at: string | null;
}

export interface ImportQueueState {
  batches: ImportQueueBatch[];
  queue: { waiting_for_turn: boolean; jobs_ahead: number };
}

type Subscriber = (state: ImportQueueState | null) => void;

const HINT_KEY = 'hyperlit_active_imports';
const POLL_MS = 2500;
const MAX_FAILURES = 20;

let state: ImportQueueState | null = null;
let polling = false;
const subscribers = new Set<Subscriber>();

// Books whose import is currently shown by the in-form card — a batch whose
// items are ALL claimed is hidden from the widget to avoid double UI. Claims
// are released when the card restores/closes (or the container close path
// fires cancelAllImportPolls).
const claimedBooks = new Set<string>();

// Batches observed with LIVE items during THIS page session. The server keeps
// terminal batches visible for 48h (so a mid-import reload can resume), but
// the widget must not resurrect yesterday's finished, undismissed batches into
// today's counts — "Importing 1/2" would read "Importing 3/8". A terminal
// batch stays visible only if we watched it run.
const sessionActiveBatches = new Set<string>();

const ACTIVE_STATUSES = new Set(['pending_upload', 'queued', 'processing']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function setHint(on: boolean): void {
  try {
    if (on) localStorage.setItem(HINT_KEY, '1');
    else localStorage.removeItem(HINT_KEY);
  } catch { /* private mode */ }
}

function hasHint(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function hasActive(s: ImportQueueState | null): boolean {
  return !!s && s.batches.some((b) => b.items.some((i) => ACTIVE_STATUSES.has(i.status)));
}

function notifySubscribers(): void {
  for (const cb of subscribers) {
    try { cb(state); } catch { /* renderer errors must not kill the loop */ }
  }
}

async function fetchState(): Promise<'ok' | 'auth' | 'error' | 'throttled'> {
  const resp = await fetch('/api/my-imports', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (resp.status === 401 || resp.status === 403) return 'auth';
  if (resp.status === 429) return 'throttled';
  if (!resp.ok) return 'error';
  state = (await resp.json()) as ImportQueueState;
  for (const batch of state.batches) {
    if (batch.items.some((i) => ACTIVE_STATUSES.has(i.status))) {
      sessionActiveBatches.add(batch.id);
    }
  }
  return 'ok';
}

async function loop(): Promise<void> {
  let failures = 0;
  while (polling) {
    let outcome: 'ok' | 'auth' | 'error' | 'throttled';
    try {
      outcome = await fetchState();
    } catch {
      outcome = 'error';
    }

    if (outcome === 'auth') {
      polling = false;
      setHint(false);
      break;
    }
    if (outcome === 'throttled') {
      await sleep(10_000);
      continue;
    }
    if (outcome === 'error') {
      failures++;
      if (failures > MAX_FAILURES) {
        verbose.content('importQueue: giving up polling after repeated failures', '/components/importQueue/importQueuePoller.ts');
        polling = false;
        break;
      }
      await sleep(Math.min(10_000, 3000 + failures * 1000));
      continue;
    }

    failures = 0;
    notifySubscribers();

    if (!hasActive(state)) {
      // Nothing live: stop polling and clear the page-entry hint. Terminal
      // batches stay in `state` so the done-summary keeps rendering.
      polling = false;
      setHint(false);
      break;
    }
    await sleep(POLL_MS);
  }
}

/** Start (or continue) the aggregate poll loop. Idempotent. */
export function startImportQueuePolling(): void {
  setHint(true);
  if (polling) return;
  polling = true;
  void loop();
}

/** One-shot refresh (after notify/dismiss clicks) that respects a running loop. */
export async function refreshImportQueue(): Promise<void> {
  if (polling) return; // the loop will pick it up within POLL_MS
  try {
    if ((await fetchState()) === 'ok') {
      notifySubscribers();
      if (hasActive(state)) startImportQueuePolling();
    }
  } catch { /* transient — next explicit action retries */ }
}

/** Page-entry hook: poll only when the hint says there may be live imports. */
export function initImportQueuePollingFromHint(): void {
  if (hasHint()) startImportQueuePolling();
}

export function getImportQueueState(): ImportQueueState | null {
  return state;
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribeImportQueue(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** The in-form card owns this book's UI — hide its batch from the widget. */
export function claimCardBook(book: string): void {
  claimedBooks.add(book);
  notifySubscribers();
}

/** The in-form card is gone; if the import still runs, the widget takes over. */
export function releaseCardBook(book: string): void {
  if (!claimedBooks.delete(book)) return;
  notifySubscribers();
  startImportQueuePolling();
}

/** A batch is widget-visible unless every one of its items is card-claimed. */
export function isBatchClaimed(batch: ImportQueueBatch): boolean {
  return batch.items.length > 0 && batch.items.every((i) => claimedBooks.has(i.book));
}

/**
 * Widget-relevant = has live items now, or ran during this page session (its
 * done-summary stays up until dismissed/navigated). Stale terminal batches
 * from earlier sessions are excluded — see sessionActiveBatches.
 */
export function isBatchRelevant(batch: ImportQueueBatch): boolean {
  return batch.items.some((i) => ACTIVE_STATUSES.has(i.status))
    || sessionActiveBatches.has(batch.id);
}

// Container-close path: the in-form card was destroyed with the container.
onCancelAllImportPolls(() => {
  if (claimedBooks.size === 0) return;
  claimedBooks.clear();
  notifySubscribers();
  startImportQueuePolling();
});
