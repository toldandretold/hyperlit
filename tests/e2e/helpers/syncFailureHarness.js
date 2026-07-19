/**
 * Sync-failure harness: pass-through interception of POST /api/db/unified-sync
 * that lets the REAL server process requests while scripting wire-level failures
 * around them. Unlike the mocks in save-error-toast.spec.js (which fulfill with
 * fake responses and never touch the server), this drives the full client⇄server
 * loop — so it can reproduce failure shapes where the two sides DISAGREE about
 * what happened, e.g. the lost-ACK: the server committed, the client never heard.
 *
 * Built for lost-ack-recovery.spec.js; reuse it to model new network-failure
 * shapes when a future sync bug smells like this class (add an action, script a
 * plan). Every call is recorded, so specs can assert on the real wire history:
 * what the client sent, what the server answered, and what the page was allowed
 * to see.
 */

export const SYNC_URL = '**/api/db/unified-sync';

/**
 * Intercept unified-sync POSTs with a scripted per-call plan.
 *
 * `plan(index, sentBody)` returns one of:
 *   'pass'          — forward to the real server, give the page the real response
 *   'drop-response' — forward to the real server (it processes and COMMITS), then
 *                     abort so the page never sees the response — the lost-ACK shape
 *   'drop-request'  — abort immediately; the server never sees the request — a
 *                     clean network failure with no server-side effect
 *
 * Returns the live `calls` array (chronological). Each entry:
 *   { action, sentBody, serverStatus, serverBody }
 * serverStatus/serverBody stay null for 'drop-request' (nothing reached the server).
 */
export async function interceptUnifiedSync(page, plan) {
  const calls = [];
  await page.route(SYNC_URL, async route => {
    const sentBody = route.request().postDataJSON();
    const action = plan(calls.length, sentBody) || 'pass';
    const entry = { action, sentBody, serverStatus: null, serverBody: null };
    calls.push(entry);

    if (action === 'drop-request') return route.abort('failed');

    const response = await route.fetch(); // the REAL server handles it
    entry.serverStatus = response.status();
    try { entry.serverBody = await response.json(); } catch { /* non-JSON body */ }

    if (action === 'drop-response') return route.abort('failed');
    return route.fulfill({ response });
  });
  return calls;
}
