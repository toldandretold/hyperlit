import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('Home → Reader transition', () => {
  test('navigates from home to reader via book link', async ({ page, spa }) => {
    // Start on home page
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

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
