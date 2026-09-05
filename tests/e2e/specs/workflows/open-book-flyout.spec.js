import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Reader-page "Open" button in the logo nav menu — the recents + library-search
 * flyout (components/openbookContainer).
 *
 * What this spec verifies, per viewport:
 *   - The component is registered on the reader page and the row is hidden
 *     until the logo nav is opened
 *   - Desktop: clicking Open shows the glass flyout beside the nav column,
 *     within the viewport
 *   - Mobile (≤480): clicking Open shows the full-width BOTTOM SHEET
 *     (.openbook-sheet.sheet-open), docked to the viewport bottom
 *   - The Recent list NEVER contains the book currently on screen
 *   - Typing into the search field hides the Recent section and surfaces the
 *     results container; clearing restores Recent
 *   - Clicking a recent row SPA-navigates to that book and closes everything
 *   - One-flyout-at-a-time: opening the Account panel closes the Open panel
 *   - Escape closes the panel but leaves the nav menu open
 *   - The button still works after an SPA navigation (registry re-init class
 *     of bug — the thing ButtonRegistry exists to prevent)
 *
 * Skips when E2E_READER_BOOK isn't configured.
 */

const READER_BOOK = process.env.E2E_READER_BOOK;

const VIEWPORTS = [
  { label: 'desktop', width: 1280, height: 720, sheet: false },
  { label: 'mobile', width: 390, height: 844, sheet: true },
];

async function openLogoNav(page) {
  await page.click('#logoContainer');
  await page.waitForSelector('#logoNavMenu:not(.hidden)', { timeout: 3000 });
  await expect(page.locator('#openBookButton')).toBeVisible();
}

async function openPanel(page) {
  await page.click('#openBookButton');
  await page.waitForFunction(() => {
    const c = document.getElementById('openbook-container');
    if (!c) return false;
    const style = window.getComputedStyle(c);
    const rect = c.getBoundingClientRect();
    return style.opacity === '1' && rect.width > 0 && rect.height > 0;
  }, null, { timeout: 5000 });
}

async function panelClosed(page) {
  await page.waitForFunction(() => {
    const c = document.getElementById('openbook-container');
    return !c || c.classList.contains('hidden');
  }, null, { timeout: 5000 });
}

/** Visit the first home-feed book so the recents list has a non-current entry. */
async function seedASecondCachedBook(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spa.openHomeFeed(page).catch(() => {});
  const firstCard = page.locator('.libraryCard a[href^="/"]').first();
  if (!(await firstCard.count())) return null;
  const href = await firstCard.getAttribute('href');
  await firstCard.click();
  await page.waitForSelector('main.main-content', { timeout: 15000 });
  await page.waitForTimeout(1500); // let the IDB pull land
  return href;
}

test.describe('Reader page: Open (recents + search) flyout in logo nav menu', () => {
  for (const viewport of VIEWPORTS) {
    test(`[${viewport.label}] Open panel: recents, search, exclusion, navigation`, async ({ page, spa }, testInfo) => {
      test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in .env.e2e');
      test.setTimeout(90_000);

      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      // Seed the cache with a book other than READER_BOOK so Recent is non-empty.
      const seededHref = await seedASecondCachedBook(page, spa);

      // ── Phase 1: load reader; component registered; row hidden until nav opens
      await page.goto(`/${READER_BOOK}`);
      await page.waitForLoadState('networkidle');
      expect(await spa.getStructure(page)).toBe('reader');

      const registry = await spa.getRegistryStatus(page);
      expect(registry?.activeComponents).toContain('openBookContainer');

      expect(await page.locator('#openBookButton').count()).toBe(1);
      expect(await page.locator('#openbook-container').count()).toBe(1);
      await expect(page.locator('#openBookButton')).toBeHidden();

      // ── Phase 2: open nav → open panel; per-viewport presentation
      await openLogoNav(page);
      await openPanel(page);

      const panelRect = await page.locator('#openbook-container').boundingBox();
      expect(panelRect.x).toBeGreaterThanOrEqual(0);
      expect(panelRect.x + panelRect.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(panelRect.y + panelRect.height).toBeLessThanOrEqual(viewport.height + 1);

      if (viewport.sheet) {
        // Mobile: full-width bottom sheet docked to the viewport bottom.
        await expect(page.locator('#openbook-container.openbook-sheet.sheet-open')).toHaveCount(1);
        expect(panelRect.width).toBeGreaterThanOrEqual(viewport.width - 2);
        expect(panelRect.y + panelRect.height).toBeGreaterThanOrEqual(viewport.height - 2);
      } else {
        // Desktop: flyout to the RIGHT of the logo-nav column.
        const navRight = await page.evaluate(() =>
          document.getElementById('logoNavWrapper')?.getBoundingClientRect().right ?? 0);
        expect(panelRect.x).toBeGreaterThanOrEqual(navRight - 1);
        expect(await page.locator('#openbook-container.openbook-sheet').count()).toBe(0);
      }
      await testInfo.attach(`${viewport.label}-01-panel-open.png`, {
        body: await page.screenshot(), contentType: 'image/png',
      });

      // ── Phase 3: Recent list — current book excluded
      const currentBookId = await page.evaluate(() => document.querySelector('main.main-content')?.id || '');
      expect(currentBookId).not.toBe('');
      expect(
        await page.locator(`#openbook-recent-list [data-book-id="${currentBookId}"]`).count(),
        'the book currently on screen must not appear in Recent',
      ).toBe(0);

      const recentRows = await page.locator('#openbook-recent-list .openbook-recent-item').count();
      if (!recentRows) {
        // Tolerate an empty cache (fresh profile + no seedable home card).
        await expect(page.locator('#openbook-recent-list .openbook-empty')).toHaveCount(1);
      }

      // ── Phase 4: typing swaps Recent for results; clearing restores it
      const input = page.locator('#openbook-search-input');
      await input.click();
      await input.fill('the');
      await page.waitForFunction(() => {
        const recent = document.getElementById('openbook-recent');
        return recent && getComputedStyle(recent).display === 'none';
      }, null, { timeout: 3000 });
      // Results container becomes visible with either hits or the no-results copy.
      await page.waitForSelector('#openbook-search-results.visible', { timeout: 10000 });

      await input.fill('');
      await page.waitForFunction(() => {
        const recent = document.getElementById('openbook-recent');
        return recent && getComputedStyle(recent).display !== 'none';
      }, null, { timeout: 3000 });

      // ── Phase 5: one-flyout-at-a-time — Account swaps the panel out
      await page.click('#userButton');
      await panelClosed(page);
      await page.waitForFunction(() => {
        const u = document.getElementById('user-container');
        return u && u.classList.contains('open');
      }, null, { timeout: 5000 });
      // Swap back.
      await page.click('#openBookButton');
      await openPanel(page);
      await page.waitForFunction(() => {
        const u = document.getElementById('user-container');
        return !u || !u.classList.contains('open');
      }, null, { timeout: 5000 });

      // ── Phase 6: Escape closes the panel, nav stays open
      await page.keyboard.press('Escape');
      await panelClosed(page);
      await expect(page.locator('#logoNavMenu:not(.hidden)')).toHaveCount(1);

      // ── Phase 7: recent row SPA-navigates (only when we have a row to click)
      if (seededHref && recentRows) {
        await page.click('#openBookButton');
        await openPanel(page);
        const row = page.locator('#openbook-recent-list .openbook-recent-item').first();
        const targetId = await row.getAttribute('data-book-id');
        await row.click();
        await panelClosed(page);
        await page.waitForFunction((id) => {
          const main = document.querySelector('main.main-content');
          return main && main.id === id;
        }, targetId, { timeout: 20000 });

        // ── Phase 8: the button still works AFTER the SPA navigation
        await openLogoNav(page);
        await openPanel(page);
        // ...and now the OLD book is a recent while the new current one is excluded.
        expect(
          await page.locator(`#openbook-recent-list [data-book-id="${targetId}"]`).count(),
        ).toBe(0);
        await page.keyboard.press('Escape');
        await panelClosed(page);
      }
    });
  }
});
