/**
 * aiProviders/ticketWorker — the BYO claim→execute→complete loop for pipeline
 * features. fetch + executeTicketRequest are mocked; we assert the loop claims,
 * executes concurrently, posts completions (content or {error}), and stops.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const exec = vi.hoisted(() => ({
  executeTicketRequest: vi.fn(),
}));
vi.mock('../../../resources/js/aiProviders/execute', () => exec);

import { startTicketWorker } from '../../../resources/js/aiProviders/ticketWorker';

/** fetch stub routing /claim and /complete; records completes. */
let claimQueue; // array of ticket arrays, shifted per claim call
let completes;  // {id, body}[]

beforeEach(() => {
  claimQueue = [];
  completes = [];
  exec.executeTicketRequest.mockReset();

  document.head.innerHTML = '<meta name="csrf-token" content="t0k3n">';

  global.fetch = vi.fn(async (url, opts) => {
    if (String(url).includes('/api/inference/claim')) {
      const tickets = claimQueue.length ? claimQueue.shift() : [];
      return { ok: true, json: async () => ({ tickets }) };
    }
    const m = String(url).match(/\/api\/inference\/(.+)\/complete/);
    if (m) {
      completes.push({ id: m[1], body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ status: 'completed' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

/** Wait until a predicate holds (the loop is real-async). */
async function until(fn, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('startTicketWorker', () => {
  it('claims, executes, and completes tickets with content', async () => {
    claimQueue.push([
      { id: 'tk1', request: { messages: [] } },
      { id: 'tk2', request: { messages: [] } },
    ]);
    exec.executeTicketRequest.mockResolvedValue({ content: 'ANSWER', usage: null, model: 'llama3' });

    const seen = [];
    const worker = startTicketWorker({ feature: 'ai_review', contextId: 'pipe1', onProgress: (n) => seen.push(n) });

    await until(() => completes.length === 2);
    worker.stop();

    expect(completes.map((c) => c.id).sort()).toEqual(['tk1', 'tk2']);
    expect(completes[0].body.content).toBe('ANSWER');
    expect(completes[0].body.model).toBe('llama3');
    expect(seen).toEqual([2]);

    // claim body carried the feature + context
    const claimCall = global.fetch.mock.calls.find((c) => String(c[0]).includes('/claim'));
    expect(JSON.parse(claimCall[1].body)).toMatchObject({ feature: 'ai_review', context_id: 'pipe1' });
  });

  it('posts {error} when the provider fails, so the pipeline degrades fast', async () => {
    claimQueue.push([{ id: 'tkE', request: {} }]);
    exec.executeTicketRequest.mockResolvedValue({ content: null, model: 'x' });

    const worker = startTicketWorker({ feature: 'ai_review' });
    await until(() => completes.length === 1);
    worker.stop();

    expect(completes[0].body.error).toBeTruthy();
    expect(completes[0].body.content).toBeUndefined();
  });

  it('posts {error} when executeTicketRequest throws', async () => {
    claimQueue.push([{ id: 'tkT', request: {} }]);
    exec.executeTicketRequest.mockRejectedValue(new Error('boom'));

    const worker = startTicketWorker({ feature: 'ai_review' });
    await until(() => completes.length === 1);
    worker.stop();

    expect(completes[0].body.error).toContain('boom');
  });

  it('stop() ends the loop and reports not running', async () => {
    exec.executeTicketRequest.mockResolvedValue({ content: 'x', model: 'm' });
    const worker = startTicketWorker({ feature: 'ai_review' });
    expect(worker.isRunning()).toBe(true);
    worker.stop();
    expect(worker.isRunning()).toBe(false);
  });
});
