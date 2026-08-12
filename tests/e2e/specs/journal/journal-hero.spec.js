/**
 * Journal home page (`/j/{slug}`): the homepage's lava-lamp glass hero scoped
 * to one journal, with shelf-backed feeds. Mirrors home-lava-homepage.spec.js
 * but adds RENDERED-GEOMETRY assertions — the journal page shares home's CSS
 * only through explicit `body[data-page="journal"]` selector extensions
 * (homepage.css, base/layout.css, perimeterGlass.css), and a missed selector
 * leaves the DOM correct while the card renders off-screen/unstyled. That is
 * exactly the failure mode PHP markup tests cannot see.
 *
 * Precondition: a harvested journal in the local registry (the GSCJ pilot).
 * The spec skips when the page 404s, so a fresh DB is a skip, not a failure —
 * treat skips as gaps (CLAUDE.md).
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

test.use({ reducedMotion: 'no-preference' });

const JOURNAL_PATH = '/j/global-social-challenges-journal';

test('journal hero: glass card renders in-viewport, feeds open/close, about copy reveals', async ({ page }) => {
  test.setTimeout(90_000);

  const response = await page.goto(JOURNAL_PATH);
  test.skip(response.status() === 404, 'GSCJ not in this environment\'s registry — run: php artisan journal:sync-registry --issn=2752-3349');
  await page.waitForLoadState('networkidle');

  // 1. boot: hero chrome present, feed deferred (no main-content, no active tab)
  await expect(page.locator('#app-container.lava-lamp-background')).toBeAttached();
  await expect(page.locator('#lava-lamp-mount .lava-lamp-bg')).toBeAttached();
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  expect(await page.locator('.arranger-button.active').count()).toBe(0);

  // 2. journal identity: colon squares + journal name, no hyperlit wordmark.
  //    The gap between the squares and the text is part of the mark (the
  //    negative space reads as an implied H): it must equal ONE square width
  //    (= colon height / 3, the SVG being 1:3).
  await expect(page.locator('.journal-colon')).toBeVisible();
  expect((await page.locator('.journal-title').textContent())?.trim().length).toBeGreaterThan(0);
  expect(await page.locator('#imageContainer svg#top').count()).toBe(0);
  const lockup = await page.locator('.journal-logo-lockup').evaluate(el => {
    const colon = el.querySelector('.journal-colon').getBoundingClientRect();
    const title = el.querySelector('.journal-title').getBoundingClientRect();
    return { squareWidth: colon.width, gap: title.left - colon.right };
  });
  expect(Math.abs(lockup.gap - lockup.squareWidth)).toBeLessThan(2);

  // 3. THE GEOMETRY CONTRACT — the glass card is a centered, rounded,
  //    blurred, fully-in-viewport box (a missed data-page selector shoves it
  //    off-screen while every DOM assertion still passes).
  const header = page.locator('.fixed-header');
  await expect(header).toBeVisible();
  const check = await header.evaluate(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width,
      viewportW: window.innerWidth, viewportH: window.innerHeight,
      position: cs.position,
      radius: parseFloat(cs.borderRadius) || 0,
      blur: (cs.backdropFilter || cs.webkitBackdropFilter || ''),
      centerOffset: Math.abs((r.left + r.width / 2) - window.innerWidth / 2),
    };
  });
  expect(check.position).toBe('fixed');
  expect(check.top).toBeGreaterThanOrEqual(0);
  expect(check.left).toBeGreaterThanOrEqual(0);
  expect(check.right).toBeLessThanOrEqual(check.viewportW + 1);
  expect(check.bottom).toBeLessThanOrEqual(check.viewportH + 1);
  expect(check.width).toBeGreaterThan(200);
  expect(check.centerOffset).toBeLessThan(4);   // centered card
  expect(check.radius).toBeGreaterThan(8);      // rounded glass, not sharp corners
  expect(check.blur).toContain('blur');         // the glass itself

  // ...and the card's controls actually sit inside it (visible = laid out)
  await expect(page.locator('#journal-search-input')).toBeVisible();
  await expect(page.locator('#journal-fulltext-toggle')).toBeAttached(); // homepage-parity toggle
  await expect(page.locator('.arranger-button[data-sort="published"]')).toBeVisible();

  // 3b. journal-scoped search, both modes (homepage parity). Titles mode
  //     (default) matches the harvested article's title; Full text mode
  //     returns grouped match snippets from inside it.
  await page.fill('#journal-search-input', 'colonialism');
  await expect(page.locator('#journal-search-results .search-result-link').first()).toBeVisible({ timeout: 10_000 });
  await page.locator('.fulltext-toggle-label').click();
  await expect(page.locator('#journal-search-results .search-result-match-link').first()).toBeVisible({ timeout: 10_000 });

  // 3c. persistence parity with home: query + toggle survive a reload
  //     (query is per-journal, toggle is a cross-journal preference).
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#journal-search-input')).toHaveValue('colonialism');
  await expect(page.locator('#journal-fulltext-toggle')).toBeChecked();

  // reset search state so the rest of the spec starts clean
  await page.fill('#journal-search-input', '');
  await page.locator('.fulltext-toggle-label').click(); // back to titles mode
  await page.keyboard.press('Escape');

  // 4. scroll reveals the about copy and docks the hero
  await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 400 }));
  await expect(page.locator('#app-container.lava-lamp-background.scrolled')).toBeAttached();
  await expect
    .poll(() => header.evaluate(el => el.getBoundingClientRect().top))
    .toBeLessThan(60);
  await expect(page.locator('.journal-about h1').first()).toBeVisible();
  await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 0 }));
  await expect(page.locator('#app-container.lava-lamp-background.scrolled')).toHaveCount(0);

  // 5. Most Recent opens the shelf-backed published feed
  await page.click('.arranger-button[data-sort="published"]');
  await expect(page.locator('#app-container.content-active')).toBeAttached();
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.journal-about')).toBeHidden();
  await expect(page.locator('#copy-feed-close')).toBeVisible();
  // feed mode: the card docks to the top of the screen
  await expect
    .poll(() => header.evaluate(el => el.getBoundingClientRect().top))
    .toBeLessThan(10);

  // 6. the other sorts swap feeds without wedging
  await page.click('.arranger-button[data-sort="connected"]');
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });

  // 7. × closes back to the hero
  await page.click('#copy-feed-close');
  await expect(page.locator('#app-container.content-active')).toHaveCount(0);
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  await expect(page.locator('.journal-about')).toBeVisible();
});
