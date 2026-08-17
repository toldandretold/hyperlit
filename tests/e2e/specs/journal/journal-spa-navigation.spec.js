/**
 * Journal SPA navigation — the transitions the grand tour doesn't cover
 * (its pathway inventory predates the 'journal' structure). Exercises the
 * real UI paths through the new SPA structure:
 *
 *   fresh /j/{slug}        → journal structure + registry init
 *   feed card click        → journal→reader (DifferentTemplate, SPA not reload)
 *   browser back           → popstate INTO /j/{slug} (the highest-risk path:
 *                            detectStructureFromUrl must return 'journal', not
 *                            try to load a book named 'j')
 *   browser forward        → back to the reader
 *   colon-squares click    → journal→home (SPA body swap; home fully alive)
 *
 * The SPA sentinel (a window token) proves each transition was in-page —
 * DifferentTemplateTransition falls back to window.location.href on error,
 * which "works" but means the SPA path silently broke.
 *
 * Precondition: the GSCJ pilot in the local registry with ≥1 readable
 * article; skips when the page 404s. Treat skips as gaps (CLAUDE.md).
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { verifyHomePage } from '../../helpers/pageVerifiers.js';

const JOURNAL_PATH = '/j/global-social-challenges-journal';

async function plantSentinel(page) {
  await page.evaluate(() => { window.__journalSpaSentinel = 'live'; });
}
async function sentinelSurvived(page) {
  return page.evaluate(() => window.__journalSpaSentinel === 'live');
}

/** Wait until the SPA has fully LANDED on a structure: data-page stamped AND
 *  the ButtonRegistry re-initialized for it (transitions destroy + rebuild
 *  the registry, so asserting right after the DOM swap races currentPage=null). */
async function awaitStructureSettled(page, spa, structure) {
  await page.waitForFunction(
    (s) => document.body.getAttribute('data-page') === s,
    structure,
    { timeout: 30_000 }
  );
  await expect
    .poll(async () => (await spa.getRegistryStatus(page))?.currentPage, { timeout: 30_000 })
    .toBe(structure);
}

test('full-text search result opens the reader highlighted at the match', async ({ page, spa }) => {
  test.setTimeout(60_000);

  const response = await page.goto(JOURNAL_PATH);
  test.skip(response.status() === 404, 'GSCJ not in this environment\'s registry');
  await page.waitForLoadState('networkidle');

  // Full-text mode, search, click the first match snippet.
  await page.locator('label:has(#journal-fulltext-toggle)').click();
  await page.fill('#journal-search-input', 'colonialism');
  const match = page.locator('#journal-search-results .search-result-match-link').first();
  await expect(match).toBeVisible({ timeout: 10_000 });
  const href = await match.getAttribute('href');
  await match.click();

  // Lands on the reader with a SINGLE clean hash (the '#2900#2900' regression:
  // DifferentTemplateTransition appended the hash to a targetUrl that already
  // carried it, so chunk targeting silently fell back to the top of the book).
  await expect(page.locator('.reader-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'reader');
  const url = await page.evaluate(() => location.pathname + location.hash);
  expect(url).toBe(href);
  expect((url.match(/#/g) || []).length).toBe(1);

  // The search toolbar opens with the query and highlights the match
  // (sessionStorage-driven: pendingHighlightQuery — same mechanism as home).
  await expect(page.locator('#search-toolbar.visible')).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('#search-input')).toHaveValue('colonialism');
  await expect(page.locator('.main-content mark.current, mark.current').first()).toBeAttached({ timeout: 15_000 });

  // BACK into the journal: search state restores across the SPA rebuild too
  // (not just reloads) — query + toggle come back from localStorage on init.
  await page.goBack();
  await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'journal');
  await expect(page.locator('#journal-search-input')).toHaveValue('colonialism');
  await expect(page.locator('#journal-fulltext-toggle')).toBeChecked();

  // Focusing the restored query re-runs the search — results appear without
  // typing anything (home's handleFocus semantics).
  await page.locator('#journal-search-input').click();
  await expect(page.locator('#journal-search-results .search-result-match-link').first()).toBeVisible({ timeout: 10_000 });
});

test('journal ↔ reader ↔ home: SPA transitions + popstate back into /j/{slug}', async ({ page, spa }) => {
  test.setTimeout(120_000);

  // ── fresh load: journal structure, registry initialized for 'journal' ──
  const response = await page.goto(JOURNAL_PATH);
  test.skip(response.status() === 404, 'GSCJ not in this environment\'s registry — run: php artisan journal:sync-registry --issn=2752-3349');
  await page.waitForLoadState('networkidle');

  expect(await spa.getStructure(page)).toBe('journal');
  await spa.assertRegistryHealthy(page, 'journal');

  // ── open the published feed and click into an article (journal→reader) ──
  await page.click('.arranger-button[data-sort="published"]');
  const cardLink = page.locator('.libraryCard a[href^="/"]').first();
  await expect(cardLink).toBeVisible({ timeout: 15_000 });

  await plantSentinel(page);
  await cardLink.click();
  await expect(page.locator('.reader-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'reader');
  expect(await sentinelSurvived(page)).toBe(true);          // SPA, not a reload
  await spa.assertRegistryHealthy(page, 'reader');
  // URL push is DifferentTemplateTransition's LAST step (after init) — poll.
  await expect
    .poll(() => page.evaluate(() => location.pathname), { timeout: 10_000 })
    .not.toBe(JOURNAL_PATH);

  // ── browser BACK into /j/{slug}: the popstate → 'journal' rebuild ──
  await plantSentinel(page);
  await page.goBack();
  await expect
    .poll(() => page.evaluate(() => location.pathname), { timeout: 30_000 })
    .toBe(JOURNAL_PATH);
  await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'journal');
  expect(await sentinelSurvived(page)).toBe(true);
  await spa.assertRegistryHealthy(page, 'journal');
  // the hero card actually renders (in-viewport, not the off-screen bug)
  await expect(page.locator('.fixed-header')).toBeVisible();
  await expect(page.locator('.journal-title')).toBeVisible();

  // ── browser FORWARD back to the reader ──
  await plantSentinel(page);
  await page.goForward();
  await expect(page.locator('.reader-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'reader');
  expect(await sentinelSurvived(page)).toBe(true);

  // ── journal → user page (user button → My Library) → BACK → feeds must
  //    still work. THE REGRESSION: the user page stamps window.isOwner=true,
  //    which leaked across the SPA back-transition and broke the journal's
  //    shelf-button guard (feed clicks silently did nothing). ──
  await page.goBack(); // reader → journal
  await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'journal');

  await page.click('#userButton');
  const myBooks = page.locator('#myBooksBtn');
  await expect(myBooks).toBeVisible({ timeout: 10_000 });
  await myBooks.click();
  await expect(page.locator('.user-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'user');

  await page.goBack(); // user → journal (popstate)
  await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'journal');

  // the feed buttons still work after the user-page round trip
  await page.click('.arranger-button[data-sort="lit"]');
  await expect(page.locator('#app-container.content-active')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  await page.click('#copy-feed-close');
  await expect(page.locator('#app-container.content-active')).toHaveCount(0);

  // ── colon-squares → home ──
  // NOTE: hero-state links navigate NATIVELY by architecture — the SPA link
  // interceptor is bound by lazyLoaderFactory, which only exists once a feed
  // has loaded content. So no SPA sentinel here: the contract is simply that
  // the colon link lands on a fully-alive home page. (We're already back on
  // the journal from the user-page round trip above.)
  await page.click('.journal-colon-link');
  await expect
    .poll(() => page.evaluate(() => location.pathname), { timeout: 30_000 })
    .toBe('/');
  await page.waitForLoadState('networkidle');
  await awaitStructureSettled(page, spa, 'home');
  // the full home landing contract (lava alive, registry, drop target, …)
  await verifyHomePage(page, spa);
});
