import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('User → Reader transition', () => {
  test('navigates from user page to reader via book link', async ({ page, spa }) => {
    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set');

    // Start on user page
    await page.goto(`/u/${username}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('user');

    // Snapshot listeners before transition
    const before = await spa.getListenerSnapshot(page);

    // Click the first available book link
    await spa.clickFirstBookLink(page);
    await spa.waitForTransition(page);

    // Verify we're on reader
    expect(await spa.getStructure(page)).toBe('reader');

    // Health check
    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    // Registry health check
    await spa.assertRegistryHealthy(page, 'reader');

    // No console errors
    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});
