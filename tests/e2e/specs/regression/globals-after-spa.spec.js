import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('Globals after SPA navigation', () => {
  test('window.isUserPage is correct after reader→user transition', async ({ page, spa }) => {
    const bookSlug = process.env.E2E_READER_BOOK;
    test.skip(!bookSlug, 'E2E_READER_BOOK not set');

    // Start on reader
    await page.goto(`/${bookSlug}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    let globals = await spa.getGlobals(page);
    expect(globals.isUserPage).toBe(false);

    // Navigate to user page via userButton → My Books
    await spa.navigateToUserPage(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('user');

    globals = await spa.getGlobals(page);
    expect(globals.isUserPage).toBe(true);
    expect(globals.isOwner).toBeDefined();
  });

  test('page structure correct after home→reader transition', async ({ page, spa }) => {
    // Start on home
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    // Navigate to reader by clicking first book
    await spa.clickFirstBookLink(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('reader');

    const globals = await spa.getGlobals(page);
    expect(globals.dataPage).toBe('reader');
  });

  test('window.isUserPage resets after user→home transition', async ({ page, spa }) => {
    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set');

    // Start on user page
    await page.goto(`/u/${username}`);
    await page.waitForLoadState('networkidle');

    let globals = await spa.getGlobals(page);
    expect(globals.isUserPage).toBe(true);

    // Navigate to home via logo nav
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('home');

    globals = await spa.getGlobals(page);
    expect(globals.isUserPage).toBe(false);
  });
});
