import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('Reader → User transition', () => {
  test('navigates from reader to user page via userButton → My Books', async ({ page, spa }) => {
    const bookSlug = process.env.E2E_READER_BOOK;
    test.skip(!bookSlug, 'E2E_READER_BOOK not set');

    // Start on reader page
    await page.goto(`/${bookSlug}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    // Snapshot listeners before transition
    const before = await spa.getListenerSnapshot(page);

    // Navigate to user page via userButton → My Books
    await spa.navigateToUserPage(page);
    await spa.waitForTransition(page);

    // Verify we're on user page
    expect(await spa.getStructure(page)).toBe('user');

    // Health check
    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    // Registry health check
    await spa.assertRegistryHealthy(page, 'user');

    // Globals should reflect user page
    const globals = await spa.getGlobals(page);
    expect(globals.isUserPage).toBe(true);

    // No console errors
    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});
