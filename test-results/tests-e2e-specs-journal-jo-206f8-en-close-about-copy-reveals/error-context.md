# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/specs/journal/journal-hero.spec.js >> journal hero: glass card renders in-viewport, feeds open/close, about copy reveals
- Location: tests/e2e/specs/journal/journal-hero.spec.js:20:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/j/global-social-challenges-journal", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * Journal home page (`/j/{slug}`): the homepage's lava-lamp glass hero scoped
  3   |  * to one journal, with shelf-backed feeds. Mirrors home-lava-homepage.spec.js
  4   |  * but adds RENDERED-GEOMETRY assertions — the journal page shares home's CSS
  5   |  * only through explicit `body[data-page="journal"]` selector extensions
  6   |  * (homepage.css, base/layout.css, perimeterGlass.css), and a missed selector
  7   |  * leaves the DOM correct while the card renders off-screen/unstyled. That is
  8   |  * exactly the failure mode PHP markup tests cannot see.
  9   |  *
  10  |  * Precondition: a harvested journal in the local registry (the GSCJ pilot).
  11  |  * The spec skips when the page 404s, so a fresh DB is a skip, not a failure —
  12  |  * treat skips as gaps (CLAUDE.md).
  13  |  */
  14  | import { test, expect } from '../../fixtures/navigation.fixture.js';
  15  | 
  16  | test.use({ reducedMotion: 'no-preference' });
  17  | 
  18  | const JOURNAL_PATH = '/j/global-social-challenges-journal';
  19  | 
  20  | test('journal hero: glass card renders in-viewport, feeds open/close, about copy reveals', async ({ page }) => {
  21  |   test.setTimeout(90_000);
  22  | 
> 23  |   const response = await page.goto(JOURNAL_PATH);
      |                               ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  24  |   test.skip(response.status() === 404, 'GSCJ not in this environment\'s registry — run: php artisan journal:sync-registry --issn=2752-3349');
  25  |   await page.waitForLoadState('networkidle');
  26  | 
  27  |   // 1. boot: hero chrome present, feed deferred (no main-content, no active tab)
  28  |   await expect(page.locator('#app-container.lava-lamp-background')).toBeAttached();
  29  |   await expect(page.locator('#lava-lamp-mount .lava-lamp-bg')).toBeAttached();
  30  |   expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  31  |   expect(await page.locator('.arranger-button.active').count()).toBe(0);
  32  | 
  33  |   // 2. journal identity: colon squares + journal name, no hyperlit wordmark.
  34  |   //    The gap between the squares and the text is part of the mark (the
  35  |   //    negative space reads as an implied H): it must equal ONE square width
  36  |   //    (= colon height / 3, the SVG being 1:3).
  37  |   await expect(page.locator('.journal-colon')).toBeVisible();
  38  |   expect((await page.locator('.journal-title').textContent())?.trim().length).toBeGreaterThan(0);
  39  |   expect(await page.locator('#imageContainer svg#top').count()).toBe(0);
  40  |   const lockup = await page.locator('.journal-logo-lockup').evaluate(el => {
  41  |     const colon = el.querySelector('.journal-colon').getBoundingClientRect();
  42  |     const title = el.querySelector('.journal-title').getBoundingClientRect();
  43  |     return { squareWidth: colon.width, gap: title.left - colon.right };
  44  |   });
  45  |   expect(Math.abs(lockup.gap - lockup.squareWidth)).toBeLessThan(2);
  46  | 
  47  |   // 3. THE GEOMETRY CONTRACT — the glass card is a centered, rounded,
  48  |   //    blurred, fully-in-viewport box (a missed data-page selector shoves it
  49  |   //    off-screen while every DOM assertion still passes).
  50  |   const header = page.locator('.fixed-header');
  51  |   await expect(header).toBeVisible();
  52  |   const check = await header.evaluate(el => {
  53  |     const r = el.getBoundingClientRect();
  54  |     const cs = getComputedStyle(el);
  55  |     return {
  56  |       top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width,
  57  |       viewportW: window.innerWidth, viewportH: window.innerHeight,
  58  |       position: cs.position,
  59  |       radius: parseFloat(cs.borderRadius) || 0,
  60  |       blur: (cs.backdropFilter || cs.webkitBackdropFilter || ''),
  61  |       centerOffset: Math.abs((r.left + r.width / 2) - window.innerWidth / 2),
  62  |     };
  63  |   });
  64  |   expect(check.position).toBe('fixed');
  65  |   expect(check.top).toBeGreaterThanOrEqual(0);
  66  |   expect(check.left).toBeGreaterThanOrEqual(0);
  67  |   expect(check.right).toBeLessThanOrEqual(check.viewportW + 1);
  68  |   expect(check.bottom).toBeLessThanOrEqual(check.viewportH + 1);
  69  |   expect(check.width).toBeGreaterThan(200);
  70  |   expect(check.centerOffset).toBeLessThan(4);   // centered card
  71  |   expect(check.radius).toBeGreaterThan(8);      // rounded glass, not sharp corners
  72  |   expect(check.blur).toContain('blur');         // the glass itself
  73  | 
  74  |   // ...and the card's controls actually sit inside it (visible = laid out)
  75  |   await expect(page.locator('#journal-search-input')).toBeVisible();
  76  |   await expect(page.locator('#journal-fulltext-toggle')).toBeAttached(); // homepage-parity toggle
  77  |   await expect(page.locator('.arranger-button[data-sort="published"]')).toBeVisible();
  78  | 
  79  |   // 3b. journal-scoped search, both modes (homepage parity). Titles mode
  80  |   //     (default) matches the harvested article's title; Full text mode
  81  |   //     returns grouped match snippets from inside it.
  82  |   await page.fill('#journal-search-input', 'colonialism');
  83  |   await expect(page.locator('#journal-search-results .search-result-link').first()).toBeVisible({ timeout: 10_000 });
  84  |   await page.locator('label:has(#journal-fulltext-toggle)').click();
  85  |   await expect(page.locator('#journal-search-results .search-result-match-link').first()).toBeVisible({ timeout: 10_000 });
  86  | 
  87  |   // 3c. persistence parity with home: query + toggle survive a reload
  88  |   //     (query is per-journal, toggle is a cross-journal preference).
  89  |   await page.reload();
  90  |   await page.waitForLoadState('networkidle');
  91  |   await expect(page.locator('#journal-search-input')).toHaveValue('colonialism');
  92  |   await expect(page.locator('#journal-fulltext-toggle')).toBeChecked();
  93  | 
  94  |   // reset search state so the rest of the spec starts clean
  95  |   await page.fill('#journal-search-input', '');
  96  |   await page.locator('label:has(#journal-fulltext-toggle)').click(); // back to titles mode
  97  |   await page.keyboard.press('Escape');
  98  | 
  99  |   // 4. scroll reveals the about copy and docks the hero
  100 |   await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 400 }));
  101 |   await expect(page.locator('#app-container.lava-lamp-background.scrolled')).toBeAttached();
  102 |   await expect
  103 |     .poll(() => header.evaluate(el => el.getBoundingClientRect().top))
  104 |     .toBeLessThan(60);
  105 |   await expect(page.locator('.journal-about h1').first()).toBeVisible();
  106 |   await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 0 }));
  107 |   await expect(page.locator('#app-container.lava-lamp-background.scrolled')).toHaveCount(0);
  108 | 
  109 |   // 5. Most Recent opens the shelf-backed published feed
  110 |   await page.click('.arranger-button[data-sort="published"]');
  111 |   await expect(page.locator('#app-container.content-active')).toBeAttached();
  112 |   await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  113 |   await expect(page.locator('.journal-about')).toBeHidden();
  114 |   await expect(page.locator('#copy-feed-close')).toBeVisible();
  115 |   // feed mode: the card docks to the top of the screen
  116 |   await expect
  117 |     .poll(() => header.evaluate(el => el.getBoundingClientRect().top))
  118 |     .toBeLessThan(10);
  119 | 
  120 |   // 6. the other sorts swap feeds without wedging
  121 |   await page.click('.arranger-button[data-sort="connected"]');
  122 |   await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  123 | 
```