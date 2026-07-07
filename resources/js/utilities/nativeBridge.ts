/**
 * nativeBridge — the single seam between the web front end and the native macOS
 * shell (WKWebView). It is a ZERO-DOM, low-import LEAF module (imports only the
 * logger) so it can be pulled into any layer — data, UI, or entry — without
 * dragging a dependency subtree along, and so it survives SPA navigation without
 * ButtonRegistry (there is nothing to re-init: no listeners on DOM, only a single
 * module-level reply hook installed on `window`).
 *
 * ── Why a bridge at all ──────────────────────────────────────────────────────
 * The Mac app is the existing web front end hosted in a WKWebView. Native-only
 * powers (Keychain-stored API keys, calling a local LLM, writing audio files to
 * disk, Apple OCR) live in Swift. The web side reaches them by posting a message
 * to `window.webkit.messageHandlers.native` and awaiting a reply. In a plain
 * browser that message handler does not exist, so every call rejects immediately
 * with `unsupported_method` and callers fall back to the normal server path.
 *
 * ── Protocol v1 (MUST match the Swift Coordinator) ───────────────────────────
 * The full contract lives in docs/native-bridge-protocol.md. In short:
 *
 *   JS → native   window.webkit.messageHandlers.native.postMessage(
 *                   { v: 1, id: "<uuid>", method: "ai.fetch", payload: {…} })
 *
 *   native → JS   window.__hyperlitNativeReply(obj)   // one global callback
 *      reply:  { v: 1, id, ok: true,  result: {…} }
 *            | { v: 1, id, ok: false, error: { code, message } }
 *      event:  { v: 1, event: "<name>", data: {…} }   // no `id` ⇒ it's an event
 *
 * Native pushes replies (correlated by `id`) and unsolicited events (no `id`)
 * through the SAME `__hyperlitNativeReply` entry point; we discriminate on the
 * presence of `id`.
 */

import { log, verbose } from './logger';

const FILE = '/utilities/nativeBridge.ts';

/** Protocol version. Bump only on a breaking envelope change (coordinate w/ Swift). */
export const NATIVE_PROTOCOL_VERSION = 1;

/** Default per-call timeout. LLM/TTS calls pass their own larger value. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Payload ceiling mirrored on the Swift side; larger ⇒ reject before posting. */
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Stable error codes shared with Swift. Callers can branch on `err.code`. */
export type NativeErrorCode =
  | 'timeout'
  | 'denied'
  | 'not_allowed_host'
  | 'network'
  | 'keychain'
  | 'unsupported_method'
  | 'payload_too_large'
  | 'internal';

export class NativeBridgeError extends Error {
  code: NativeErrorCode;
  constructor(code: NativeErrorCode, message: string) {
    super(message);
    this.name = 'NativeBridgeError';
    this.code = code;
  }
}

interface ReplyEnvelope {
  v: number;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code: NativeErrorCode; message: string };
  event?: string;
  data?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: NativeBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

// ── Module state ─────────────────────────────────────────────────────────────
// Keyed on globalThis so a duplicated module (code-split chunks can each get
// their own instance) still shares ONE correlation map and ONE installed reply
// hook — the same defensiveness modalState uses.
interface BridgeState {
  pending: Map<string, Pending>;
  eventHandlers: Map<string, Set<(data: unknown) => void>>;
  seq: number;
  installed: boolean;
}

function getState(): BridgeState {
  const g = globalThis as unknown as { __hyperlitNativeBridge?: BridgeState };
  if (!g.__hyperlitNativeBridge) {
    g.__hyperlitNativeBridge = {
      pending: new Map(),
      eventHandlers: new Map(),
      seq: 0,
      installed: false,
    };
  }
  return g.__hyperlitNativeBridge;
}

/**
 * True when running inside the native shell. Swift injects
 * `window.__hyperlitNative = true` via a WKUserScript at document start, so this
 * is reliable before any page JS runs.
 */
export function isNativeShell(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { __hyperlitNative?: boolean }).__hyperlitNative === true
  );
}

/**
 * Correlation ids don't need crypto strength — just uniqueness. The counter
 * lives on shared (globalThis) state, so a monotonically increasing value is
 * unique even across duplicated module instances. No Math.random (banned here).
 */
function nextId(state: BridgeState): string {
  state.seq += 1;
  return `nb_${state.seq.toString(36)}`;
}

/**
 * Install the single global reply hook. Idempotent and SPA-safe: it is fine to
 * call on every module load; the `installed` flag (on shared state) prevents
 * re-wrapping.
 */
function ensureInstalled(state: BridgeState): void {
  if (state.installed) return;
  if (typeof window === 'undefined') return;

  (window as unknown as { __hyperlitNativeReply?: (env: ReplyEnvelope) => void }).__hyperlitNativeReply =
    (env: ReplyEnvelope) => dispatch(state, env);

  state.installed = true;
  verbose.init('Native bridge reply hook installed', FILE);
}

/** Route an incoming envelope to a pending promise (has `id`) or event handlers. */
function dispatch(state: BridgeState, env: ReplyEnvelope): void {
  if (!env || typeof env !== 'object') return;

  // Events carry no `id`.
  if (env.id === undefined || env.id === null) {
    if (typeof env.event === 'string') {
      const handlers = state.eventHandlers.get(env.event);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(env.data);
          } catch (e) {
            log.error(`Native event handler for "${env.event}" threw`, FILE, e);
          }
        }
      }
    }
    return;
  }

  const pending = state.pending.get(env.id);
  if (!pending) {
    // A reply after we already timed out and dropped the entry — expected, ignore.
    verbose.init(`Native reply for unknown/expired id ${env.id} ignored`, FILE);
    return;
  }

  state.pending.delete(env.id);
  clearTimeout(pending.timer);

  if (env.ok) {
    pending.resolve(env.result);
  } else {
    const code = env.error?.code ?? 'internal';
    const message = env.error?.message ?? 'Native call failed';
    pending.reject(new NativeBridgeError(code, message));
  }
}

export interface NativeCallOptions {
  timeoutMs?: number;
}

/**
 * Call a native method and await its result.
 *
 * Rejects with a {@link NativeBridgeError}:
 *  - `unsupported_method` immediately when not in the native shell (or the
 *    message handler is missing) — the signal for callers to use the server path;
 *  - `payload_too_large` when the serialized payload exceeds {@link MAX_PAYLOAD_BYTES};
 *  - `timeout` when native does not reply within `timeoutMs` (the correlation
 *    entry is dropped; a late reply is then silently ignored);
 *  - or whatever `error.code` native returned.
 */
export function nativeCall<T = unknown>(
  method: string,
  payload: unknown = {},
  options: NativeCallOptions = {}
): Promise<T> {
  const state = getState();

  const handler = (
    window as unknown as {
      webkit?: { messageHandlers?: { native?: { postMessage: (msg: unknown) => void } } };
    }
  )?.webkit?.messageHandlers?.native;

  if (!isNativeShell() || !handler) {
    return Promise.reject(
      new NativeBridgeError('unsupported_method', `Native bridge unavailable for "${method}"`)
    );
  }

  ensureInstalled(state);

  const id = nextId(state);
  const envelope = { v: NATIVE_PROTOCOL_VERSION, id, method, payload };

  // Guard payload size before crossing the bridge (Swift enforces the same cap).
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
  } catch (e) {
    return Promise.reject(
      new NativeBridgeError('internal', `Payload for "${method}" is not serializable`)
    );
  }
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    return Promise.reject(
      new NativeBridgeError('payload_too_large', `Payload for "${method}" exceeds ${MAX_PAYLOAD_BYTES} bytes`)
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Drop the entry so a late reply is ignored rather than resolving a
      // promise the caller has already given up on.
      state.pending.delete(id);
      reject(new NativeBridgeError('timeout', `Native call "${method}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    state.pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
      method,
    });

    try {
      handler.postMessage(serialized);
    } catch (e) {
      state.pending.delete(id);
      clearTimeout(timer);
      reject(new NativeBridgeError('internal', `postMessage failed for "${method}": ${String(e)}`));
    }
  });
}

/**
 * Subscribe to a native-initiated event (envelopes with `event` and no `id`),
 * e.g. the SSE-independent `inference_request` push. Returns an unsubscribe fn.
 */
export function onNativeEvent(name: string, handler: (data: unknown) => void): () => void {
  const state = getState();
  ensureInstalled(state);

  let set = state.eventHandlers.get(name);
  if (!set) {
    set = new Set();
    state.eventHandlers.set(name, set);
  }
  set.add(handler);

  return () => {
    const s = state.eventHandlers.get(name);
    if (s) {
      s.delete(handler);
      if (s.size === 0) state.eventHandlers.delete(name);
    }
  };
}

/** Convenience health-check used by the settings pane / boot. */
export function nativePing(timeoutMs = 3_000): Promise<{ version?: number }> {
  return nativeCall<{ version?: number }>('ping', {}, { timeoutMs });
}
