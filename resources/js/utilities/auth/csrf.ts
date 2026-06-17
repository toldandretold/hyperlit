// csrf.ts — single source of truth for obtaining an XSRF token before a
// stateful (cookie-session) request.
//
// Why this exists: the old pattern, copy-pasted across every auth call site,
// was `await fetch('/sanctum/csrf-cookie'); const t = readCookie();` — it
// ignored whether the cookie fetch succeeded and then sent `t` (possibly null)
// straight into the request header. On a cold/slow boot the cookie fetch races
// the page's own boot fetches and gets aborted, so `t` is null, Laravel 419s,
// and the login/register/etc. fails silently. See ensureCsrfToken below.

/** Reads the current XSRF-TOKEN cookie, or null if it isn't set. */
export function getCsrfTokenFromCookie(): string | null {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; XSRF-TOKEN=`);
  if (parts.length === 2) {
    return decodeURIComponent(parts.pop()!.split(';').shift()!);
  }
  return null;
}

/**
 * Returns a usable XSRF token, fetching `/sanctum/csrf-cookie` first only if
 * the cookie isn't already present (avoids a redundant round trip — and the
 * race — on a warm page).
 *
 * Returns null ONLY when a token genuinely can't be obtained (the csrf-cookie
 * fetch failed or was aborted mid-boot). Callers MUST guard on null and show an
 * error rather than POSTing a tokenless request, which Laravel rejects with 419.
 */
export async function ensureCsrfToken(): Promise<string | null> {
  let token = getCsrfTokenFromCookie();
  if (token) return token;

  try {
    const res = await fetch('/sanctum/csrf-cookie', { credentials: 'include' });
    if (!res.ok) return null;
  } catch {
    return null;
  }

  return getCsrfTokenFromCookie();
}
