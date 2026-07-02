/**
 * /chat experimental homepage: lava-lamp background + deferred content.
 *
 * Guards the three behaviors that broke while retrofitting the homepage
 * into the hero flow:
 *  1. the lava actually ANIMATES (path d's change over time) — machines with
 *     Reduce Motion enabled render a static frame by design, so the test
 *     explicitly emulates no-preference;
 *  2. content is NOT loaded until an arranger button is pressed (fresh
 *     browser profile ⇒ no localStorage tab restore);
 *  3. press-then-RELOAD lands in a consistent risen state — homepageDisplayUnit
 *     restores the last tab from localStorage on reload, and chatHero must
 *     derive .content-active from the restored DOM. The original bug: a
 *     centered glass hero overlapping the restored library cards.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

test.use({ reducedMotion: 'no-preference' });

test('/chat: lava animates, content defers until pressed, reload stays risen', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto('/chat');
  await page.waitForLoadState('networkidle');

  // 1. hero state: chat page marker present, no content, hero not risen
  await expect(page.locator('#app-container.chat-page')).toBeAttached();
  expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
  expect(await page.locator('#app-container.content-active').count()).toBe(0);

  // 2. lava animates: a path's d must change between samples
  const lavaPath = page.locator('.lava-lamp-bg path').first();
  await expect(lavaPath).toBeAttached();
  const d1 = await lavaPath.getAttribute('d');
  await page.waitForTimeout(1500);
  const d2 = await lavaPath.getAttribute('d');
  expect(d2).not.toBe(d1);

  // 3. pressing a tab rises the hero and loads cards
  await page.click('.arranger-button[data-content="most-recent"]');
  await expect(page.locator('#app-container.content-active')).toBeAttached();
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });

  // 4. reload: localStorage restores the tab — hero must be risen, not
  //    centered over the restored cards
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#app-container.content-active')).toBeAttached({ timeout: 5_000 });
  const heroTop = await page.locator('.fixed-header').evaluate(el => el.getBoundingClientRect().top);
  expect(heroTop).toBeLessThan(50);

  // lava must still animate after reload
  const d3 = await lavaPath.getAttribute('d');
  await page.waitForTimeout(1500);
  const d4 = await lavaPath.getAttribute('d');
  expect(d4).not.toBe(d3);
});
