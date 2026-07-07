/**
 * aiProviders/profiles — a READ-ONLY view of the AI provider configuration that
 * the native macOS app owns.
 *
 * Ownership deliberately lives in Swift: the provider list, the active
 * selections, the API keys (Keychain), the presets, and the "Test connection"
 * UI are all in the native Settings window — NOT in the web reader. Regular
 * website users have no AI-provider UI at all. The web layer only needs to READ
 * the config so the AI features (vibe CSS, AI Brain, citation review, TTS) can
 * decide whether to route inference through the user's own key/endpoint.
 *
 * The native side answers `providers.snapshot` and pushes a `providers_changed`
 * event when the user edits settings; we cache the snapshot and invalidate on
 * that event. Outside the native shell every read returns "no BYO", so the web
 * app behaves exactly as before.
 */

import { isNativeShell, nativeCall, onNativeEvent } from '../utilities/nativeBridge';
import { verbose } from '../utilities/logger';

const FILE = '/aiProviders/profiles.ts';

export type ProviderKind = 'llm' | 'tts';

export interface ProviderProfile {
  id: string;
  label: string;
  kind: ProviderKind;
  /** OpenAI-compatible base URL (no trailing slash). */
  baseUrl: string;
  model: string;
  /** TTS only. */
  voice?: string;
  /** Whether native holds a Keychain key for this profile (native-reported). */
  hasKey: boolean;
}

export interface ProviderSnapshot {
  profiles: ProviderProfile[];
  /** id of the active LLM profile, or null. */
  activeLlm: string | null;
  /** id of the active TTS profile, or null. */
  activeTts: string | null;
}

const EMPTY: ProviderSnapshot = { profiles: [], activeLlm: null, activeTts: null };

// ── Cached snapshot (invalidated by the native `providers_changed` event) ─────

let cache: ProviderSnapshot | null = null;
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed || !isNativeShell()) return;
  onNativeEvent('providers_changed', () => {
    cache = null;
    verbose.init('AI provider config changed (native) — cache invalidated', FILE);
  });
  subscribed = true;
}

/**
 * Get the current provider config. Cheap (local IPC) and cached until native
 * signals a change. Returns an empty snapshot outside the native shell or if the
 * bridge call fails.
 */
export async function getSnapshot(force = false): Promise<ProviderSnapshot> {
  if (!isNativeShell()) return EMPTY;
  ensureSubscribed();
  if (cache && !force) return cache;
  try {
    const snap = await nativeCall<ProviderSnapshot>('providers.snapshot', {});
    cache = normalize(snap);
  } catch {
    cache = EMPTY;
  }
  return cache;
}

function normalize(snap: unknown): ProviderSnapshot {
  const s = (snap ?? {}) as Partial<ProviderSnapshot>;
  return {
    profiles: Array.isArray(s.profiles) ? s.profiles : [],
    activeLlm: typeof s.activeLlm === 'string' ? s.activeLlm : null,
    activeTts: typeof s.activeTts === 'string' ? s.activeTts : null,
  };
}

// ── Derived reads (all async — callers are async feature handlers) ────────────

export async function listProfiles(): Promise<ProviderProfile[]> {
  return (await getSnapshot()).profiles;
}

export async function getProfileById(id: string): Promise<ProviderProfile | undefined> {
  return (await getSnapshot()).profiles.find((p) => p.id === id);
}

export async function getActiveProfile(kind: ProviderKind): Promise<ProviderProfile | undefined> {
  const snap = await getSnapshot();
  const id = kind === 'llm' ? snap.activeLlm : snap.activeTts;
  if (!id) return undefined;
  return snap.profiles.find((p) => p.id === id);
}

/**
 * BYO active for a kind ⇒ native shell + an active profile exists. LLM covers a
 * local endpoint (Ollama/LM Studio) that may need no key, so `hasKey` is not
 * required here.
 */
export async function isByoLlmActive(): Promise<boolean> {
  return !!(await getActiveProfile('llm'));
}

export async function isByoTtsActive(): Promise<boolean> {
  return !!(await getActiveProfile('tts'));
}
