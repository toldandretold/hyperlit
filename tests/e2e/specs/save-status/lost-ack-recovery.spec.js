/**
 * Lost-ACK recovery, end-to-end against the REAL server (no mocked responses).
 *
 * Reproduces the 2026-07-18 prod incident: mid-edit, a unified-sync POST reached
 * the server and COMMITTED (advancing the book's timestamp + storing our
 * sync_token), but the network dropped the response — so the client's
 * base_timestamp never advanced. The user kept editing (content drift), and the
 * next sync 409'd STALE_DATA. Before sync tokens, neither recovery proof could
 * fire (never ACKed; content no longer matches the committed snapshot) and the
 * "discard your edits" overlay hard-blocked a user whose edits were fine.
 *
 * With tokens: the 409 echoes library.last_sync_token, the client finds it in
 * its sent ledger (localStorage), fast-forwards its base, retries once, and the
 * user never notices. This spec drives that whole loop for real: real editor,
 * real client sync stack, real Laravel controllers, real Postgres — only the
 * WIRE is scripted (syncFailureHarness drops exactly one response after the
 * server has processed it).
 *
 * Manual suite (npm run test:e2e), lives next to save-error-toast.spec.js —
 * that spec covers the classifier/overlay UI with mocked responses; this one
 * covers the client⇄server recovery contract.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { interceptUnifiedSync } from '../../helpers/syncFailureHarness.js';

/**
 * Create a fresh book, wait for the cloud indicator to settle, and make sure the
 * pending-new-book marker is gone: while it's set the client sends a null base on
 * the wire and the server SKIPS the stale check — this test needs the real 409.
 */
async function freshBookSettled(page, spa) {
  await spa.createNewBook(page, spa);
  await page.waitForFunction(() => {
    const p = document.querySelector('#cloudRef-svg .cls-1');
    return p && !p.getAttribute('style');
  }, null, { timeout: 15000 }).catch(() => { /* best-effort; proceed regardless */ });
  await page.waitForFunction(
    () => !sessionStorage.getItem('pending_new_book_sync'),
    null,
    { timeout: 20000 },
  ).catch(() => { /* fall through to the hard remove below */ });
  // Belt-and-braces: creation has settled (cloud idle) — the marker only exists to
  // bridge creation races, and leaving it set would silently skip the stale check.
  await page.evaluate(() => sessionStorage.removeItem('pending_new_book_sync'));
  await page.evaluate(() => window.__resetIntegrityEvents?.());
}

test.describe('lost-ACK sync-token recovery (real server)', () => {
  test('committed-but-lost response + drifted follow-up edit: recovers via sync token, no overlay', async ({ page, spa }) => {
    test.setTimeout(120_000);
    await freshBookSettled(page, spa);

    // Script the wire: the FIRST sync is processed by the real server (commit +
    // token stamp) but its response never reaches the page. Everything after
    // flows normally.
    const calls = await interceptUnifiedSync(page, idx => (idx === 0 ? 'drop-response' : 'pass'));

    // Edit #1 — the write whose ACK gets lost.
    await spa.typeAtEndOfActiveEditor(page, ' lost-write');
    await expect.poll(() => calls.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    expect(calls[0].serverStatus, 'the dropped sync must have COMMITTED server-side').toBe(200);
    expect(typeof calls[0].sentBody.sync_token, 'every sync POST carries a write id').toBe('string');

    // Edit #2 — content drifts past the committed snapshot, exactly like the paste
    // flow's follow-up saves in the incident. This is the case the content-compare
    // fallback cannot vouch for; only the token can.
    await spa.typeAtEndOfActiveEditor(page, ' drift-edit');

    // The real server rejects the lagging base as stale...
    await expect.poll(
      () => calls.filter(c => c.serverStatus === 409).length,
      { timeout: 30_000, message: 'expected the real server to 409 the post-drop sync' },
    ).toBeGreaterThanOrEqual(1);

    // ...echoing the sync token of the committed-but-lost write (the full loop:
    // client ledger → POST → library.last_sync_token → 409 echo)...
    const conflict = calls.find(c => c.serverStatus === 409);
    expect(conflict.serverBody?.error).toBe('STALE_DATA');
    expect(
      conflict.serverBody?.server_sync_token,
      'the 409 must echo the token of the write that produced the server timestamp',
    ).toBe(calls[0].sentBody.sync_token);

    // ...and the client recognizes its own write: a retry AFTER the 409 succeeds.
    await expect.poll(() => {
      const i409 = calls.findIndex(c => c.serverStatus === 409);
      return i409 >= 0 && calls.slice(i409 + 1).some(c => c.serverStatus === 200);
    }, { timeout: 30_000, message: 'expected a successful retry after the 409' }).toBe(true);
    // The retry carried the fast-forwarded base (the 409's server_timestamp).
    const i409 = calls.findIndex(c => c.serverStatus === 409);
    const retry = calls.slice(i409 + 1).find(c => c.serverStatus === 200);
    expect(retry.sentBody.base_timestamp).toBe(conflict.serverBody.server_timestamp);

    // The user was never interrupted, and both edits survive locally.
    await expect(page.locator('#stale-tab-overlay')).toHaveCount(0);
    await expect(page.locator('body')).toContainText('lost-write');
    await expect(page.locator('body')).toContainText('drift-edit');

    // Strongest check: the SERVER's stored content now holds both edits — nothing
    // was discarded and nothing forked.
    const bookId = await page.evaluate(() => document.querySelector('.main-content')?.id);
    const serverText = await page.evaluate(async (id) => {
      const res = await fetch(`/api/database-to-indexeddb/books/${id}/data`, { credentials: 'include' });
      const data = await res.json();
      return (data.nodes || []).map(n => n.content).join(' ');
    }, bookId);
    expect(serverText).toContain('lost-write');
    expect(serverText).toContain('drift-edit');
  });
});
