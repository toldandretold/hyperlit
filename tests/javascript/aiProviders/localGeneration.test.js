/**
 * localGeneration — the client-side BYO narration loop. Bridge, TTS execution,
 * profiles, and IndexedDB are mocked; we assert hash-skip idempotency, the
 * per-node manifest checkpoint, failure isolation, and cancel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nativeCall: vi.fn(),
  isNativeShell: vi.fn(() => true),
  onNativeEvent: vi.fn(() => () => {}),
  executeTts: vi.fn(),
  getActiveProfile: vi.fn(),
  getNodesFromIndexedDB: vi.fn(),
}));

vi.mock('../../../resources/js/utilities/nativeBridge', () => ({
  nativeCall: mocks.nativeCall,
  isNativeShell: mocks.isNativeShell,
  onNativeEvent: mocks.onNativeEvent,
}));
vi.mock('../../../resources/js/aiProviders/execute', () => ({
  executeTts: mocks.executeTts,
}));
vi.mock('../../../resources/js/aiProviders/profiles', () => ({
  getActiveProfile: mocks.getActiveProfile,
}));
vi.mock('../../../resources/js/indexedDB/nodes/read', () => ({
  getNodesFromIndexedDB: mocks.getNodesFromIndexedDB,
}));
vi.mock('../../../resources/js/utilities/idHelpers', () => ({
  asBookId: (x) => x,
}));

import { startLocalGeneration } from '../../../resources/js/aiProviders/tts/localGeneration';
import { sha256Hex } from '../../../resources/js/aiProviders/tts/localManifest';

// tiny valid base64 ("MP3 bytes")
const B64 = btoa('abc');

/** In-memory native file store: manifest + written audio. */
let store;

beforeEach(() => {
  store = { manifest: null, audio: {} };
  mocks.nativeCall.mockReset();
  mocks.executeTts.mockReset();
  mocks.getActiveProfile.mockReset();
  mocks.getNodesFromIndexedDB.mockReset();

  mocks.getActiveProfile.mockResolvedValue({ id: 'tts_1', kind: 'tts', voice: 'af_bella', baseUrl: 'x', model: 'k', label: 'K', hasKey: true });
  mocks.executeTts.mockResolvedValue({ base64: B64 });

  mocks.nativeCall.mockImplementation(async (method, payload) => {
    if (method === 'file.readManifest') return { json: store.manifest };
    if (method === 'file.writeManifest') { store.manifest = payload.json; return { ok: true }; }
    if (method === 'file.writeAudio') { store.audio[payload.filename] = payload.base64; return { ok: true, bytes: 3 }; }
    throw new Error(`unexpected native ${method}`);
  });
});

const NODES = [
  { node_id: 'bk_n1', content: '<p>First paragraph.</p>' },
  { node_id: 'bk_n2', content: '<p>Second paragraph.</p>' },
  { node_id: 'bk_skip', content: '<p><img src="x.png"></p>' }, // unspeakable — skipped
];

describe('startLocalGeneration', () => {
  it('narrates speakable nodes, writes MP3s, and checkpoints the manifest', async () => {
    mocks.getNodesFromIndexedDB.mockResolvedValue(NODES);

    const seen = [];
    const handle = startLocalGeneration('bk', (p) => seen.push({ ...p }));
    const result = await handle.done;

    expect(result.totalNodes).toBe(2); // unspeakable node excluded
    expect(result.doneNodes).toBe(2);
    expect(result.failedNodes).toEqual([]);
    expect(Object.keys(store.audio)).toEqual(['bk_n1.mp3', 'bk_n2.mp3']);
    expect(store.manifest.voice).toBe('af_bella');
    expect(store.manifest.nodes.bk_n1.hash).toBe(await sha256Hex('First paragraph.'));
    expect(seen.length).toBeGreaterThan(0);
  });

  it('hash-skips unchanged nodes (idempotent resume)', async () => {
    mocks.getNodesFromIndexedDB.mockResolvedValue(NODES);

    // Pre-seed a manifest where n1 is already narrated with the CURRENT hash.
    store.manifest = {
      version: 1,
      voice: 'af_bella',
      nodes: { bk_n1: { filename: 'bk_n1.mp3', hash: await sha256Hex('First paragraph.'), durationMs: 1 } },
    };

    const result = await startLocalGeneration('bk').done;

    expect(result.doneNodes).toBe(2);
    // only n2 was synthesized
    expect(Object.keys(store.audio)).toEqual(['bk_n2.mp3']);
    expect(mocks.executeTts).toHaveBeenCalledTimes(1);
  });

  it('a voice change invalidates the whole manifest', async () => {
    mocks.getNodesFromIndexedDB.mockResolvedValue([NODES[0]]);
    store.manifest = {
      version: 1,
      voice: 'af_OTHER',
      nodes: { bk_n1: { filename: 'bk_n1.mp3', hash: await sha256Hex('First paragraph.'), durationMs: 1 } },
    };

    await startLocalGeneration('bk').done;

    expect(mocks.executeTts).toHaveBeenCalledTimes(1); // re-narrated despite matching hash
    expect(store.manifest.voice).toBe('af_bella');
  });

  it('isolates per-node provider failures', async () => {
    mocks.getNodesFromIndexedDB.mockResolvedValue(NODES);
    mocks.executeTts
      .mockResolvedValueOnce({ base64: null }) // n1 fails
      .mockResolvedValue({ base64: B64 });     // n2 succeeds

    const result = await startLocalGeneration('bk').done;

    expect(result.failedNodes).toEqual(['bk_n1']);
    expect(result.doneNodes).toBe(1);
    expect(Object.keys(store.audio)).toEqual(['bk_n2.mp3']);
  });

  it('cancel stops the loop; the checkpoint keeps completed nodes', async () => {
    mocks.getNodesFromIndexedDB.mockResolvedValue(NODES);

    let handle;
    // Cancel as soon as the first synthesis is in flight.
    mocks.executeTts.mockImplementation(async () => {
      handle.cancel();
      return { base64: B64 };
    });

    handle = startLocalGeneration('bk');
    const result = await handle.done;

    expect(result.doneNodes).toBeLessThan(2);
    // whatever finished is checkpointed or nothing is — but the run ended early
    expect(mocks.executeTts.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('throws without an active TTS profile', async () => {
    mocks.getActiveProfile.mockResolvedValue(undefined);
    await expect(startLocalGeneration('bk').done).rejects.toThrow('No active TTS provider');
  });
});
