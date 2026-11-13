// /a/{slug}/hypercites — the hypercite workbench as a SHELF OWNER uses it, driven
// with real gestures by a user who is NOT an admin:
//
//   archive page → open the library panel → the workbench button (owner only)
//   → the workbench opens → their own book's candidate is approvable, the commons
//   book's is view-only with the reason → approve → the ↗ is in Postgres and in
//   the reader pane after a fresh load → revert restores it.
//
// And the boundary, from the same session: /maintainer/hypercites is a 404 and
// the operator API refuses them — the owner workbench is a separate door, not a
// loosened admin gate.
//
// Runs as its OWN user. The shared e2e user cannot play this part — the admin
// console spec promotes it to admin permanently — so this spec ignores the shared
// storageState and logs in as the fixture's dedicated non-admin account.
//
// Fixture: `php artisan e2e:seed-shelf-workbench` (run in beforeAll, idempotent).
// Server rules are pinned in tests/Feature/Api/ShelfHyperciteWorkbenchTest.php;
// this is the real-browser pass over the same flow.
//
// Manual suite (npm run test:e2e) — not CI.

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readBookData } from '../../helpers/backendRead.js';

const APP_ROOT = resolve(import.meta.dirname, '../../../..');
const EMAIL = 'e2e-shelf-owner@hyperlit.test';
const PASSWORD = 'e2e-shelf-owner-password';
const ARCHIVE = '/a/e2e-workbench-shelf';
const OWN_BOOK = 'book_e2e_swb_own';
const CITED_BOOK = 'book_e2e_swb_cited';

// Serial (approve → revert is stateful) and generously timed: approve bumps the
// citing book's content clock, so the pane reload is a full reader re-sync.
test.describe.configure({ mode: 'serial', timeout: 120000 });

// A clean browser: NOT the shared (admin) e2e session. Service workers blocked
// for the same reason as the admin console spec — forced pane reloads through a
// freshly registered worker intermittently stall under the dev server.
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });

/** Log in as the fixture owner. In-page fetch: Sanctum's stateful auth needs the Origin. */
async function loginAsOwner(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const status = await page.evaluate(async ([email, password]) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    await res.text();
    return res.status;
  }, [EMAIL, PASSWORD]);
  expect(status, 'fixture owner login').toBe(200);
}

/**
 * Open the archive (library) panel. #archiveRef's handler is attached by
 * ButtonRegistry a few hundred ms after DOMContentLoaded, so an early click is
 * silently dropped — retry until the panel is actually open (and only click
 * while it is closed, so a retry cannot toggle it shut).
 */
async function openArchivePanel(page) {
  const panel = page.locator('#archive-container.open');
  await expect(async () => {
    if (!(await panel.isVisible())) await page.locator('#archiveRef').click();
    await expect(panel.locator('#download-archive-md')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
}

test.describe('shelf-owner hypercite workbench', () => {
  let seeded = false;

  test.beforeAll(() => {
    try {
      execSync('php artisan e2e:seed-shelf-workbench', { cwd: APP_ROOT, stdio: 'pipe' });
      seeded = true;
    } catch (err) {
      console.warn('e2e:seed-shelf-workbench failed — skipping suite:', String(err.stderr || err));
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!seeded, 'fixture seeding failed — is the local DB migrated?');
    await loginAsOwner(page);
  });

  test('the archive panel offers the workbench to the owner, and it opens', async ({ page }) => {
    await page.goto(ARCHIVE);
    await openArchivePanel(page);

    // Creator Tools is collapsed by default, like the book panel's.
    const button = page.locator('#archive-container #creator-tools-content #archive-hypercite-workbench');
    await expect(button).toBeHidden();
    await page.locator('#archive-container #creator-tools-toggle').click();
    await expect(button).toBeVisible({ timeout: 15000 });

    const [workbench] = await Promise.all([page.waitForEvent('popup'), button.click()]);
    await workbench.waitForLoadState('domcontentloaded');
    expect(new URL(workbench.url()).pathname).toBe(`${ARCHIVE}/hypercites`);
    await expect(workbench.locator('#hx-title')).toContainText('E2E Workbench Shelf');

    // Operator-only controls are not on the owner's page at all.
    await expect(workbench.locator('#hx-auto-approve')).toHaveCount(0);
    await expect(workbench.locator('#hx-import-all')).toHaveCount(0);
    await expect(workbench.locator('a[href^="/maintainer"]')).toHaveCount(0);
    await workbench.close();
  });

  test('a logged-out visitor is offered nothing and the page is a 404', async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const guest = await context.newPage();
    await guest.goto(ARCHIVE);
    await openArchivePanel(guest);
    await expect(guest.locator('#creator-tools-section')).toHaveCount(0);
    await expect(guest.locator('#archive-hypercite-workbench')).toHaveCount(0);

    const res = await guest.goto(`${ARCHIVE}/hypercites`);
    expect(res.status()).toBe(404);
    await context.close();
  });

  test('the operator console and its API stay closed to the owner', async ({ page }) => {
    const res = await page.goto('/maintainer/hypercites');
    expect(res.status()).toBe(404);
    const index = await page.goto('/maintainer');
    expect(index.status()).toBe(404);

    await page.goto(ARCHIVE);
    const api = await page.evaluate(async () => {
      const r = await fetch('/api/maintainer/hypercites/journals', { headers: { Accept: 'application/json' } });
      await r.text();
      return r.status;
    });
    expect(api).toBe(403);
  });

  test('own book is approvable, the commons book is view-only with the reason', async ({ page }) => {
    await page.goto(`${ARCHIVE}/hypercites`);
    const rows = page.locator('#hx-candidates-list .hx-row');
    await expect(rows).toHaveCount(2);

    const viewOnly = rows.filter({ hasText: 'view only' });
    await expect(viewOnly).toHaveCount(1);
    await viewOnly.click();
    await expect(page.locator('#hx-selected')).toBeVisible();
    await expect(page.locator('#hx-approve')).toBeDisabled();
    await expect(page.locator('#hx-reject')).toBeDisabled();
    await expect(page.locator('#hx-selected-status')).toContainText('citing book isn’t yours');

    const mine = rows.filter({ hasNotText: 'view only' });
    await mine.click();
    await expect(page.locator('#hx-approve')).toBeEnabled();
    await expect(page.locator('#hx-reject')).toBeEnabled();

    // Both panes are the real reader, opened on the owner's essay and the cited work.
    const citing = page.frameLocator('#hx-citing');
    await expect(citing.locator(`[data-node-id="${OWN_BOOK}_n1"]`)).toBeVisible({ timeout: 30000 });
  });

  test('approve mints into the owner’s book; revert restores it', async ({ page }) => {
    await page.goto(`${ARCHIVE}/hypercites`);
    await page.locator('#hx-candidates-list .hx-row').filter({ hasNotText: 'view only' }).click();
    await expect(page.locator('#hx-approve')).toBeEnabled();
    await page.locator('#hx-approve').click();
    await expect(page.locator('#hx-selected-status')).toContainText('✓ hypercited', { timeout: 15000 });
    await expect(page.locator('#hx-applied-list .hx-row')).toHaveCount(1);

    // Postgres is authoritative (the pane is mid-resync after the clock bump).
    const own = await readBookData(page, OWN_BOOK);
    expect(own.ok).toBe(true);
    const content = own.body.nodes.find((n) => n.node_id === `${OWN_BOOK}_n1`)?.content ?? '';
    expect(content).toContain(`<a href="/${CITED_BOOK}#hypercite_`);
    const cited = await readBookData(page, CITED_BOOK);
    expect(cited.body.metadata.total_hypercites).toBe(1);

    // And the reader agrees, from a fresh load.
    await page.reload();
    await page.locator('#hx-applied-list .hx-row').first().click();
    await expect(page.frameLocator('#hx-citing').locator('a.open-icon')).toBeVisible({ timeout: 60000 });

    await expect(page.locator('#hx-revert')).toBeEnabled();
    await page.locator('#hx-revert').click();
    await expect(page.locator('#hx-selected-status')).toContainText('reverted', { timeout: 15000 });

    const after = await readBookData(page, OWN_BOOK);
    expect(after.body.nodes.find((n) => n.node_id === `${OWN_BOOK}_n1`)?.content ?? '').not.toContain('open-icon');
    const citedAfter = await readBookData(page, CITED_BOOK);
    expect(citedAfter.body.metadata.total_hypercites).toBe(0);
  });
});
