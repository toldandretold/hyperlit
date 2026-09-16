/**
 * Consume a Response body the caller has no further use for.
 *
 * An unconsumed body is NOT free. The browser keeps the request in-flight and
 * holds its connection open (HTTP/1.1 allows only 6 per origin, so six leaked
 * responses stall every later request to that origin), and Playwright never
 * fires `requestfinished` for it — which means a page carrying ONE undrained
 * response can never reach network-idle.
 *
 * That has shipped twice. `utilities/auth/session.ts` threw on a 429 without
 * reading the body (2026-09-08), and `scrolling/pageViewTelemetry.ts` discarded
 * a by-design 401 on every home-page entry (2026-09-16), which hung ~30 e2e
 * specs across unrelated folders on `goto('/')` + `waitForLoadState('networkidle')`.
 * The shape is always the same: an endpoint whose NON-2xx branch is a routine
 * outcome, called by code that only cares whether it worked.
 *
 * Returns the same Response, so it wraps a fetch in place and leaves `.ok` /
 * `.status` reads working:
 *
 *     const res = await drainResponse(await fetch(url, opts));
 *     if (!res.ok) return null;
 *
 * Fire-and-forget calls chain it:
 *
 *     fetch(url, opts).then(drainResponse).catch(() => {});
 *
 * Note it READS the body rather than cancelling the stream: cancelling would
 * also release the connection, but it aborts the transfer, which would defeat
 * the prefetch callers that fetch purely to warm the HTTP cache. `.blob()` is
 * the cheapest full read — unlike `.text()` it skips UTF-8 decoding, and it is
 * correct for binary bodies (audio prefetch) as well as JSON.
 */
export async function drainResponse(response: Response): Promise<Response> {
  try {
    await response.blob();
  } catch {
    // Already read, aborted, or the connection died mid-body — either way
    // there is nothing left to release. Draining must never throw: every
    // caller is by definition one that did not want the body.
  }
  return response;
}
