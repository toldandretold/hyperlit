/**
 * aiProviders/profiles — the web layer's READ-ONLY view of the native-owned AI
 * provider config. The native bridge is mocked. We assert: no BYO outside the
 * shell, snapshot normalization + caching, cache invalidation on the
 * `providers_changed` event, and the derived active/BYO reads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.mock` is hoisted; the mock object must come from `vi.hoisted`. We also
// capture the `providers_changed` handler so tests can fire it.
const bridge = vi.hoisted(() => {
  let changedHandler = null;
  return {
    isNativeShell: vi.fn(() => true),
    nativeCall: vi.fn(() => Promise.resolve({ profiles: [], activeLlm: null, activeTts: null })),
    onNativeEvent: vi.fn((name, handler) => {
      if (name === 'providers_changed') changedHandler = handler;
      return () => {};
    }),
    fireChanged: () => changedHandler && changedHandler({}),
  };
});
vi.mock('../../../resources/js/utilities/nativeBridge', () => ({
  isNativeShell: bridge.isNativeShell,
  nativeCall: bridge.nativeCall,
  onNativeEvent: bridge.onNativeEvent,
}));

import {
  getSnapshot,
  listProfiles,
  getProfileById,
  getActiveProfile,
  isByoLlmActive,
  isByoTtsActive,
} from '../../../resources/js/aiProviders/profiles';

const SNAP = {
  profiles: [
    { id: 'llm_1', kind: 'llm', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasKey: true },
    { id: 'tts_1', kind: 'tts', label: 'Kokoro', baseUrl: 'https://x/y', model: 'k', voice: 'af_bella', hasKey: true },
  ],
  activeLlm: 'llm_1',
  activeTts: null,
};

beforeEach(async () => {
  bridge.isNativeShell.mockReturnValue(true);
  bridge.nativeCall.mockReset();
  bridge.nativeCall.mockResolvedValue(SNAP);
  // Clear the module cache by forcing a fresh read against a throwaway, then
  // firing the change event to invalidate.
  bridge.fireChanged();
  await getSnapshot(true);
  bridge.nativeCall.mockClear();
});

describe('outside the native shell', () => {
  it('returns an empty snapshot and never calls the bridge', async () => {
    bridge.isNativeShell.mockReturnValue(false);
    bridge.fireChanged(); // invalidate cache
    const snap = await getSnapshot();
    expect(snap).toEqual({ profiles: [], activeLlm: null, activeTts: null });
    expect(await isByoLlmActive()).toBe(false);
    expect(bridge.nativeCall).not.toHaveBeenCalled();
  });
});

describe('snapshot read + cache', () => {
  it('normalizes and returns the native snapshot', async () => {
    const snap = await getSnapshot(true);
    expect(snap.profiles).toHaveLength(2);
    expect(snap.activeLlm).toBe('llm_1');
    expect(snap.activeTts).toBe(null);
  });

  it('caches: a second read does not hit the bridge again', async () => {
    await getSnapshot();
    await getSnapshot();
    expect(bridge.nativeCall).not.toHaveBeenCalled(); // still cached from beforeEach
  });

  it('re-reads after a providers_changed event', async () => {
    bridge.fireChanged();
    await getSnapshot();
    expect(bridge.nativeCall).toHaveBeenCalledTimes(1);
  });

  it('coerces a malformed snapshot to empty-ish shape', async () => {
    bridge.nativeCall.mockResolvedValueOnce({ profiles: 'nope' });
    bridge.fireChanged();
    const snap = await getSnapshot();
    expect(snap.profiles).toEqual([]);
    expect(snap.activeLlm).toBe(null);
  });
});

describe('derived reads', () => {
  it('listProfiles / getProfileById', async () => {
    expect(await listProfiles()).toHaveLength(2);
    expect((await getProfileById('tts_1')).label).toBe('Kokoro');
    expect(await getProfileById('nope')).toBeUndefined();
  });

  it('getActiveProfile resolves the active LLM and null TTS', async () => {
    expect((await getActiveProfile('llm')).id).toBe('llm_1');
    expect(await getActiveProfile('tts')).toBeUndefined();
  });

  it('isByoLlmActive true (active + present), isByoTtsActive false (none active)', async () => {
    expect(await isByoLlmActive()).toBe(true);
    expect(await isByoTtsActive()).toBe(false);
  });

  it('isByoLlmActive false when the active id points at a missing profile', async () => {
    bridge.nativeCall.mockResolvedValueOnce({ profiles: [], activeLlm: 'ghost', activeTts: null });
    bridge.fireChanged();
    expect(await isByoLlmActive()).toBe(false);
  });
});
