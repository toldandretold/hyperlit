/**
 * Library ↔ user-page home-book sync — end to end, through real navigation.
 *
 * This is the integration guard for the server change that removed the
 * per-visit regeneration (UserHomeServerController): the user page now trusts
 * the INCREMENTAL home-book path, so the only thing keeping it correct is that
 * each library mutation updates the home book. This walks the three mutations
 * the way a user does and checks the user page reflects each after navigating:
 *
 *   create a book → nav to user page → card present
 *   edit its title → nav away + back → card shows the new title
 *   delete the book → nav away + back → card gone
 *
 * Create + delete go through the real UI (+ → Create, .book-actions → Delete).
 * The title edit goes through the real /api/db/library/upsert endpoint (the same
 * call the source-citation panel makes) — exercising updateBookOnUserPage and
 * the timestamp bump that tells the client cache to refetch — without driving
 * the heavyweight source-edit form.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe.serial('Library ↔ user-page home-book sync', () => {
  test('create → present, edit title → updates, delete → gone (across nav)', async ({ page, spa }) => {
    test.setTimeout(150_000);

    const gotoUserPage = async () => {
      await spa.navigateToUserPage(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('user');
    };

    /* ── 1. CREATE via the home + → Create flow ───────────────────────── */
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
    expect(bookId).toMatch(/^book_\d+$/);
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    const cardLink = `.libraryCard a[href$="/${bookId}"]`;
    const cardEl = `.libraryCard:has(a[href$="/${bookId}"])`;

    /* ── 2. New book is present on the user page ──────────────────────── */
    await gotoUserPage();
    await page.waitForSelector(cardLink, { timeout: 10000 });
    expect(await page.locator(cardLink).count(), 'created book should appear on user page').toBeGreaterThan(0);

    /* ── 3. Edit the title → user page reflects it after nav ──────────── */
    const newTitle = `Renamed Book ${Date.now()}`;
    const upsertOk = await page.evaluate(async ({ bookId, newTitle }) => {
      const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
      const res = await fetch('/api/db/library/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-TOKEN': csrf },
        credentials: 'include',
        body: JSON.stringify({ data: { book: bookId, title: newTitle, timestamp: Date.now() } }),
      });
      return res.ok;
    }, { bookId, newTitle });
    expect(upsertOk, 'library upsert (title change) should succeed').toBe(true);

    // Navigate away and back so the user page reloads the home-book content.
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);
    await gotoUserPage();
    await page.waitForSelector(cardLink, { timeout: 10000 });
    await expect(page.locator(cardEl).first()).toContainText(newTitle, { timeout: 10000 });

    /* ── 4. DELETE via the .book-actions → Delete menu (confirm dialog) ─ */
    page.once('dialog', (d) => d.accept());
    await page.locator(`.book-actions[data-book="${bookId}"]`).first().click();
    await page.waitForSelector('.floating-action-menu [data-action="delete"]', { timeout: 5000 });
    await page.click('.floating-action-menu [data-action="delete"]');
    // Let the DELETE request + home-book card removal propagate.
    await page.waitForTimeout(2000);

    /* ── 5. Deleted book is gone from the user page after nav ─────────── */
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);
    await gotoUserPage();
    // Wait DETERMINISTICALLY for the card to disappear rather than snapshotting after a fixed 500ms:
    // the delete propagates via a local card-node eviction + a server DELETE + the user page's
    // freshness pull, and under load that settles in >500ms (the flake seen in full-suite runs). A
    // real regression (book never removed) still fails this within the timeout.
    await expect(
      page.locator(cardLink),
      'deleted book should be gone from user page',
    ).toHaveCount(0, { timeout: 10000 });
  });
});
