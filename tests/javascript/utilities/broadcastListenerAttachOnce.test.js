/**
 * Regression test for resources/js/utilities/BroadcastListener.ts
 *
 * Bug it locks down: universalPageInitializer() calls initializeBroadcastListener()
 * on EVERY SPA navigation. Without an attach-once guard, each nav stacked another
 * BroadcastChannel("node-updates") + message listener that was never removed — an
 * unbounded leak, and every incoming broadcast then fired updateDomNode() once per
 * navigation this session (N innerHTML re-renders per node). This pins "attach exactly
 * one node-updates channel/listener no matter how many times init is called."
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../resources/js/app', () => ({ book: 'book_test' }));
vi.mock('../../../resources/js/lazyLoader/chunkRender', () => ({
  applyHypercites: (h) => h,
  applyHighlights: (h) => h,
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setProgrammaticUpdateInProgress: vi.fn(),
}));
vi.mock('../../../resources/js/indexedDB/core/connection.js', () => ({
  openDatabase: vi.fn(),
}));

// Count node-updates channels + their message listeners.
let nodeUpdatesChannels = 0;
let nodeUpdatesListeners = 0;

class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    if (name === 'node-updates') nodeUpdatesChannels++;
  }
  addEventListener(type) {
    if (this.name === 'node-updates' && type === 'message') nodeUpdatesListeners++;
  }
  postMessage() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  nodeUpdatesChannels = 0;
  nodeUpdatesListeners = 0;
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  vi.resetModules();
});

describe('initializeBroadcastListener — attach-once', () => {
  it('attaches exactly one node-updates listener across many SPA navigations', async () => {
    const { initializeBroadcastListener } = await import('../../../resources/js/utilities/BroadcastListener');

    // Simulate ten SPA navigations, each of which re-runs page init.
    for (let i = 0; i < 10; i++) initializeBroadcastListener();

    expect(nodeUpdatesChannels).toBe(1);
    expect(nodeUpdatesListeners).toBe(1);
  });
});
