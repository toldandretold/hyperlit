/**
 * /chat experimental homepage: lava-lamp background, centered glass hero,
 * scrollable intro copy, deferred feed.
 *
 * State machine under test (classes on #app-container.chat-page):
 *  - boot        → hero centered, intro below the fold, NO content (tab
 *                  restore is suppressed on /chat — every load starts here)
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

test('/chat: hero boot, lava animates, scroll docks, feed opens/closes, reload stays hero', async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto('/chat');
  await page.waitForLoadState('networkidle');

  // 1. boot: hero centered, no content, intro present but below the fold
  await expect(page.locator('#app-container.chat-page')).toBeAttached();
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  expect(await page.locator('#app-container.content-active').count()).toBe(0);
  await expect(page.locator('.chat-intro h1')).toHaveText('Read, Write and Publish Hypertext Literature');

  // 2. lava animates: a path's d must change between samples
  const lavaPath = page.locator('.lava-lamp-bg path').first();
  await expect(lavaPath).toBeAttached();
  const d1 = await lavaPath.getAttribute('d');
  await page.waitForTimeout(1500);
  const d2 = await lavaPath.getAttribute('d');
  expect(d2).not.toBe(d1);

  // 3. scrolling the intro docks the hero; scrolling back recenters it
  await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 400 }));
  await expect(page.locator('#app-container.chat-page.scrolled')).toBeAttached();
  await expect
    .poll(() => page.locator('.fixed-header').evaluate(el => el.getBoundingClientRect().top))
    .toBeLessThan(60);
  await page.locator('.home-content-wrapper').evaluate(el => el.scrollTo({ top: 0 }));
  await expect(page.locator('#app-container.chat-page.scrolled')).toHaveCount(0);

  // 4. pressing a tab opens the feed: hero rises, intro hides, × appears
  await page.click('.arranger-button[data-content="most-recent"]');
  await expect(page.locator('#app-container.content-active')).toBeAttached();
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.chat-intro')).toBeHidden();
  await expect(page.locator('#chat-feed-close')).toBeVisible();

  // 5. × closes the feed back to the hero
  await page.click('#chat-feed-close');
  await expect(page.locator('#app-container.content-active')).toHaveCount(0);
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  expect(await page.locator('.arranger-button.active').count()).toBe(0);
  await expect(page.locator('.chat-intro')).toBeVisible();

  // 6. reload after opening a feed: /chat must STILL boot to the hero
  //    (tab restore suppressed — this was the centered-hero-over-cards bug)
  await page.click('.arranger-button[data-content="most-lit"]');
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  expect(await page.locator('#app-container.content-active').count()).toBe(0);

  // 7. the intro "import" link opens the new-book container
  await page.locator('#chat-intro-import').scrollIntoViewIfNeeded();
  await page.click('#chat-intro-import');
  await expect(page.locator('#newbook-container')).toBeVisible();
});
