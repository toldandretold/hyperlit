/**
 * User page (/u/{username}) — the comprehensive interaction suite.
 *
 * Every surface here shipped at least one bug that NO spec exercised
 * (2026-09-30 report): the owner's server-rendered visitor shelf pills were
 * dead (empty data-content fell through to the generic path and loaded ''
 * as a book id — the "Container element with id {username} not found"
 * cascade), and the Library recent snapshot silently missed books that the
 * live-queried "author a-z" view showed. The grand tour's verifyUserPage
 * counts pills but never clicks one; `visitor-shelf-tab` appeared ZERO
 * times under tests/e2e before this file.
 *
 * Phases (serial; each test is self-contained because contexts — and with
 * them localStorage — reset between tests):
 *   1. deferred hero → Library press → feed + history state
 *   2. sort switching: recent/author parity + label-vs-content agreement
 *   3. owner clicks a visitor shelf pill (THE bug-1 regression)
 *   4. anonymous visitor: pills, _pub feeds, private shelf hidden, deep link
 *   5. owner dynamic tabs: + picker, close ×, no duplicate over a pill
 *   6. pencil panel: visitor-pill curation round trip
 *   7. user search scoped to an open shelf
 *
 * Fixtures: `php artisan e2e:seed-user-shelves` (run in beforeAll) seeds
 * 2 public shelves (alpha, beta) + 1 private (gamma), 3 public member books,
 * and resets page_settings.pill_shelves — so destructive phases self-heal
 * on the next run.
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/navigation.fixture.js';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const USERNAME = process.env.E2E_TEST_USERNAME;

const ALPHA = 'e2e-shelf-alpha';
const BETA = 'e2e-shelf-beta';
const GAMMA_NAME = 'E2E Shelf Gamma';
const SEEDED_TITLES = ['E2E Alborz Mountains Reader', 'E2E Borges Compendium', 'E2E Zanzibar Chronicle'];

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let seeded = false;

test.beforeAll(() => {
  try {
    execSync('php artisan e2e:seed-user-shelves', { cwd: APP_ROOT, stdio: 'pipe' });
    seeded = true;
  } catch (err) {
    console.warn('e2e:seed-user-shelves failed — skipping suite:', String(err.stderr || err));
  }
});

test.afterAll(() => {
  // Re-seed so the pencil phase's pill_shelves toggling can never leak a
  // half-toggled state into other suites, even after a mid-run failure.
  if (seeded) {
    try { execSync('php artisan e2e:seed-user-shelves', { cwd: APP_ROOT, stdio: 'pipe' }); } catch { /* best effort */ }
  }
});

test.beforeEach(() => {
  test.skip(!USERNAME, 'E2E_TEST_USERNAME not set');
  test.skip(!seeded, 'fixture seeding failed — is the local DB migrated?');
});

/** Console-error gate for a phase: snapshot on entry, assert the slice clean. */
function consoleGate(page, spa) {
  const snapshot = spa.filterConsoleErrors(page.consoleErrors).length;
  return () => {
    const fresh = spa.filterConsoleErrors(page.consoleErrors).slice(snapshot);
    expect(fresh, `console errors during phase:\n${fresh.join('\n')}`).toHaveLength(0);
  };
}

async function gotoUserPage(page, spa) {
  await page.goto(`/u/${USERNAME}`);
  await page.waitForSelector('.arranger-button[data-filter="library"]', { timeout: 15_000 });
  // Fresh loads bind the pill click handlers during registry init — clicking
  // before homepageDisplayUnit is bound is a silent no-op (the documented
  // post-nav button-probe race). The registry poll is the bound-ness signal.
  await spa.assertRegistryHealthy(page, 'user');
}

async function openLibraryFeed(page) {
  await page.click('.arranger-button[data-filter="library"]');
  await page.waitForSelector('.libraryCard a', { timeout: 15_000 });
}

test('phase 1: deferred hero, Library press loads the feed and persists the tab', async ({ page, spa }) => {
  const gate = consoleGate(page, spa);
  await gotoUserPage(page, spa);

  // The plain URL defers the feed: hero only, no active tab, no main content
  // (the client mirror of UserPageSeoTest's server-side assertions).
  expect(await page.locator('.main-content').count()).toBe(0);
  expect(await page.locator('.arranger-button.active').count()).toBe(0);

  await openLibraryFeed(page);

  expect(await page.locator('.arranger-button[data-filter="library"]').getAttribute('class')).toContain('active');
  expect(await page.locator('#shelf-header').count()).toBe(1);

  const histTab = await page.evaluate(() => history.state?.userPageActiveTab || null);
  expect(histTab?.filter).toBe('library');
  expect(histTab?.content, 'an empty content id must never be persisted').toBeTruthy();

  await spa.assertRegistryHealthy(page, 'user');
  gate();
});

test('phase 2: sort switch shows the same books, and the label matches the content after reload', async ({ page, spa }) => {
  const gate = consoleGate(page, spa);
  await gotoUserPage(page, spa);
  await openLibraryFeed(page);

  // Feeds are lazy-chunked (this account holds thousands of books), so the
  // RENDERED cards are only the first chunk of each ordering — compare the
  // chunk manifest's total card count instead: it covers the WHOLE feed.
  const manifestTotal = () => page.evaluate(() =>
    (window.chunkManifest || []).reduce((sum, c) => sum + (c.node_count || 0), 0));

  // A freshly seeded book sits at the top of recent (created_at refreshed by
  // the seed) — the rendered feed really shows it.
  await expect(page.locator('.main-content .libraryCard', { hasText: SEEDED_TITLES[0] })).toHaveCount(1);
  const recentTotal = await manifestTotal();
  expect(recentTotal).toBeGreaterThanOrEqual(3);

  // Switch to Author (A–Z) — a LIVE query into a synthetic {u}_{vis}_author
  // book. The bug-2 report was exactly "Library missing a book that author
  // a-z shows": the two views must hold the SAME set, so their full-feed
  // card counts must match.
  const renderResp = page.waitForResponse((r) => r.url().includes('/api/user-home/render'), { timeout: 15_000 });
  await page.selectOption('.shelf-sort-select', 'author');
  await renderResp;
  await page.waitForFunction(() => document.querySelector('.main-content')?.id?.includes('_author'), null, { timeout: 15_000 });
  await page.waitForSelector('.main-content .libraryCard a', { timeout: 30_000 });

  const authorTotal = await manifestTotal();
  expect(authorTotal, 'recent and author-sorted feeds must contain the same number of books').toBe(recentTotal);

  // Reload: the saved sort must be HONOURED, not just worn as a label over
  // the recent snapshot (the old behavior — the label lied).
  await page.reload();
  await page.waitForSelector('.main-content .libraryCard a', { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector('.main-content')?.id?.includes('_author'), null, { timeout: 15_000 });
  expect(await page.locator('.shelf-sort-select').inputValue()).toBe('author');

  // Leave the account on recent for later phases (server-side state is
  // per-browser localStorage, but be a good citizen within this context).
  await page.selectOption('.shelf-sort-select', 'recent');
  await page.waitForFunction(() => !document.querySelector('.main-content')?.id?.includes('_author'), null, { timeout: 15_000 });

  gate();
});

test('phase 3: the OWNER clicking a visitor shelf pill loads the shelf (bug-1 regression)', async ({ page, spa }) => {
  const gate = consoleGate(page, spa);
  await gotoUserPage(page, spa);

  const pill = page.locator(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`);
  await expect(pill).toHaveCount(1);
  const shelfId = await pill.getAttribute('data-shelf-id');

  // The owner resolves via the AUTHED endpoint and mints the owner content id
  // (shelf_{id}_{sort}, no _pub) — same id a dynamic tab would mint.
  const renderResp = page.waitForResponse((r) => r.url().includes(`/api/shelves/${shelfId}/render`), { timeout: 15_000 });
  await pill.click();
  await renderResp;
  await page.waitForSelector('.main-content .libraryCard a', { timeout: 15_000 });

  const contentId = await page.evaluate(() => document.querySelector('.main-content')?.id || '');
  expect(contentId).toBe(`shelf_${shelfId}_recent`);
  expect(await pill.getAttribute('data-content')).toBe(contentId);

  // All three seeded members render.
  for (const title of SEEDED_TITLES) {
    await expect(page.locator('.main-content .libraryCard', { hasText: title })).toHaveCount(1);
  }

  // Owner shelf header: editable title (a visitor header would not be).
  await expect(page.locator('#shelf-header .shelf-header-title')).toHaveAttribute('contenteditable', 'true');

  // Nothing empty was persisted, and the restore path re-resolves on reload.
  const stored = await page.evaluate(() => localStorage.getItem('homepage_active_button'));
  expect(stored === null || stored.length > 0).toBe(true);

  await page.reload();
  await page.waitForSelector('.main-content .libraryCard a', { timeout: 20_000 });
  expect(await page.evaluate(() => document.querySelector('.main-content')?.id || '')).toBe(`shelf_${shelfId}_recent`);
  await expect(page.locator(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`)).toHaveClass(/active/);

  await spa.assertRegistryHealthy(page, 'user');
  gate();
});

test('phase 4: anonymous visitor — public pills work, private shelf hidden, deep link active', async ({ browser, spa }) => {
  // Explicit empty storageState: a bare newContext() INHERITS the project's
  // authed state (documented trap).
  const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await page.goto(`/u/${USERNAME}`);
    await page.waitForSelector('.arranger-button[data-filter="library"]', { timeout: 15_000 });
    // Same bind race as gotoUserPage: don't click pills before the registry
    // reports the click handlers bound.
    await spa.assertRegistryHealthy(page, 'user');

    // Both public shelves show as pills; the private one never does.
    await expect(page.locator(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`)).toHaveCount(1);
    await expect(page.locator(`.visitor-shelf-tab[data-shelf-slug="${BETA}"]`)).toHaveCount(1);
    await expect(page.locator('.visitor-shelf-tab', { hasText: GAMMA_NAME })).toHaveCount(0);

    // A pill click resolves through the PUBLIC endpoint into the _pub render.
    const pill = page.locator(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`);
    const shelfId = await pill.getAttribute('data-shelf-id');
    const renderResp = page.waitForResponse((r) => r.url().includes(`/api/public/shelves/${shelfId}/render`), { timeout: 15_000 });
    await pill.click();
    await renderResp;
    await page.waitForSelector('.main-content .libraryCard a', { timeout: 15_000 });
    expect(await page.evaluate(() => document.querySelector('.main-content')?.id || '')).toMatch(/^shelf_.+_pub$/);

    // Shelf deep link: the tab renders ACTIVE on first paint and the boot
    // path resolves it (homepageDisplayUnit's restore arm).
    await page.goto(`/u/${USERNAME}/shelf/${BETA}`);
    await page.waitForSelector(`.visitor-shelf-tab.active[data-shelf-slug="${BETA}"]`, { timeout: 15_000 });
    await page.waitForSelector('.main-content .libraryCard a', { timeout: 15_000 });
    expect(await page.evaluate(() => document.querySelector('.main-content')?.id || '')).toMatch(/^shelf_.+_pub$/);
  } finally {
    await context.close();
  }
});

test('phase 5: dynamic shelf tabs — + picker opens, × closes back to Library, no duplicate over a pill', async ({ page, spa }) => {
  const gate = consoleGate(page, spa);
  await gotoUserPage(page, spa);

  const openPicker = async () => {
    await page.click('#shelf-picker-trigger');
    await page.waitForSelector('#shelf-picker-dropdown', { timeout: 5000 });
  };

  // Open the PRIVATE shelf (it has no visitor pill, so a dynamic tab mints).
  await openPicker();
  await page.locator('#shelf-picker-dropdown .shelf-picker-item', { hasText: GAMMA_NAME }).click();
  const gammaTab = page.locator('.shelf-tab', { hasText: GAMMA_NAME });
  await expect(gammaTab).toHaveCount(1);
  await page.waitForSelector('.main-content .libraryCard a', { timeout: 15_000 });
  expect(await page.evaluate(() => document.querySelector('.main-content')?.id || '')).toMatch(/^shelf_/);

  // The dynamic tab sits INSIDE the scroller, before the trigger.
  const tabThenTrigger = await page.evaluate(() => {
    const tab = document.querySelector('.shelf-tab');
    const trigger = document.getElementById('shelf-picker-trigger');
    return !!tab && !!trigger && !!(tab.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(tabThenTrigger).toBe(true);

  // × closes the tab and falls back to the LIBRARY pill (the old fallback
  // targeted the long-gone data-filter="public" and left no tab active).
  await gammaTab.locator('.shelf-tab-close').click();
  await expect(gammaTab).toHaveCount(0);
  await expect(page.locator('.arranger-button.active[data-filter="library"]')).toHaveCount(1);
  await page.waitForSelector('.main-content .libraryCard a', { timeout: 15_000 });

  // Opening a shelf that already has a visitor PILL activates the pill —
  // no duplicate button for the same shelf.
  const alphaPill = page.locator(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`);
  const alphaId = await alphaPill.getAttribute('data-shelf-id');
  await openPicker();
  await page.locator('#shelf-picker-dropdown .shelf-picker-item', { hasText: 'E2E Shelf Alpha' }).click();
  await page.waitForSelector('.main-content .libraryCard a', { timeout: 15_000 });
  await expect(page.locator(`.arranger-button[data-shelf-id="${alphaId}"]`)).toHaveCount(1);
  await expect(alphaPill).toHaveClass(/active/);

  gate();
});

test('phase 6: pencil panel — unticking a visitor pill hides it, re-ticking restores it', async ({ page, spa }) => {
  const gate = consoleGate(page, spa);
  await gotoUserPage(page, spa);

  const alphaId = await page.locator(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`).getAttribute('data-shelf-id');

  const togglePill = async (expectChecked) => {
    // userPageEditor is required:false and NOT in assertRegistryHealthy's
    // expected list, so its document-level click handler can bind AFTER the
    // health poll passes — retry the pencil until edit mode engages.
    await expect.poll(async () => {
      const editing = await page.evaluate(() => document.body.classList.contains('user-page-editing'));
      if (editing) return true;
      await page.click('#editButton');
      return page.evaluate(() => document.body.classList.contains('user-page-editing'));
    }, { timeout: 10_000, intervals: [250, 500, 1000] }).toBe(true);
    await page.waitForSelector('#user-page-edit-panel:not(.hidden)', { timeout: 5000 });
    const checkbox = page.locator(`#user-page-edit-panel [data-pill-shelf="${alphaId}"]`);
    await expect(checkbox).toBeChecked({ checked: expectChecked });
    const putResp = page.waitForResponse(
      (r) => r.url().includes('/api/user-home/page-settings') && r.request().method() === 'PUT',
      { timeout: 10_000 }
    );
    await checkbox.setChecked(!expectChecked);
    const resp = await putResp;
    expect(resp.ok()).toBe(true);
    await page.click('#user-page-edit-panel [data-done]');
  };

  // Untick alpha → reload → its pill is gone, beta's remains.
  await togglePill(true);
  await page.reload();
  await page.waitForSelector('.arranger-button[data-filter="library"]', { timeout: 15_000 });
  await expect(page.locator(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`)).toHaveCount(0);
  await expect(page.locator(`.visitor-shelf-tab[data-shelf-slug="${BETA}"]`)).toHaveCount(1);

  // Re-tick → pill returns. (afterAll's re-seed is the safety net if this
  // half fails.)
  await togglePill(false);
  await page.reload();
  await page.waitForSelector(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`, { timeout: 15_000 });

  gate();
});

test('phase 7: user search narrows to the open shelf', async ({ page, spa }) => {
  const gate = consoleGate(page, spa);
  await gotoUserPage(page, spa);

  const pill = page.locator(`.visitor-shelf-tab[data-shelf-slug="${ALPHA}"]`);
  const shelfId = await pill.getAttribute('data-shelf-id');
  await pill.click();
  await page.waitForSelector('.main-content .libraryCard a', { timeout: 15_000 });

  // With the shelf tab open, the search request carries &shelf={uuid} (the
  // sub-scope seam — until now only unit-tested).
  const searchResp = page.waitForResponse(
    (r) => r.url().includes('/search') && r.url().includes(`shelf=${shelfId}`),
    { timeout: 15_000 }
  );
  await page.fill('#user-search-input', 'Zanzibar');
  await searchResp;

  await expect(page.locator('#user-search-results')).toContainText('Zanzibar', { timeout: 10_000 });

  gate();
});
