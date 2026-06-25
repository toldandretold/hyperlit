import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Listener accumulation regression.
 *
 * NOTE on scope: the listener monitor counts net addEventListener−removeEventListener per
 * `target::event`. On RECREATED elements (buttons/containers swapped each SPA nav) it counts the
 * adds even though the old elements are GC'd with their listeners — so a naive "nothing may grow"
 * assertion is noisy. These tests therefore check the clearest persistent-target signal that the
 * old tests were built around: `document::click`. The lazyLoader's own scroll/beforeunload
 * listener lifecycle (the reading-position-corruption root cause) is precisely guarded by the
 * unit test `tests/javascript/lazyLoader/scrollSaveLifecycle.test.js` (disconnect removes them +
 * only the active loader saves). A broader "no listener accumulates anywhere" gate is a separate,
 * app-wide cleanup (the monitor revealed pervasive recreated-element churn beyond this bug).
 */

test.describe('Listener accumulation regression', () => {
  test('document click listeners stay stable across home→reader→home cycles', async ({ page, spa }) => {
    // Start on home
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    // Take baseline snapshot after first load
    const baseline = await spa.getListenerSnapshot(page);
    const baselineDocClick = baseline['document::click'] || 0;

    // Cycle 3 times: home → reader → home
    for (let i = 0; i < 3; i++) {
      // Navigate to reader by clicking first book
      await spa.clickFirstBookLink(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('reader');

      // Navigate back to home via logo nav
      await spa.navigateToHome(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('home');
    }

    // Check that document::click count hasn't grown
    const after = await spa.getListenerSnapshot(page);
    const afterDocClick = after['document::click'] || 0;

    // Allow a small tolerance (±2) for framework overhead
    expect(afterDocClick).toBeLessThanOrEqual(baselineDocClick + 2);
  });

  test('document click listeners stay stable across user→reader→user cycles', async ({ page, spa }) => {
    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set');

    // Start on user page
    await page.goto(`/u/${username}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('user');

    // Take baseline snapshot after first load
    const baseline = await spa.getListenerSnapshot(page);
    const baselineDocClick = baseline['document::click'] || 0;

    // Cycle 3 times: user → reader → user
    for (let i = 0; i < 3; i++) {
      // Navigate to reader by clicking first book
      await spa.clickFirstBookLink(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('reader');

      // Navigate back to user page via userButton → My Books
      await spa.navigateToUserPage(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('user');
    }

    // Check that document::click count hasn't grown
    const after = await spa.getListenerSnapshot(page);
    const afterDocClick = after['document::click'] || 0;

    // Allow a small tolerance (±2) for framework overhead
    expect(afterDocClick).toBeLessThanOrEqual(baselineDocClick + 2);
  });
});
