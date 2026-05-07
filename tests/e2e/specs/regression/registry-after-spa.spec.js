import { test, expect } from '../../fixtures/navigation.fixture.js';

test.describe('Registry health after SPA transitions', () => {
  test('home → reader: registry has all reader components', async ({ page, spa }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    await spa.clickFirstBookLink(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('reader');
    await spa.assertRegistryHealthy(page, 'reader');
  });

  test('reader → home: registry has all home components', async ({ page, spa }) => {
    const bookSlug = process.env.E2E_READER_BOOK;
    test.skip(!bookSlug, 'E2E_READER_BOOK not set');

    await page.goto(`/${bookSlug}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    await spa.navigateToHome(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('home');
    await spa.assertRegistryHealthy(page, 'home');
  });

  test('reader → user: registry has all user components', async ({ page, spa }) => {
    const bookSlug = process.env.E2E_READER_BOOK;
    test.skip(!bookSlug, 'E2E_READER_BOOK not set');

    await page.goto(`/${bookSlug}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    await spa.navigateToUserPage(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('user');
    await spa.assertRegistryHealthy(page, 'user');
  });

  test('user → reader: registry has all reader components', async ({ page, spa }) => {
    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set');

    await page.goto(`/u/${username}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('user');

    await spa.clickFirstBookLink(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('reader');
    await spa.assertRegistryHealthy(page, 'reader');
  });

  test('home → user: registry has all user components', async ({ page, spa }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    await spa.navigateToUserPage(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('user');
    await spa.assertRegistryHealthy(page, 'user');
  });

  test('user → home: registry has all home components', async ({ page, spa }) => {
    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set');

    await page.goto(`/u/${username}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('user');

    await spa.navigateToHome(page);
    await spa.waitForTransition(page);

    expect(await spa.getStructure(page)).toBe('home');
    await spa.assertRegistryHealthy(page, 'home');
  });
});
