/**
 * The homepage (`/`): lava-lamp background, centered glass hero, scrollable
 * intro copy, deferred feed. This is the behavioral contract for the deferred
 * homepage design.
 *
 * State machine under test (classes on #app-container.lava-lamp-background):
 *  - boot        → hero centered, intro below the fold, NO content (tab
 *                  restore is suppressed on `/` — every load starts here)
 *  - .scrolled   → intro reading mode: hero docks to the top
 *  - .content-active → feed open: intro hidden, × visible; × closes back
 *                  to the hero and clears the persisted tab
 *
 * Also guards: the lava actually ANIMATES (machines with Reduce Motion get
 * gentle mode, so it must move there too — we emulate no-preference), and the
 * intro's "import" link opens the new-book container via #newBookButton.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

test.use({ reducedMotion: 'no-preference' });

test('home: hero boot, lava animates, scroll docks, feed opens/closes, reload stays hero', async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 1. boot: hero centered, no content, intro present but below the fold.
  //    Copy-agnostic on purpose — the intro wording is editable in the blade;
  //    we only assert the crawlable heading rendered and is non-empty.
  await expect(page.locator('#app-container.lava-lamp-background')).toBeAttached();
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  expect(await page.locator('#app-container.content-active').count()).toBe(0);
  await expect(page.locator('.welcome-copy h1').first()).toBeVisible();
  expect((await page.locator('.welcome-copy h1').first().textContent())?.trim().length).toBeGreaterThan(0);

  // 2. lava animates: a path's d must change between samples
  const lavaPath = page.locator('.lava-lamp-bg path').first();
  await expect(lavaPath).toBeAttached();
  const d1 = await lavaPath.getAttribute('d');
  await page.waitForTimeout(1500);
  const d2 = await lavaPath.getAttribute('d');
  expect(d2).not.toBe(d1);

  // 3. scrolling the intro docks the hero; scrolling back recenters it
  await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 400 }));
  await expect(page.locator('#app-container.lava-lamp-background.scrolled')).toBeAttached();
  await expect
    .poll(() => page.locator('.fixed-header').evaluate(el => el.getBoundingClientRect().top))
    .toBeLessThan(60);
  await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 0 }));
  await expect(page.locator('#app-container.lava-lamp-background.scrolled')).toHaveCount(0);

  // 4. pressing a tab opens the feed: hero rises, intro hides, × appears
  await page.click('.arranger-button[data-content="most-recent"]');
  await expect(page.locator('#app-container.content-active')).toBeAttached();
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.welcome-copy')).toBeHidden();
  await expect(page.locator('#copy-feed-close')).toBeVisible();

  // 5. × closes the feed back to the hero
  await page.click('#copy-feed-close');
  await expect(page.locator('#app-container.content-active')).toHaveCount(0);
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  expect(await page.locator('.arranger-button.active').count()).toBe(0);
  await expect(page.locator('.welcome-copy')).toBeVisible();

  // 5b. the header content re-CENTERS after returning from the feed. Opening a
  //     feed sets an inline left-margin on the arranger buttons (to align with
  //     feed text); closing must clear it, else the header stays shifted.
  //     Assert the buttons row is horizontally centered within the header and
  //     carries no leftover inline margin-left.
  await expect
    .poll(() => page.locator('.arranger-buttons-container').evaluate(el => el.style.marginLeft || ''))
    .toBe('');
  await expect
    .poll(async () => {
      const { headerCenter, btnCenter } = await page.locator('.fixed-header').evaluate(header => {
        const btns = header.querySelector('.arranger-buttons-container');
        const h = header.getBoundingClientRect();
        const b = btns.getBoundingClientRect();
        return { headerCenter: h.left + h.width / 2, btnCenter: b.left + b.width / 2 };
      });
      return Math.abs(headerCenter - btnCenter);
    })
    .toBeLessThan(4);

  // 6. reload after opening a feed: `/` must STILL boot to the hero
  //    (tab restore suppressed — this was the centered-hero-over-cards bug)
  await page.click('.arranger-button[data-content="most-lit"]');
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  expect(await page.locator('#app-container.content-active').count()).toBe(0);

  // 7. the intro "import/convert" link opens the new-book container
  await page.locator('.copy-import').first().scrollIntoViewIfNeeded();
  await page.locator('.copy-import').first().click();
  await expect(page.locator('#newbook-container')).toBeVisible();

  // 8. the intro login / register links open the user container on the right form
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.locator('.import-auth-login').scrollIntoViewIfNeeded();
  await page.locator('.import-auth-login').click();
  await expect(page.locator('#user-container')).toBeVisible();
  await expect(page.locator('#user-container')).toContainText(/log ?in|sign in/i);
});
