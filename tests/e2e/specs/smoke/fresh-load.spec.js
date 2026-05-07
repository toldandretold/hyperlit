import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('Fresh page loads', () => {
  test('home page loads clean', async ({ page, spa }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const structure = await spa.getStructure(page);
    expect(structure).toBe('home');

    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    await spa.assertRegistryHealthy(page, 'home');

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('reader page loads clean', async ({ page, spa }) => {
    const bookSlug = process.env.E2E_READER_BOOK;
    test.skip(!bookSlug, 'E2E_READER_BOOK not set in .env.e2e');

    await page.goto(`/${bookSlug}`);
    await page.waitForLoadState('networkidle');

    const structure = await spa.getStructure(page);
    expect(structure).toBe('reader');

    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    await spa.assertRegistryHealthy(page, 'reader');

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('user page loads clean', async ({ page, spa }) => {
    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set in .env.e2e');

    await page.goto(`/u/${username}`);
    await page.waitForLoadState('networkidle');

    const structure = await spa.getStructure(page);
    expect(structure).toBe('user');

    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    await spa.assertRegistryHealthy(page, 'user');

    const globals = await spa.getGlobals(page);
    expect(globals.isUserPage).toBe(true);

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});
