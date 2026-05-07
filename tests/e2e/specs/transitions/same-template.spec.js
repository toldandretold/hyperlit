import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('Same-template transitions', () => {
  test('reader → reader (book to book via hypercite)', async ({ page, spa }) => {
    const book1 = process.env.E2E_READER_BOOK;
    const book2 = process.env.E2E_READER_BOOK_2;
    test.skip(!book1 || !book2, 'E2E_READER_BOOK and E2E_READER_BOOK_2 not set');

    // Start on first book (which has a hypercite link to book2)
    await page.goto(`/${book1}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    // Snapshot listeners
    const before = await spa.getListenerSnapshot(page);

    // Navigate to second book via hypercite → hyperlit container → See in source text
    await spa.navigateViaHypercite(page);
    await spa.waitForTransition(page);

    // Still on reader (different book)
    expect(await spa.getStructure(page)).toBe('reader');

    // Health check
    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    // Registry health check
    await spa.assertRegistryHealthy(page, 'reader');

    // No console errors
    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('home → home (round-trip via reader preserves home state)', async ({ page, spa }) => {
    // Start on home page
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    // Snapshot listeners
    const before = await spa.getListenerSnapshot(page);

    // Go to reader and back to home
    await spa.clickFirstBookLink(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');

    await spa.navigateToHome(page);
    await spa.waitForTransition(page);

    // Back on home
    expect(await spa.getStructure(page)).toBe('home');

    // Health check
    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    // Registry health check
    await spa.assertRegistryHealthy(page, 'home');

    // Listener counts should be stable
    const delta = await spa.getListenerDelta(page, before);
    const docClickDelta = delta['document::click'] || 0;
    expect(docClickDelta).toBeLessThanOrEqual(2);

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });

  test('user → user (navigate to own page again via userButton)', async ({ page, spa }) => {
    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set');

    // Start on user page
    await page.goto(`/u/${username}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('user');

    // Snapshot listeners
    const before = await spa.getListenerSnapshot(page);

    // Navigate to own user page again via userButton → My Books
    await spa.navigateToUserPage(page);
    await spa.waitForTransition(page);

    // Still on user
    expect(await spa.getStructure(page)).toBe('user');

    // Health check
    const health = await spa.healthCheck(page);
    spa.assertHealthy(health);

    // Registry health check
    await spa.assertRegistryHealthy(page, 'user');

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});
