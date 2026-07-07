/**
 * aiProviders/execute — runs an AI request against a BYO provider profile by
 * routing it through the native bridge's `ai.fetch` (native injects the Keychain
 * key and enforces the host allowlist; the key never re-enters JS).
 *
 * Request bodies mirror the server exactly so a provider that works server-side
 * works here unchanged:
 *   - chat  → OpenAI `/chat/completions` (see LlmService::chat, LlmService.php:58)
 *   - tts   → DeepInfra Kokoro payload   (see DeepInfraKokoroProvider::payload)
 */

import { nativeCall } from '../utilities/nativeBridge';
import { getProfileById } from './profiles';
import { log } from '../utilities/logger';

const FILE = '/aiProviders/execute.ts';

interface AiFetchResult {
  status: number;
  bodyJson?: unknown;
  bodyText?: string;
}

/** Low-level: POST/GET a path under a profile's base URL via native. */
async function aiFetch(
  profileId: string,
  path: string,
  method: 'GET' | 'POST',
  bodyJson: unknown | undefined,
  timeoutMs: number
): Promise<AiFetchResult> {
  return nativeCall<AiFetchResult>(
    'ai.fetch',
    { profileId, path, method, bodyJson },
    { timeoutMs }
  );
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatRequest {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** Override the profile's default model. */
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string | null;
  usage?: unknown;
  model: string;
}

/**
 * Execute a chat completion against the active/give LLM profile. Returns
 * `content: null` (never throws for a normal API failure) so callers degrade
 * exactly like the server's `LlmService::chat` returning null.
 */
export async function executeChat(profileId: string, req: ChatRequest): Promise<ChatResult> {
  const profile = await getProfileById(profileId);
  if (!profile || profile.kind !== 'llm') {
    throw new Error(`No LLM profile "${profileId}"`);
  }

  const model = req.model || profile.model;
  const body: Record<string, unknown> = {
    model,
    temperature: req.temperature ?? 0.0,
    max_tokens: req.maxTokens ?? 200,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  };
  if (req.reasoningEffort && req.reasoningEffort !== 'none') {
    body.reasoning_effort = req.reasoningEffort;
  }

  const res = await aiFetch(profileId, '/chat/completions', 'POST', body, req.timeoutMs ?? 300_000);

  if (res.status < 200 || res.status >= 300) {
    log.error(`BYO chat HTTP ${res.status} on ${profile.label}`, FILE, res.bodyText);
    return { content: null, model };
  }

  const json = res.bodyJson as
    | { choices?: Array<{ message?: { content?: string } }>; usage?: unknown }
    | undefined;
  const content = json?.choices?.[0]?.message?.content ?? null;
  return { content, usage: json?.usage, model };
}

// ── TTS ──────────────────────────────────────────────────────────────────────

export interface TtsRequest {
  text: string;
  voice?: string;
  timeoutMs?: number;
}

export interface TtsResult {
  /** Bare base64 MP3 (data-URI prefix stripped), or null on failure. */
  base64: string | null;
}

/** Strip an optional `data:audio/...;base64,` prefix, matching the PHP parser. */
function normalizeAudio(audio: string): string {
  const comma = audio.indexOf(',');
  return audio.startsWith('data:') && comma >= 0 ? audio.slice(comma + 1) : audio;
}

/**
 * Synthesize one chunk of speech against the given TTS profile. The DeepInfra
 * Kokoro endpoint IS the full URL (no sub-path), so `path` is empty.
 */
export async function executeTts(profileId: string, req: TtsRequest): Promise<TtsResult> {
  const profile = await getProfileById(profileId);
  if (!profile || profile.kind !== 'tts') {
    throw new Error(`No TTS profile "${profileId}"`);
  }

  const voice = req.voice || profile.voice || 'af_bella';
  const body = { text: req.text, preset_voice: [voice], output_format: 'mp3' };

  const res = await aiFetch(profileId, '', 'POST', body, req.timeoutMs ?? 120_000);

  if (res.status < 200 || res.status >= 300) {
    log.error(`BYO TTS HTTP ${res.status} on ${profile.label}`, FILE, res.bodyText);
    return { base64: null };
  }

  const json = res.bodyJson as { audio?: string } | undefined;
  const audio = json?.audio;
  if (typeof audio !== 'string' || audio === '') return { base64: null };
  return { base64: normalizeAudio(audio) };
}

// Note: "Test connection" lives in the NATIVE Settings window (Swift), not here —
// the web layer only executes real inference for the AI features.
