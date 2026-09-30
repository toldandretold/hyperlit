/**
 * User-page content sync — the "is my book LOST?" suite.
 *
 * Two loops that previously had no browser coverage, both ending in the user
 * asking "where is my book":
 *
 *   1. FILE-DROP IMPORT → user page. Imports ride ProcessDocumentImportJob
 *      through ImportController's async path — which historically NEVER
 *      inserted the user-page card (only bulkCreate did), so an imported book
 *      existed, was readable, appeared under "author a-z" (live query)… and
 *      was invisible on the default Library view. The fix routes the path
 *      through LibraryService::syncHomepage (upsert); this test walks the
 *      whole thing with a real markdown drop and a real queue worker.
 *
 *   2. VISIBILITY TOGGLE → Public/Private/All views. The reader's source
 *      panel flips a book private↔public (moveBookBetweenHomeBooks moves the
 *      card between {u}/{u}Private and re-flags it in {u}All). Covered
 *      server-side by PrivacyToggleHomeBookTest.php; this walks the real
 *      gestures: source panel → visibility popover → confirm dialog → user
 *      page → the owner's All/Public/Private filter dropdown.
 *
 * Prereqs: import queue worker running (`npm run dev:all` — test 1 skips
 * with a clear message if absent) and the e2e account publish-verified
 * (done in beforeAll via `php artisan e2e:verify-user`).
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { importMarkdownBook } from '../../helpers/bookContent.js';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const USERNAME = process.env.E2E_TEST_USERNAME;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let importWorkerRunning = false;

test.beforeAll(() => {
  if (!USERNAME) return;
  // The visibility test publishes a book; the post-2026-09-22 publish gate
  // requires a verified email — verify through the dev-only artisan seam.
  try {
    execSync(`php artisan e2e:verify-user ${USERNAME}`, { cwd: APP_ROOT, stdio: 'pipe' });
  } catch { /* already verified / older account — the gate check is server-side */ }
  // Import test needs a consumer on the imports lane — detect it up front so
  // a missing worker reads as a SKIP, not a 90s landing-failure red herring
  // (the documented e2e-import-hang trap).
  try {
    const ps = execSync('ps ax -o command', { stdio: 'pipe' }).toString();
    importWorkerRunning = /queue:work[^\n]*imports/.test(ps);
  } catch { importWorkerRunning = false; }
});

test.beforeEach(() => {
  test.skip(!USERNAME, 'E2E_TEST_USERNAME not set');
});

async function gotoUserLibrary(page, spa) {
  await page.goto(`/u/${USERNAME}`);
  await page.waitForSelector('.arranger-button[data-filter="library"]', { timeout: 15_000 });
  await spa.assertRegistryHealthy(page, 'user');
  await page.click('.arranger-button[data-filter="library"]');
  await page.waitForSelector('.libraryCard a', { timeout: 30_000 });
}

/** Owner's All/Public/Private title dropdown on the Library shelf header. */
async function setLibraryFilter(page, label, expectedContentId) {
  await page.click('#shelf-header .shelf-header-title.clickable');
  await page.waitForSelector('#library-filter-dropdown', { timeout: 5000 });
  await page.locator('#library-filter-dropdown button', { hasText: label }).click();
  await page.waitForFunction(
    (expected) => document.querySelector('.main-content')?.id === expected,
    expectedContentId,
    { timeout: 30_000 }
  );
}

/** Delete a book through the real card menu (native confirm). */
async function deleteViaCardMenu(page, bookId) {
  page.once('dialog', (d) => d.accept());
  await page.locator(`.book-actions[data-book="${bookId}"]`).first().click();
  await page.waitForSelector('.floating-action-menu [data-action="delete"]', { timeout: 5000 });
  await page.click('.floating-action-menu [data-action="delete"]');
  await expect(page.locator(`.libraryCard a[href$="/${bookId}"]`)).toHaveCount(0, { timeout: 15_000 });
}

test('a file-drop import shows up on the user page Library', async ({ page, spa }) => {
  test.skip(!importWorkerRunning, 'no imports-lane queue worker running (start via npm run dev:all)');

  // Real markdown drop → cite-form → queued job → reader landing.
  const { bookId } = await importMarkdownBook(page, spa, {
    name: 'e2e-user-sync-import.md',
    content: [
      '# E2E User Sync Import',
      '',
      'A throwaway book proving an IMPORTED book gets its user-page card.',
      '',
      'Second paragraph for scroll depth.',
    ].join('\n'),
  });

  // The import path creates the book PRIVATE; the owner's default Library
  // (All) must show it — this is the exact loop that used to lose books.
  await gotoUserLibrary(page, spa);
  const card = page.locator(`.libraryCard:has(a[href$="/${bookId}"])`);
  await expect(card, 'imported book must appear on the user page').toHaveCount(1, { timeout: 30_000 });
  // Its title (extracted by the import job's metadata pass) reaches the card
  // too — updateLibraryMetadata now syncs the card, not just the row.
  await expect(card.first()).toContainText('E2E User Sync Import', { timeout: 30_000 });

  await deleteViaCardMenu(page, bookId);
});

test('a visibility toggle moves the card across the All/Public/Private views', async ({ page, spa }) => {
  /* ── create a throwaway book (born private) ─────────────────────────── */
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.getElementById('newBookButton')?.click());
  await page.waitForFunction(() => {
    const c = document.getElementById('newbook-container');
    return c && window.getComputedStyle(c).opacity === '1' && c.getBoundingClientRect().width > 0;
  }, null, { timeout: 5000 });
  await page.evaluate(() => document.getElementById('createNewBook')?.click());
  await spa.waitForTransition(page);
  expect(await spa.getStructure(page)).toBe('reader');
  await spa.waitForEditMode(page);
  const bookId = await spa.getCurrentBookId(page);
  await page.click('#editButton');
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

  /* ── flip it PUBLIC through the real source-panel control ───────────── */
  const setVisibility = async (target) => {
    await page.click('#cloudRef');
    await page.waitForFunction(() => !!document.querySelector('#source-container.open'), null, { timeout: 8000 });
    await page.waitForSelector('#visibility-control .visibility-trigger', { timeout: 8000 });
    await page.click('#visibility-control .visibility-trigger');
    await page.waitForSelector('#visibility-control .visibility-panel .visibility-option', { timeout: 5000 });
    await page.click(`#visibility-control .visibility-option[data-target="${target}"]`);
    // Both directions confirm through the app dialog (focus-trapped).
    await page.waitForSelector('.app-dialog-card [data-act="confirm"]', { timeout: 5000 });
    await page.click('.app-dialog-card [data-act="confirm"]');
    await page.waitForSelector(`#visibility-control[data-state="${target}"]`, { timeout: 15_000 });
    // Close the panel + container so navigation starts clean.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  };
  await setVisibility('public');

  /* ── user page: All shows it un-flagged, Public has it, Private not ─── */
  await gotoUserLibrary(page, spa);
  const homeIds = await page.evaluate(() => ({
    all: window.allBook,
    pub: window.userPageBook,
    priv: window.userPageBook + 'Private',
  }));
  const card = page.locator(`.libraryCard:has(a[href$="/${bookId}"])`);

  await setLibraryFilter(page, 'All', homeIds.all);
  await expect(card, 'public book present in All view').toHaveCount(1, { timeout: 30_000 });
  await expect(card.first(), 'All-view card must not wear the private flag').not.toHaveClass(/libraryCard-private/);

  await setLibraryFilter(page, 'Public', homeIds.pub);
  await expect(card, 'public book present in Public view').toHaveCount(1, { timeout: 30_000 });

  await setLibraryFilter(page, 'Private', homeIds.priv);
  await expect(card, 'public book absent from Private view').toHaveCount(0, { timeout: 30_000 });

  /* ── flip BACK to private in the reader, re-check all three views ───── */
  await page.goto(`/${bookId}`);
  await page.waitForLoadState('networkidle');
  await setVisibility('private');

  await gotoUserLibrary(page, spa);
  await setLibraryFilter(page, 'Private', homeIds.priv);
  await expect(card, 'private book present in Private view').toHaveCount(1, { timeout: 30_000 });

  await setLibraryFilter(page, 'Public', homeIds.pub);
  await expect(card, 'private book absent from Public view').toHaveCount(0, { timeout: 30_000 });

  await setLibraryFilter(page, 'All', homeIds.all);
  await expect(card, 'private book still present in All view').toHaveCount(1, { timeout: 30_000 });
  await expect(card.first(), 'All-view card wears the private flag again').toHaveClass(/libraryCard-private/);

  /* ── cleanup (leaves the filter on All, the default) ────────────────── */
  await deleteViaCardMenu(page, bookId);
});
