/**
 * nativeBridge — the seam to the native macOS shell. These tests drive a fake
 * `window.webkit.messageHandlers.native` and reply through the module's own
 * `window.__hyperlitNativeReply` hook, exactly as Swift would.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isNativeShell,
  nativeCall,
  onNativeEvent,
  NativeBridgeError,
  MAX_PAYLOAD_BYTES,
} from '../../../resources/js/utilities/nativeBridge';

/** Posted messages land here so tests can read the correlation id and reply. */
let posted;

/** Install a fake native shell: the flag + a capturing message handler. */
function installFakeShell() {
  posted = [];
  window.__hyperlitNative = true;
  window.webkit = {
    messageHandlers: {
      native: {
        postMessage: (msg) => {
          posted.push(typeof msg === 'string' ? JSON.parse(msg) : msg);
        },
      },
    },
  };
}

/** Simulate Swift replying to the most recent (or given) request. */
function reply(env) {
  window.__hyperlitNativeReply(env);
}

beforeEach(() => {
  // Shared state lives on globalThis (survives module duplication) — reset it.
  delete globalThis.__hyperlitNativeBridge;
  delete window.__hyperlitNativeReply;
  delete window.__hyperlitNative;
  delete window.webkit;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isNativeShell', () => {
  it('is false without the injected flag', () => {
    expect(isNativeShell()).toBe(false);
  });

  it('is true when the shell injected the flag', () => {
    installFakeShell();
    expect(isNativeShell()).toBe(true);
  });
});

describe('nativeCall — browser fallback', () => {
  it('rejects immediately with unsupported_method outside the shell', async () => {
    await expect(nativeCall('ping')).rejects.toMatchObject({
      name: 'NativeBridgeError',
      code: 'unsupported_method',
    });
  });

  it('rejects unsupported_method if the flag is set but the handler is missing', async () => {
    window.__hyperlitNative = true; // flag without webkit handler
    await expect(nativeCall('ping')).rejects.toMatchObject({ code: 'unsupported_method' });
  });
});

describe('nativeCall — correlation', () => {
  beforeEach(installFakeShell);

  it('posts a v1 envelope with a method, payload and id', async () => {
    const p = nativeCall('ai.fetch', { path: '/models' });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ v: 1, method: 'ai.fetch', payload: { path: '/models' } });
    expect(typeof posted[0].id).toBe('string');
    // resolve so the promise doesn't dangle
    reply({ v: 1, id: posted[0].id, ok: true, result: { status: 200 } });
    await expect(p).resolves.toEqual({ status: 200 });
  });

  it('resolves the matching call with its result', async () => {
    const p = nativeCall('secret.exists', { ref: 'p1' });
    reply({ v: 1, id: posted[0].id, ok: true, result: { exists: true } });
    await expect(p).resolves.toEqual({ exists: true });
  });

  it('routes concurrent calls to the right promise by id', async () => {
    const a = nativeCall('ping');
    const b = nativeCall('ping');
    const [idA, idB] = [posted[0].id, posted[1].id];
    expect(idA).not.toBe(idB);
    // reply out of order
    reply({ v: 1, id: idB, ok: true, result: 'B' });
    reply({ v: 1, id: idA, ok: true, result: 'A' });
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('rejects with the native error code + message on ok:false', async () => {
    const p = nativeCall('ai.fetch', { path: '/x' });
    reply({ v: 1, id: posted[0].id, ok: false, error: { code: 'not_allowed_host', message: 'nope' } });
    await expect(p).rejects.toMatchObject({ code: 'not_allowed_host', message: 'nope' });
  });

  it('defaults a malformed error reply to code internal', async () => {
    const p = nativeCall('ping');
    reply({ v: 1, id: posted[0].id, ok: false });
    await expect(p).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('nativeCall — timeout', () => {
  beforeEach(installFakeShell);

  it('rejects with timeout and ignores a late reply', async () => {
    vi.useFakeTimers();
    const p = nativeCall('ping', {}, { timeoutMs: 1000 });
    const id = posted[0].id;

    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });

    // A late reply must not throw or resolve anything (entry already dropped).
    expect(() => reply({ v: 1, id, ok: true, result: 'late' })).not.toThrow();
  });
});

describe('nativeCall — payload guard', () => {
  beforeEach(installFakeShell);

  it('rejects payload_too_large before posting', async () => {
    const big = 'x'.repeat(MAX_PAYLOAD_BYTES + 10);
    await expect(nativeCall('file.writeAudio', { base64: big })).rejects.toMatchObject({
      code: 'payload_too_large',
    });
    expect(posted).toHaveLength(0); // never crossed the bridge
  });
});

describe('onNativeEvent', () => {
  beforeEach(installFakeShell);

  it('delivers events (no id) to subscribers and supports unsubscribe', () => {
    const seen = [];
    const off = onNativeEvent('inference_request', (data) => seen.push(data));

    reply({ v: 1, event: 'inference_request', data: { ticket_id: 't1' } });
    expect(seen).toEqual([{ ticket_id: 't1' }]);

    off();
    reply({ v: 1, event: 'inference_request', data: { ticket_id: 't2' } });
    expect(seen).toHaveLength(1); // no delivery after unsubscribe
  });

  it('does not treat an event as a reply (and vice-versa)', async () => {
    const seen = [];
    onNativeEvent('foo', (d) => seen.push(d));
    const p = nativeCall('ping');
    // An event with no id must not resolve the pending call.
    reply({ v: 1, event: 'foo', data: 1 });
    expect(seen).toEqual([1]);
    reply({ v: 1, id: posted[0].id, ok: true, result: 'ok' });
    await expect(p).resolves.toBe('ok');
  });

  it('isolates a throwing handler from siblings', () => {
    const seen = [];
    onNativeEvent('e', () => { throw new Error('boom'); });
    onNativeEvent('e', (d) => seen.push(d));
    expect(() => reply({ v: 1, event: 'e', data: 'x' })).not.toThrow();
    expect(seen).toEqual(['x']);
  });
});

describe('NativeBridgeError', () => {
  it('carries a stable code field', () => {
    const e = new NativeBridgeError('keychain', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('keychain');
  });
});
