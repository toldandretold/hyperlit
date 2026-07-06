/**
 * E2EE unlock modal — keyboard operability (WCAG 2.1.2, 2.4.3).
 *
 * The modal itself needs no encrypted book to render: we import
 * e2ee/ui/unlockModal.ts straight from the vite dev server and call
 * showUnlockModal(). That makes this the one hyperlit-container-free way to
 * regression-guard trapModalFocus (utilities/modalFocusTrap.ts) end-to-end:
 * focus must land inside the dialog on open, Tab must cycle its three
 * buttons (never the blocked page behind the overlay), and Escape cancels.
 *
 * Dev-mode only: importing the raw .ts module requires the vite dev server
 * (public/hot). Skips when the app runs from a production build.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function viteOrigin() {
  try {
    return readFileSync(join(HERE, '../../../../public/hot'), 'utf8').trim();
  } catch {
    return null;
  }
}

test('E2EE unlock modal: focus seated, Tab trapped to its buttons, Escape cancels (WCAG 2.1.2, 2.4.3)', async ({ page }) => {
  const hot = viteOrigin();
  test.skip(!hot, 'vite dev server not running (no public/hot) — raw .ts import unavailable');

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.evaluate(async (origin) => {
    const mod = await import(`${origin}/resources/js/e2ee/ui/unlockModal.ts`);
    mod.showUnlockModal().catch(() => {}); // rejects on cancel — expected
  }, hot);
  await page.waitForSelector('#e2ee-unlock-overlay', { timeout: 5000 });

  // Focus must be seated inside the dialog immediately (not left on the page).
  const initial = await page.evaluate(() => document.activeElement?.id || '');
  expect(initial, 'focus should move into the dialog on open').toBe('e2eeUnlockPasskey');

  // Tab must cycle the dialog's buttons only.
  const seq = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    seq.push(await page.evaluate(() => document.activeElement?.id || '(escaped)'));
  }
  expect(
    seq.every((id) => id.startsWith('e2eeUnlock')),
    `Tab escaped the unlock dialog: ${JSON.stringify(seq)}`
  ).toBe(true);

  // Escape cancels (dialog removed) — the keyboard user's way out.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('e2ee-unlock-overlay'), null, { timeout: 3000 });
});
