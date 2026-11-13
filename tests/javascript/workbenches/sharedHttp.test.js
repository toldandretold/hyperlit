/**
 * workbenches/shared/http.ts — the one HTTP seam every workbench page uses.
 *
 * Standalone pages bootstrap their own session, so the contract worth pinning
 * is: a POST carries the XSRF pair (or refuses rather than sending a request
 * that will 419), a failed READ throws, and a refused WRITE (409 / 422) comes
 * back as data — the consoles display those.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ensureCsrfToken = vi.fn();
vi.mock('../../../resources/js/utilities/auth/csrf', () => ({ ensureCsrfToken: (...a) => ensureCsrfToken(...a) }));

import { csrfHeaders, getJson, postJson } from '../../../resources/js/workbenches/shared/http.ts';

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('workbenches/shared/http', () => {
  beforeEach(() => {
    ensureCsrfToken.mockReset();
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('csrfHeaders returns the XSRF pair, or null with no token', async () => {
    ensureCsrfToken.mockResolvedValueOnce('tok');
    expect(await csrfHeaders()).toEqual({ 'X-XSRF-TOKEN': 'tok', 'X-Requested-With': 'XMLHttpRequest' });

    ensureCsrfToken.mockResolvedValueOnce(null);
    expect(await csrfHeaders()).toBeNull();
  });

  it('getJson returns the parsed body and sends credentials', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    expect(await getJson('/api/x')).toEqual({ ok: 1 });
    expect(fetch.mock.calls[0][1].credentials).toBe('include');
  });

  it('getJson throws on a non-2xx and still consumes the body', async () => {
    const res = jsonResponse(403, { message: 'no' });
    fetch.mockResolvedValueOnce(res);
    await expect(getJson('/api/x')).rejects.toThrow('/api/x → 403');
    expect(res.bodyUsed).toBe(true);
  });

  it('postJson sends the XSRF pair and returns a refusal as data', async () => {
    ensureCsrfToken.mockResolvedValueOnce('tok');
    fetch.mockResolvedValueOnce(jsonResponse(409, { error: 'stale_citing' }));

    const out = await postJson('/api/x', { a: 1 });

    expect(out).toEqual({ status: 409, data: { error: 'stale_citing' } });
    const init = fetch.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.headers['X-XSRF-TOKEN']).toBe('tok');
    expect(init.body).toBe('{"a":1}');
  });

  it('postJson refuses to send without a token', async () => {
    ensureCsrfToken.mockResolvedValueOnce(null);
    await expect(postJson('/api/x', {})).rejects.toThrow('session error');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('postJson tolerates a non-JSON body', async () => {
    ensureCsrfToken.mockResolvedValueOnce('tok');
    fetch.mockResolvedValueOnce(new Response('<html>500</html>', { status: 500 }));
    expect(await postJson('/api/x', {})).toEqual({ status: 500, data: {} });
  });
});
