/**
 * Shared fixtures for the PlaybackController specs.
 *
 * The IndexedDB read is controlled through globals rather than a closure so the
 * `vi.mock` factory in each spec (which is hoisted above every import) can reach
 * it: set `globalThis.__idbNodes` for the happy path, or `globalThis.__idbHook`
 * for one that rejects / returns a partial read.
 */
import { vi } from 'vitest';

/** N nodes in reading order, ids shaped like the real ones. */
export function makeNodes(count) {
  return Array.from({ length: count }, (_, i) => ({
    node_id: `book_1_node_${i}`,
    startLine: 100 + i,
  }));
}

export function makeManifest(nodes) {
  const manifestNodes = {};
  nodes.forEach((node, i) => {
    manifestNodes[node.node_id] = { filename: `n${i}.mp3`, duration_ms: 400, stale: false };
  });

  return { voice: null, nodes: manifestNodes };
}

/** Real elements so applyHighlight/findElement resolve by id (and never reach
 *  the CSS.escape fallback, which happy-dom may not provide). */
export function seedDom(nodes) {
  document.body.innerHTML = '';
  const chunk = document.createElement('div');
  chunk.className = 'chunk';
  for (const node of nodes) {
    const el = document.createElement('p');
    el.id = String(node.startLine);
    el.setAttribute('data-node-id', node.node_id);
    chunk.appendChild(el);
  }
  document.body.appendChild(chunk);
}

export function makeCallbacks() {
  return {
    onStateChange: vi.fn(),
    onEntryChange: vi.fn(),
    onFollowModeChange: vi.fn(),
    onFinished: vi.fn(),
    onAutoplayBlocked: vi.fn(),
  };
}

/** Point the mocked IndexedDB read at these nodes. */
export function useIdbNodes(nodes) {
  globalThis.__idbNodes = nodes;
  globalThis.__idbHook = null;
}

/** Take over the next reads: `hook()` returns the node list (or throws). */
export function useIdbHook(hook) {
  globalThis.__idbHook = hook;
}

export function resetIdb() {
  globalThis.__idbNodes = [];
  globalThis.__idbHook = null;
}

/** Drain pending microtasks + the macrotask queue (real timers). */
export async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

export function traceEvents(trace, event) {
  return trace.filter((entry) => entry.event === event);
}
