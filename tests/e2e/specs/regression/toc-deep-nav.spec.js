import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * TOC deep-navigation regression.
 *
 * The TOC (#toc-toggle-button → #toc-container) has no dedicated e2e coverage.
 * This spec imports a long book, iterates every TOC entry, clicks each one,
 * and asserts:
 *   - URL hash updates to the entry's href
 *   - The heading element with the matching id is in the upper half of the viewport
 *   - No hyperlit container opens as a side-effect (TOC nav should not stack)
 *   - The TOC closes after each click (per toc.js click handler contract)
 */

test.describe('TOC deep navigation', () => {
  test('every TOC entry scrolls its heading into viewport and closes the TOC', async ({ page, spa }) => {
    test.setTimeout(180_000);

    const md = spa.generateLongMarkdown({
      title: 'TOC Nav Book',
      chapters: 6,
      paragraphsPerChapter: 3,
      wordsPerParagraph: 30,
    });
    const { bookId } = await spa.importMarkdownBook(page, spa, {
      name: 'toc-nav.md',
      content: md,
    });
    expect(bookId).toBeTruthy();

    // Exit edit mode if we landed in it
    if (await page.evaluate(() => !!window.isEditing)) {
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    }

    await spa.openToc(page);
    const entries = await spa.getTocEntries(page);
    expect(entries.length).toBeGreaterThanOrEqual(6);
    await spa.closeToc(page);

    for (const entry of entries) {
      // Skip entries with no hash (unlikely, but defensive)
      if (!entry.href || !entry.href.startsWith('#')) continue;

      const beforeSnap = await spa.snapshotPageState(page, `before ${entry.text}`);
      expect(beforeSnap.openMainContainer).toBe(false);
      expect(beforeSnap.stackedContainersTotal).toBe(0);

      await spa.openToc(page);
      await spa.clickTocEntry(page, entry.index);

      // URL hash should match (allow empty when target is already at top of
      // viewport — scroll handler may skip the hash update for no-op nav)
      const hash = await page.evaluate(() => window.location.hash);
      expect(hash === entry.href || hash === '', `entry "${entry.text}" got hash="${hash}", expected "${entry.href}" or ""`).toBe(true);

      // Heading in upper half of viewport — the load-bearing assertion
      const inViewport = await spa.isHeadingInViewportForHref(page, entry.href);
      expect(inViewport, `heading for "${entry.text}" (${entry.href}) not in upper-half viewport`).toBe(true);

      // No hyperlit container side-effects
      const afterSnap = await spa.snapshotPageState(page, `after ${entry.text}`);
      expect(afterSnap.openMainContainer, `${entry.text}: main container opened on TOC click`).toBe(false);
      expect(afterSnap.stackedContainersTotal, `${entry.text}: stacked containers appeared on TOC click`).toBe(0);
      expect(afterSnap.tocOpen, `${entry.text}: TOC did not close after click`).toBe(false);
    }

    // No console errors across the whole nav sequence. Filter dev-server
    // rate-limit noise on /reading-position — every TOC click triggers a
    // debounced position save, and the dev server's rate limiter trips when
    // we iterate the full TOC in a few seconds. That's a test-environment
    // artifact, not a product bug.
    const errors = spa.filterConsoleErrors(page.consoleErrors)
      .filter(e => !/429.*Too Many Requests/i.test(e));
    expect(errors, `Console errors during TOC nav: ${JSON.stringify(errors)}`).toEqual([]);

    await spa.assertHealthy(await spa.healthCheck(page));
  });
});
