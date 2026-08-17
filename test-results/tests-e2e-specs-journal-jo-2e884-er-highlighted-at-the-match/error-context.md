# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/journal/journal-spa-navigation.spec.js >> full-text search result opens the reader highlighted at the match
- Location: tests/e2e/specs/journal/journal-spa-navigation.spec.js:47:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/j/global-social-challenges-journal", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * Journal SPA navigation — the transitions the grand tour doesn't cover
  3   |  * (its pathway inventory predates the 'journal' structure). Exercises the
  4   |  * real UI paths through the new SPA structure:
  5   |  *
  6   |  *   fresh /j/{slug}        → journal structure + registry init
  7   |  *   feed card click        → journal→reader (DifferentTemplate, SPA not reload)
  8   |  *   browser back           → popstate INTO /j/{slug} (the highest-risk path:
  9   |  *                            detectStructureFromUrl must return 'journal', not
  10  |  *                            try to load a book named 'j')
  11  |  *   browser forward        → back to the reader
  12  |  *   colon-squares click    → journal→home (SPA body swap; home fully alive)
  13  |  *
  14  |  * The SPA sentinel (a window token) proves each transition was in-page —
  15  |  * DifferentTemplateTransition falls back to window.location.href on error,
  16  |  * which "works" but means the SPA path silently broke.
  17  |  *
  18  |  * Precondition: the GSCJ pilot in the local registry with ≥1 readable
  19  |  * article; skips when the page 404s. Treat skips as gaps (CLAUDE.md).
  20  |  */
  21  | import { test, expect } from '../../fixtures/navigation.fixture.js';
  22  | import { verifyHomePage } from '../../helpers/pageVerifiers.js';
  23  | 
  24  | const JOURNAL_PATH = '/j/global-social-challenges-journal';
  25  | 
  26  | async function plantSentinel(page) {
  27  |   await page.evaluate(() => { window.__journalSpaSentinel = 'live'; });
  28  | }
  29  | async function sentinelSurvived(page) {
  30  |   return page.evaluate(() => window.__journalSpaSentinel === 'live');
  31  | }
  32  | 
  33  | /** Wait until the SPA has fully LANDED on a structure: data-page stamped AND
  34  |  *  the ButtonRegistry re-initialized for it (transitions destroy + rebuild
  35  |  *  the registry, so asserting right after the DOM swap races currentPage=null). */
  36  | async function awaitStructureSettled(page, spa, structure) {
  37  |   await page.waitForFunction(
  38  |     (s) => document.body.getAttribute('data-page') === s,
  39  |     structure,
  40  |     { timeout: 30_000 }
  41  |   );
  42  |   await expect
  43  |     .poll(async () => (await spa.getRegistryStatus(page))?.currentPage, { timeout: 30_000 })
  44  |     .toBe(structure);
  45  | }
  46  | 
  47  | test('full-text search result opens the reader highlighted at the match', async ({ page, spa }) => {
  48  |   test.setTimeout(60_000);
  49  | 
> 50  |   const response = await page.goto(JOURNAL_PATH);
      |                               ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  51  |   test.skip(response.status() === 404, 'GSCJ not in this environment\'s registry');
  52  |   await page.waitForLoadState('networkidle');
  53  | 
  54  |   // Full-text mode, search, click the first match snippet.
  55  |   await page.locator('label:has(#journal-fulltext-toggle)').click();
  56  |   await page.fill('#journal-search-input', 'colonialism');
  57  |   const match = page.locator('#journal-search-results .search-result-match-link').first();
  58  |   await expect(match).toBeVisible({ timeout: 10_000 });
  59  |   const href = await match.getAttribute('href');
  60  |   await match.click();
  61  | 
  62  |   // Lands on the reader with a SINGLE clean hash (the '#2900#2900' regression:
  63  |   // DifferentTemplateTransition appended the hash to a targetUrl that already
  64  |   // carried it, so chunk targeting silently fell back to the top of the book).
  65  |   await expect(page.locator('.reader-content-wrapper')).toBeAttached({ timeout: 30_000 });
  66  |   await awaitStructureSettled(page, spa, 'reader');
  67  |   const url = await page.evaluate(() => location.pathname + location.hash);
  68  |   expect(url).toBe(href);
  69  |   expect((url.match(/#/g) || []).length).toBe(1);
  70  | 
  71  |   // The search toolbar opens with the query and highlights the match
  72  |   // (sessionStorage-driven: pendingHighlightQuery — same mechanism as home).
  73  |   await expect(page.locator('#search-toolbar.visible')).toBeAttached({ timeout: 20_000 });
  74  |   await expect(page.locator('#search-input')).toHaveValue('colonialism');
  75  |   await expect(page.locator('.main-content mark.current, mark.current').first()).toBeAttached({ timeout: 15_000 });
  76  | 
  77  |   // BACK into the journal: search state restores across the SPA rebuild too
  78  |   // (not just reloads) — query + toggle come back from localStorage on init.
  79  |   await page.goBack();
  80  |   await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  81  |   await awaitStructureSettled(page, spa, 'journal');
  82  |   await expect(page.locator('#journal-search-input')).toHaveValue('colonialism');
  83  |   await expect(page.locator('#journal-fulltext-toggle')).toBeChecked();
  84  | 
  85  |   // Focusing the restored query re-runs the search — results appear without
  86  |   // typing anything (home's handleFocus semantics).
  87  |   await page.locator('#journal-search-input').click();
  88  |   await expect(page.locator('#journal-search-results .search-result-match-link').first()).toBeVisible({ timeout: 10_000 });
  89  | });
  90  | 
  91  | test('journal ↔ reader ↔ home: SPA transitions + popstate back into /j/{slug}', async ({ page, spa }) => {
  92  |   test.setTimeout(120_000);
  93  | 
  94  |   // ── fresh load: journal structure, registry initialized for 'journal' ──
  95  |   const response = await page.goto(JOURNAL_PATH);
  96  |   test.skip(response.status() === 404, 'GSCJ not in this environment\'s registry — run: php artisan journal:sync-registry --issn=2752-3349');
  97  |   await page.waitForLoadState('networkidle');
  98  | 
  99  |   expect(await spa.getStructure(page)).toBe('journal');
  100 |   await spa.assertRegistryHealthy(page, 'journal');
  101 | 
  102 |   // ── open the published feed and click into an article (journal→reader) ──
  103 |   await page.click('.arranger-button[data-sort="published"]');
  104 |   const cardLink = page.locator('.libraryCard a[href^="/"]').first();
  105 |   await expect(cardLink).toBeVisible({ timeout: 15_000 });
  106 | 
  107 |   await plantSentinel(page);
  108 |   await cardLink.click();
  109 |   await expect(page.locator('.reader-content-wrapper')).toBeAttached({ timeout: 30_000 });
  110 |   await awaitStructureSettled(page, spa, 'reader');
  111 |   expect(await sentinelSurvived(page)).toBe(true);          // SPA, not a reload
  112 |   await spa.assertRegistryHealthy(page, 'reader');
  113 |   // URL push is DifferentTemplateTransition's LAST step (after init) — poll.
  114 |   await expect
  115 |     .poll(() => page.evaluate(() => location.pathname), { timeout: 10_000 })
  116 |     .not.toBe(JOURNAL_PATH);
  117 | 
  118 |   // ── browser BACK into /j/{slug}: the popstate → 'journal' rebuild ──
  119 |   await plantSentinel(page);
  120 |   await page.goBack();
  121 |   await expect
  122 |     .poll(() => page.evaluate(() => location.pathname), { timeout: 30_000 })
  123 |     .toBe(JOURNAL_PATH);
  124 |   await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  125 |   await awaitStructureSettled(page, spa, 'journal');
  126 |   expect(await sentinelSurvived(page)).toBe(true);
  127 |   await spa.assertRegistryHealthy(page, 'journal');
  128 |   // the hero card actually renders (in-viewport, not the off-screen bug)
  129 |   await expect(page.locator('.fixed-header')).toBeVisible();
  130 |   await expect(page.locator('.journal-title')).toBeVisible();
  131 | 
  132 |   // ── browser FORWARD back to the reader ──
  133 |   await plantSentinel(page);
  134 |   await page.goForward();
  135 |   await expect(page.locator('.reader-content-wrapper')).toBeAttached({ timeout: 30_000 });
  136 |   await awaitStructureSettled(page, spa, 'reader');
  137 |   expect(await sentinelSurvived(page)).toBe(true);
  138 | 
  139 |   // ── journal → user page (user button → My Library) → BACK → feeds must
  140 |   //    still work. THE REGRESSION: the user page stamps window.isOwner=true,
  141 |   //    which leaked across the SPA back-transition and broke the journal's
  142 |   //    shelf-button guard (feed clicks silently did nothing). ──
  143 |   await page.goBack(); // reader → journal
  144 |   await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  145 |   await awaitStructureSettled(page, spa, 'journal');
  146 | 
  147 |   await page.click('#userButton');
  148 |   const myBooks = page.locator('#myBooksBtn');
  149 |   await expect(myBooks).toBeVisible({ timeout: 10_000 });
  150 |   await myBooks.click();
```