/**
 * E2EE unlock modal via the REAL reader open-gate (WCAG 2.1.2, 2.4.3).
 *
 * The standalone spec (e2ee-unlock-modal.spec.js) opens the modal on a settled
 * home page and MISSED the boot-timing bug: the gate at
 * pageLoad/initialChunk.ts awaits showUnlockModal() mid-page-load, before
 * layout settles — the trap's old offsetParent visibility filter saw zero
 * focusable buttons and cancelled Tab with nowhere to send focus. This spec
 * drives the genuine path: navigate to an encrypted fixture book with the
 * vault locked and assert the full keyboard contract.
 *
 * Fixture: `php artisan e2e:seed-fixtures` seeds E2E_ENCRYPTED_BOOK (an
 * `encrypted = true` library row owned by the e2e user — the gate fires
 * before any content render, so the node content is irrelevant).
 *
 * The vault is locked by construction: a fresh Playwright context has no
 * unlocked vault state, and the fixture's dummy wrapped_dek can't be
 * unwrapped anyway. Dismissing the modal (Escape/Cancel) makes the gate
 * redirect to `/` (initialChunk.ts catch branch).
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';

const ENCRYPTED_BOOK = process.env.E2E_ENCRYPTED_BOOK;

test('reader open-gate: unlock modal seats focus, traps Tab, Escape exits to home (WCAG 2.1.2, 2.4.3)', async ({ page }) => {
  test.skip(!ENCRYPTED_BOOK, 'E2E_ENCRYPTED_BOOK not set — run `php artisan e2e:seed-fixtures` and add it to tests/e2e/.env.e2e');

  await page.goto(`/${ENCRYPTED_BOOK}`);
  await page.waitForSelector('#e2ee-unlock-overlay', { timeout: 15000 });

  // Focus must be seated INSIDE the modal even though it opened mid-boot —
  // this is the regression assertion for the offsetParent dead-trap bug.
  await page.waitForFunction(() => {
    const overlay = document.getElementById('e2ee-unlock-overlay');
    return !!(overlay && overlay.contains(document.activeElement));
  }, null, { timeout: 3000 });
  const seated = await page.evaluate(() => document.activeElement?.id || '');
  expect(seated, 'focus should seat on the primary unlock button').toBe('e2eeUnlockPasskey');

  // Tab must cycle ONLY the modal's three buttons — never the booting page.
  const seq = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    seq.push(await page.evaluate(() => document.activeElement?.id || '(escaped modal)'));
  }
  expect(
    seq.every((id) => id.startsWith('e2eeUnlock')),
    `Tab escaped the unlock modal on the reader gate: ${JSON.stringify(seq)}`
  ).toBe(true);

  // Escape = dismiss → the gate leaves the book (initialChunk redirects home).
  await page.keyboard.press('Escape');
  await page.waitForURL((url) => url.pathname === '/', { timeout: 10000 });
});
