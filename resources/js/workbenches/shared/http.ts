/**
 * The workbenches' one HTTP seam.
 *
 * Every workbench is a standalone non-SPA page, so nothing has bootstrapped
 * the session for it: a POST without the XSRF pair 419s, and each page used to
 * carry its own copy of these three helpers (five `csrfHeaders`, three
 * `getJson`/`postJson` pairs). They live here once.
 *
 * `getJson` THROWS on a non-2xx (a read that failed is an error); `postJson`
 * RETURNS the status beside the parsed body, because the consoles' writes use
 * 409 / 422 as ordinary, displayable outcomes ("stale", "refused").
 * Both always consume the response body (see CLAUDE.md §"Fetch responses get
 * drained").
 */

import { ensureCsrfToken } from '../../utilities/auth/csrf';
import { drainResponse } from '../../utilities/drainResponse';

/** The header pair a session POST needs, or null when no token could be had. */
export async function csrfHeaders(): Promise<Record<string, string> | null> {
  const token = await ensureCsrfToken();
  if (!token) return null;
  return { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' };
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
  if (!res.ok) {
    await drainResponse(res);
    throw new Error(`${url} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<{ status: number; data: T }> {
  const headers = await csrfHeaders();
  if (!headers) throw new Error('session error — refresh and retry');
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}
