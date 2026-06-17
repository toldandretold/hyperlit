import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Reader-page "+" / new-book button.
 *
 * The button lives inside #logoNavMenu (alongside user + home buttons),
 * hidden by default and revealed when the user taps the logo.
 *
 * What this spec verifies:
 *   - The button is registered as a component on the reader page
 *   - The button is hidden until the logo nav menu is opened
 *   - Clicking the + opens the NewBook popup with both choices
 *   - The popup is positioned left-anchored, within the viewport
 *   - Clicking "Import" expands the form, which docks to the TOP of the
 *     viewport (not below the +, which would push it off-screen on reader)
 *   - The form fits within the viewport — both desktop and mobile
 *
 * Skips when E2E_READER_BOOK isn't configured.
 */

const VIEWPORTS = [
  { label: 'desktop', width: 1280, height: 720, expectedFormWidth: 400 },
  { label: 'mobile',  width: 390,  height: 844, expectedFormWidth: 'fluid' },
];

test.describe('Reader page: new-book button in logo nav menu', () => {
  for (const viewport of VIEWPORTS) {
    test(`[${viewport.label}] + opens popup, Import form docks to top within viewport`, async ({ page, spa }, testInfo) => {
      const bookSlug = process.env.E2E_READER_BOOK;
      test.skip(!bookSlug, 'E2E_READER_BOOK not set in .env.e2e');

      test.setTimeout(60_000);

      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      // ──────────────────────────────────────────────────────────
      // Phase 1: Load reader, registry has newBookButton, + is in DOM
      // ──────────────────────────────────────────────────────────
      await page.goto(`/${bookSlug}`);
      await page.waitForLoadState('networkidle');
      expect(await spa.getStructure(page)).toBe('reader');

      const registry = await spa.getRegistryStatus(page);
      expect(registry?.activeComponents).toContain('newBookButton');

      const newBookExists = await page.locator('#newBookButton').count();
      expect(newBookExists).toBe(1);

      const popupExists = await page.locator('#newbook-container').count();
      expect(popupExists).toBe(1);

      const buttonParentHasMenu = await page.evaluate(() => {
        const btn = document.getElementById('newBookButton');
        return !!btn?.closest('#logoNavMenu');
      });
      expect(buttonParentHasMenu).toBe(true);

      // Menu starts hidden → + is not visible to the user yet
      await expect(page.locator('#newBookButton')).toBeHidden();

      // ──────────────────────────────────────────────────────────
      // Phase 2: Open logo nav → + becomes visible
      // ──────────────────────────────────────────────────────────
      await page.click('#logoContainer');
      await page.waitForSelector('#logoNavMenu:not(.hidden)', { timeout: 3000 });
      await expect(page.locator('#newBookButton')).toBeVisible();

      const newBookRect = await page.locator('#newBookButton').boundingBox();
      expect(newBookRect).not.toBeNull();
      await testInfo.attach(`${viewport.label}-01-menu-open.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // ──────────────────────────────────────────────────────────
      // Phase 3: Click + → buttons popup opens with New + Import
      // ──────────────────────────────────────────────────────────
      await page.click('#newBookButton');

      await page.waitForFunction(() => {
        const c = document.getElementById('newbook-container');
        if (!c) return false;
        const style = window.getComputedStyle(c);
        const rect = c.getBoundingClientRect();
        return style.opacity === '1' && rect.width > 0 && rect.height > 0;
      }, null, { timeout: 5000 });

      await expect(page.locator('#createNewBook')).toBeVisible();
      await expect(page.locator('#importBook')).toBeVisible();

      const buttonsPopupRect = await page.locator('#newbook-container').boundingBox();
      expect(buttonsPopupRect.x).toBeGreaterThanOrEqual(0);
      expect(buttonsPopupRect.x + buttonsPopupRect.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(buttonsPopupRect.y).toBeGreaterThanOrEqual(0);
      expect(buttonsPopupRect.y + buttonsPopupRect.height).toBeLessThanOrEqual(viewport.height + 1);

      await testInfo.attach(`${viewport.label}-02-buttons-popup.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // ──────────────────────────────────────────────────────────
      // Phase 4: Click Import → form expands, docked to TOP of viewport
      // ──────────────────────────────────────────────────────────
      await page.click('#importBook');
      await page.waitForSelector('#cite-form', { timeout: 10000 });

      // Wait for the CSS transition to settle — the inline `width` style is
      // set instantly to the target; the computed width animates toward it
      // over ~300ms. When the two match, the transition is done.
      await page.waitForFunction(() => {
        const c = document.getElementById('newbook-container');
        if (!c) return false;
        const inlinePx = parseFloat(c.style.width);
        const actual = c.getBoundingClientRect().width;
        return inlinePx > 100 && Math.abs(actual - inlinePx) < 1;
      }, null, { timeout: 5000 });

      const formRect = await page.locator('#newbook-container').boundingBox();

      // Horizontal: fully inside the viewport
      expect(formRect.x).toBeGreaterThanOrEqual(0);
      expect(formRect.x + formRect.width).toBeLessThanOrEqual(viewport.width + 1);

      // Vertical: docked NEAR the top — within the upper third of the viewport.
      // The historical bug positioned the form at button.bottom + 8 (~200px),
      // which left more than half the form below the viewport bottom.
      expect(formRect.y).toBeGreaterThanOrEqual(0);
      expect(formRect.y).toBeLessThan(viewport.height / 3);

      // Vertical: at least the top half of the form must be inside the viewport
      // (the form is ~80vh tall by design, so some bottom overflow may be OK,
      // but if the TOP is off-screen the user can't see what they're typing.)
      expect(formRect.y + formRect.height / 2).toBeLessThan(viewport.height);

      // Width sanity: on desktop the form is 400px; on mobile it should fill
      // most of the screen.
      if (viewport.expectedFormWidth === 'fluid') {
        expect(formRect.width).toBeGreaterThanOrEqual(viewport.width * 0.7);
      } else {
        expect(formRect.width).toBeCloseTo(viewport.expectedFormWidth, -1);
      }

      // The form's key fields are visible (sanity that the form actually rendered)
      await expect(page.locator('#cite-form #book')).toBeVisible();
      await expect(page.locator('#cite-form #title')).toBeVisible();

      await testInfo.attach(`${viewport.label}-03-import-form.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // ──────────────────────────────────────────────────────────
      // Phase 5: No console errors across the whole flow
      // ──────────────────────────────────────────────────────────
      expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
    });
  }
});
