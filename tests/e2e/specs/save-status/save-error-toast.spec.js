/**
 * Save-error surfacing for the cloudRef red glow.
 *
 * When a sync fails, the cloudRef indicator glows red AND (via glowCloudRed →
 * saveErrorToast.classifySyncError) explains WHAT went wrong, with severity driving
 * persistence:
 *   - transient (retryable, saved locally) → auto-dismissing toast, no action button
 *   - action    (must respond)             → sticky toast with a button (Refresh / Log in)
 *   - STALE_DATA (409, book out of date)    → blocking overlay (BroadcastListener), NOT a toast
 *
 * These drive the editor end-to-end and mock only the SERVER RESPONSE for the unified
 * sync endpoint (no test-only hooks in production code). The real classifier + toast/overlay
 * render and are asserted via their observable DOM (#save-error-toast / #stale-tab-overlay).
 *
 * Endpoints involved:
 *   POST /api/db/unified-sync   — the node sync (we fulfill it with 409 / 500 / 419)
 *   GET  /api/auth/session-info — the 419 CSRF-refresh probe (we report not-authenticated)
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

const SYNC_URL = '**/api/db/unified-sync';
const SESSION_URL = '**/api/auth/session-info';

/**
 * Create a fresh book (initial H1 sync runs for real), then wait for the cloud
 * indicator to settle so the test's mocked sync is the only one in flight.
 */
async function freshBookSettled(page, spa) {
  await spa.createNewBook(page, spa);
  // Idle = resetIndicator() cleared the inline fill on the cloud path.
  await page.waitForFunction(() => {
    const p = document.querySelector('#cloudRef-svg .cls-1');
    return p && !p.getAttribute('style');
  }, null, { timeout: 15000 }).catch(() => { /* best-effort; proceed regardless */ });
  // Drop any integrity noise from book creation so the afterEach guard only sees the
  // test phase (these tests mock sync failures — they must NOT also trip a REAL mismatch).
  await page.evaluate(() => window.__resetIntegrityEvents?.());
}

test.describe('cloudRef red glow → save-error toast', () => {
  // Guard: none of these tests should trigger a REAL DOM↔IDB integrity mismatch. They mock
  // SYNC failures (server-side), which must not also corrupt local data. A "[integrity]
  // MISMATCH DETECTED" event means a genuine integrity bug flashed during the run — stop and
  // surface its data rather than let it slip by. (The persistent-5xx test's server-error modal
  // logs "[integrity] Persistent server error" + shows the modal by design — NOT a mismatch —
  // so it doesn't trip this.)
  test.afterEach(async ({ page }, testInfo) => {
    const events = await page.evaluate(() => (window.__integrityEvents || []).slice()).catch(() => []);
    if (events.length) {
      await testInfo.attach('integrity-events.json', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      });
    }
    const mismatches = events.filter(e => e.kind === 'integrityWarn' && /MISMATCH DETECTED/.test(e.msg || ''));
    expect(
      mismatches,
      `Unexpected integrity MISMATCH during "${testInfo.title}":\n${JSON.stringify(mismatches, null, 2)}`,
    ).toEqual([]);
  });

  test('STALE_DATA (409) shows the blocking overlay, not a toast', async ({ page, spa }) => {
    test.setTimeout(60_000);
    await freshBookSettled(page, spa);

    // Mock the test edit's sync as a stale-data conflict.
    await page.route(SYNC_URL, route => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: 'STALE_DATA',
        message: 'Your book is out of date. Please refresh to get the latest version.',
        server_timestamp: 9999999999999,
      }),
    }));

    await spa.typeAtEndOfActiveEditor(page, ' stale-edit');

    // Blocking overlay appears; the passive toast must NOT (overlay owns this case).
    await expect(page.locator('#stale-tab-overlay')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('#stale-tab-overlay')).toContainText(/out of date|edited elsewhere/i);
    await expect(page.locator('#stale-tab-overlay button')).toHaveText(/refresh/i);
    await expect(page.locator('#save-error-toast')).toHaveCount(0);
  });

  test('transient server error (500) shows an auto-dismissing toast', async ({ page, spa }) => {
    test.setTimeout(60_000);
    await freshBookSettled(page, spa);

    // Node edit is saved locally (historyLog) → unknown 500 classifies as transient.
    await page.route(SYNC_URL, route => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'server boom' }),
    }));

    await spa.typeAtEndOfActiveEditor(page, ' transient-edit');

    const toast = page.locator('#save-error-toast');
    await expect(toast).toBeVisible({ timeout: 12_000 });
    // Names the server + the code (not a vague "hiccup"), and reassures it's saved.
    await expect(toast).toContainText(/server error \(500\)/i);
    await expect(toast).toContainText(/saved|retry/i);
    // Transient = informational: dismissable (×) but NO action button, and no blocking overlay.
    await expect(toast.getByRole('button', { name: /dismiss/i })).toBeVisible();
    await expect(toast.locator('button')).toHaveCount(1); // only the × dismiss
    await expect(page.locator('#stale-tab-overlay')).toHaveCount(0);
    // ...and it still dismisses itself (~5s + fade) without the user acting.
    await expect(toast).toBeHidden({ timeout: 9_000 });
  });

  test('persistent server error (two consecutive 5xx) escalates to the blackBox modal', async ({ page, spa }) => {
    test.setTimeout(90_000);
    await freshBookSettled(page, spa);

    // Every sync fails with 500 — so two consecutive edit→sync cycles trip the streak.
    await page.route(SYNC_URL, route => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'server boom' }),
    }));

    // First 5xx → transient toast (streak 1). Wait for it as proof sync #1 failed.
    await spa.typeAtEndOfActiveEditor(page, ' err-one');
    await expect(page.locator('#save-error-toast')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('#integrity-failure-backdrop')).toHaveCount(0); // not yet

    // Second consecutive 5xx (streak 2) → escalate to the serious blackBox/report modal.
    await spa.typeAtEndOfActiveEditor(page, ' err-two');
    const modal = page.locator('#integrity-failure-backdrop');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText(/server trouble/i);
    await expect(modal).toContainText(/500/);
    // Reuses the integrity blackBox download + bug report...
    await expect(modal.locator('#integrity-download-btn')).toBeVisible();
    await expect(modal.locator('#integrity-send-report-btn')).toBeVisible();
    // ...but NOT Emergency Rectify (nothing to rectify — local data is fine, the server failed).
    await expect(modal.locator('#integrity-rectify-btn')).toHaveCount(0);

    // Want to poke the modal by hand (click Download / Send Report)? Run with E2E_PAUSE=1
    // and the browser freezes here with the modal open until you hit Resume in the Inspector.
    if (process.env.E2E_PAUSE) await page.pause();
  });

  test('session expired (419 + failed refresh) shows a sticky toast with a Log in action', async ({ page, spa }) => {
    test.setTimeout(60_000);
    await freshBookSettled(page, spa);

    // 419 → master.js calls refreshCsrfToken() → /api/auth/session-info.
    // Report not-authenticated so the refresh "succeeds" but reports logged-out,
    // making master.js throw the "Session expired" error.
    await page.route(SESSION_URL, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false }),
    }));
    await page.route(SYNC_URL, route => route.fulfill({
      status: 419,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'CSRF token mismatch' }),
    }));

    await spa.typeAtEndOfActiveEditor(page, ' session-edit');

    const toast = page.locator('#save-error-toast');
    await expect(toast).toBeVisible({ timeout: 12_000 });
    await expect(toast).toContainText(/session expired/i);
    // Sticky action toast carries the "Log in" action button (+ a separate × dismiss).
    await expect(toast.getByRole('button', { name: /log in/i })).toBeVisible();
    await expect(toast.getByRole('button', { name: /dismiss/i })).toBeVisible();
    // action severity = sticky: still present a few seconds later (no auto-dismiss).
    await page.waitForTimeout(6_000);
    await expect(toast).toBeVisible();
  });
});
