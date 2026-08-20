// Import-queue poller: the module singleton behind the corner widget. Pins:
//  - one aggregate poll loop, stops (and clears the localStorage hint) when
//    the server reports nothing active;
//  - page-entry gate: initImportQueuePollingFromHint polls ONLY when the
//    hint is set;
//  - claim/release: a batch whose every item is card-claimed is hidden
//    (isBatchClaimed), released books re-enter the widget and polling restarts;
//  - auth responses (401) stop polling and clear the hint.
//
// Module state is a singleton, so each test re-imports a fresh copy.

import { describe, test, expect, vi, beforeEach } from 'vitest';

const HINT_KEY = 'hyperlit_active_imports';

const stateWith = (items, queue = { waiting_for_turn: false, jobs_ahead: 0 }) => ({
  batches: [{
    id: 'b1', label: 'test', source: 'files', notify_email: false, shelf: null,
    counts: {}, items, created_at: null,
  }],
  queue,
});

const item = (book, status) => ({
  book, title: book, filename: null, position: 0, status,
  percent: null, stage: null, detail: null, error: null,
});

async function freshPoller() {
  vi.resetModules();
  return import('../../../resources/js/components/importQueue/importQueuePoller');
}

function mockFetchSequence(responses) {
  let call = 0;
  globalThis.fetch = vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    if (r.status) return { ok: false, status: r.status };
    return { ok: true, status: 200, json: async () => r.body };
  });
  return () => call;
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('importQueuePoller', () => {
  test('stops and clears the hint when nothing is active', async () => {
    const poller = await freshPoller();
    mockFetchSequence([{ body: stateWith([item('done1', 'complete')]) }]);

    poller.startImportQueuePolling();
    expect(localStorage.getItem(HINT_KEY)).toBe('1');

    await vi.waitFor(() => {
      expect(localStorage.getItem(HINT_KEY)).toBeNull();
    });
    // State survives for the done-summary render.
    expect(poller.getImportQueueState().batches).toHaveLength(1);
  });

  test('initImportQueuePollingFromHint is a no-op without the hint', async () => {
    const poller = await freshPoller();
    const calls = mockFetchSequence([{ body: stateWith([]) }]);

    poller.initImportQueuePollingFromHint();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toBe(0);

    localStorage.setItem(HINT_KEY, '1');
    poller.initImportQueuePollingFromHint();
    await vi.waitFor(() => expect(calls()).toBeGreaterThan(0));
  });

  test('401 stops polling and clears the hint', async () => {
    const poller = await freshPoller();
    const calls = mockFetchSequence([{ status: 401 }]);

    poller.startImportQueuePolling();
    await vi.waitFor(() => expect(localStorage.getItem(HINT_KEY)).toBeNull());
    expect(calls()).toBe(1);
  });

  test('claimed batches are hidden until released', async () => {
    const poller = await freshPoller();
    mockFetchSequence([{ body: stateWith([item('bookA', 'processing')]) }]);

    poller.claimCardBook('bookA');
    poller.startImportQueuePolling();
    await vi.waitFor(() => expect(poller.getImportQueueState()).not.toBeNull());

    const batch = poller.getImportQueueState().batches[0];
    expect(poller.isBatchClaimed(batch)).toBe(true);

    poller.releaseCardBook('bookA');
    expect(poller.isBatchClaimed(batch)).toBe(false);
  });

  test('stale terminal batches from earlier sessions are not relevant; watched ones are', async () => {
    const poller = await freshPoller();
    // First poll returns a batch that is ALREADY terminal (finished in some
    // earlier session, still inside the server's 48h retention window).
    mockFetchSequence([{ body: stateWith([item('old', 'complete')]) }]);
    poller.startImportQueuePolling();
    await vi.waitFor(() => expect(poller.getImportQueueState()).not.toBeNull());
    expect(poller.isBatchRelevant(poller.getImportQueueState().batches[0])).toBe(false);

    // A batch seen with LIVE items stays relevant after it completes.
    const poller2 = await freshPoller();
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      const body = call === 1
        ? stateWith([item('bookX', 'processing')])
        : stateWith([item('bookX', 'complete')]);
      return { ok: true, status: 200, json: async () => body };
    });
    poller2.startImportQueuePolling();
    await vi.waitFor(() => {
      const s = poller2.getImportQueueState();
      expect(s?.batches[0]?.items[0]?.status).toBe('complete');
    }, { timeout: 10_000 });
    expect(poller2.isBatchRelevant(poller2.getImportQueueState().batches[0])).toBe(true);
  });

  test('subscribers are notified with fresh state', async () => {
    const poller = await freshPoller();
    mockFetchSequence([{ body: stateWith([item('done', 'complete')]) }]);

    const seen = [];
    poller.subscribeImportQueue((s) => seen.push(s));
    poller.startImportQueuePolling();

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0].batches[0].items[0].book).toBe('done');
  });
});
