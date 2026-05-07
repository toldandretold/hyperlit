import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('User → Home transition', () => {
  test('navigates from user page to home via logo nav', async ({ page, spa }) => {
    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set');

    // Start on user page
    await page.goto(`/u/${username}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('user');

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
