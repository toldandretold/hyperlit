import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('Reader → Home transition', () => {
  test('navigates from reader to home via logo nav', async ({ page, spa }) => {
    const bookSlug = process.env.E2E_READER_BOOK;
    test.skip(!bookSlug, 'E2E_READER_BOOK not set');

    // Start on reader page
    await page.goto(`/${bookSlug}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    // Snapshot listeners before transition
    const before = await spa.getListenerSnapshot(page);

    // Navigate home via logo nav menu → home button
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);

    // Verify we're on home
    expect(await spa.getStructure(page)).toBe('home');

    // Health check
    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    // Registry health check
    await spa.assertRegistryHealthy(page, 'home');

    // Globals should reflect home page
    const globals = await spa.getGlobals(page);
    expect(globals.isUserPage).toBe(false);

    // No console errors
    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});
