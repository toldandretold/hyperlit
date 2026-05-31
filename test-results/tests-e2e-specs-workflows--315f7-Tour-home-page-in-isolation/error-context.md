# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/workflows/spa-grand-tour.spec.js >> SPA Grand Tour >> home page in isolation
- Location: tests/e2e/specs/workflows/spa-grand-tour.spec.js:35:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * SPA Grand Tour.
  3   |  *
  4   |  * The catch-all SPA correctness test. Per-page verifiers are exercised in
  5   |  * isolation, then chained through every transition path, looped to surface
  6   |  * accumulation bugs, then walked back/forward through browser history to
  7   |  * surface bfcache / history-state bugs. Finally a deep-authoring lap creates
  8   |  * a book, hyperlights + hypercites text, navigates home, and runs one more
  9   |  * SPA cycle to verify the heavy-state didn't poison the next page.
  10  |  *
  11  |  * Each phase is a separate `test()` under describe.serial so you can run any
  12  |  * piece alone via `--grep`.
  13  |  */
  14  | 
  15  | import { test, expect } from '../../fixtures/navigation.fixture.js';
  16  | import {
  17  |   verifyHomePage,
  18  |   verifyUserPage,
  19  |   verifyReaderPage,
  20  |   moveCursorToEnd,
  21  |   findParagraphByText,
  22  |   waitForCloudGreen,
  23  | } from '../../helpers/pageVerifiers.js';
  24  | import {
  25  |   runTour,
  26  |   replayBackToStart,
  27  |   replayForwardToEnd,
  28  |   setupTourAnchor,
  29  | } from '../../helpers/spaTour.js';
  30  | 
  31  | test.describe.serial('SPA Grand Tour', () => {
  32  | 
  33  |   /* ── Phase 1: per-page verifiers in isolation ───────────────────── */
  34  | 
  35  |   test('home page in isolation', async ({ page, spa }) => {
  36  |     test.setTimeout(30_000);
> 37  |     await page.goto('/');
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  38  |     await page.waitForLoadState('networkidle');
  39  |     await verifyHomePage(page, spa);
  40  |   });
  41  | 
  42  |   test('user page in isolation', async ({ page, spa }) => {
  43  |     test.setTimeout(30_000);
  44  |     await page.goto('/');
  45  |     await page.waitForLoadState('networkidle');
  46  |     // Navigate via the real userButton → My Books SPA path
  47  |     const { navigateToUserPage } = await import('../../helpers/pageHelpers.js');
  48  |     await navigateToUserPage(page);
  49  |     await spa.waitForTransition(page);
  50  |     await verifyUserPage(page, spa);
  51  |   });
  52  | 
  53  |   test('reader page in isolation', async ({ page, spa }) => {
  54  |     test.setTimeout(45_000);
  55  |     await page.goto('/');
  56  |     await page.waitForLoadState('networkidle');
  57  |     const { clickFirstBookLink } = await import('../../helpers/pageHelpers.js');
  58  |     await clickFirstBookLink(page);
  59  |     await spa.waitForTransition(page);
  60  |     await verifyReaderPage(page, spa);
  61  |   });
  62  | 
  63  |   /* ── Phase 2: single tour lap ───────────────────────────────────── */
  64  | 
  65  |   test('single tour lap', async ({ page, spa }) => {
  66  |     test.setTimeout(120_000);
  67  |     await setupTourAnchor(page, spa);
  68  |     const history = await runTour(page, spa, { loops: 1 });
  69  |     expect(history.length).toBeGreaterThan(0);
  70  |   });
  71  | 
  72  |   /* ── Phase 3: three-lap tour (accumulation test) ────────────────── */
  73  | 
  74  |   test('three-lap tour (state accumulation)', async ({ page, spa }) => {
  75  |     test.setTimeout(300_000);
  76  |     await setupTourAnchor(page, spa);
  77  |     const history = await runTour(page, spa, { loops: 3 });
  78  |     // Sanity: history should have 3 × TOUR_STEPS.length entries
  79  |     expect(history.length).toBeGreaterThan(20);
  80  |   });
  81  | 
  82  |   /* ── Phase 4: back-button replay to start ───────────────────────── */
  83  | 
  84  |   test('back-button replay to start', async ({ page, spa }) => {
  85  |     test.setTimeout(240_000);
  86  |     await setupTourAnchor(page, spa);
  87  |     const history = await runTour(page, spa, { loops: 1 });
  88  |     await replayBackToStart(page, spa, history);
  89  |   });
  90  | 
  91  |   /* ── Phase 5: forward-button replay to end ──────────────────────── */
  92  | 
  93  |   test('forward-button replay to end', async ({ page, spa }) => {
  94  |     test.setTimeout(300_000);
  95  |     await setupTourAnchor(page, spa);
  96  |     const history = await runTour(page, spa, { loops: 1 });
  97  |     await replayBackToStart(page, spa, history);
  98  |     await replayForwardToEnd(page, spa, history);
  99  |   });
  100 | 
  101 |   /* ── Phase 6: deep authoring inside tour ────────────────────────── */
  102 |   /*
  103 |    * Mirrors the heaviest parts of authoring-workflow.spec.js:
  104 |    *   - Create a book via #newBook
  105 |    *   - Type heading + paragraph
  106 |    *   - Hyperlight a selection (assert <mark> appears)
  107 |    *   - Hypercite a different selection (capture clipboard payload)
  108 |    *   - Navigate home
  109 |    *   - Run a single tour lap after to prove authoring state didn't
  110 |    *     poison the next SPA cycle
  111 |    */
  112 |   test('authoring inside tour: create + hyperlight + hypercite + post-lap', async ({ page, spa }) => {
  113 |     test.setTimeout(180_000);
  114 | 
  115 |     // Start at home
  116 |     await page.goto('/');
  117 |     await page.waitForLoadState('networkidle');
  118 |     expect(await spa.getStructure(page)).toBe('home');
  119 | 
  120 |     // Create a book
  121 |     await page.evaluate(() => document.getElementById('newBook')?.click());
  122 |     await page.waitForFunction(() => {
  123 |       const c = document.getElementById('newbook-container');
  124 |       return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
  125 |     }, null, { timeout: 5000 });
  126 |     await page.evaluate(() => document.getElementById('createNewBook')?.click());
  127 | 
  128 |     await spa.waitForTransition(page);
  129 |     expect(await spa.getStructure(page)).toBe('reader');
  130 |     await spa.waitForEditMode(page);
  131 | 
  132 |     const bookId = await spa.getCurrentBookId(page);
  133 |     expect(bookId).toMatch(/^book_\d+$/);
  134 | 
  135 |     // Type heading + paragraph
  136 |     await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
  137 |     await page.click('h1[id="100"]');
```