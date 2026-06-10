/**
 * SPA pathways — HEAVY (import-book).
 *
 * The import-book pathway (ImportBookTransition) submits a real file to the
 * backend, which converts it and transitions into the reader. It's slow and
 * needs the queue worker running, so it lives here rather than in the main
 * grand tour (which stays fast / every-run). Splitting it out is the "Separate
 * tagged spec" decision.
 *
 * Run on demand:
 *   npm run test:e2e -- tests/e2e/specs/workflows/spa-pathways-heavy.spec.js
 *
 * Covers the one SPA pathway the grand tour deliberately omits, and then runs
 * the home interactive probes to prove the import didn't poison the next page.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import { probeBookActionsMenu, probeDropListenerBalance } from '../../helpers/elementProbes.js';

test.describe.serial('SPA pathways — heavy', () => {
  test('import-book pathway: file → backend → reader → home', async ({ page, spa }) => {
    test.setTimeout(180_000);

    const content = [
      '# Heavy Pathway Import',
      '',
      'A small markdown book imported to exercise the ImportBookTransition',
      'pathway end-to-end (form submit → backend conversion → reader).',
      '',
      '## Section One',
      '',
      'Some body text so the converted book has real nodes.',
      '',
      '## Section Two',
      '',
      'More text to be sure the reader renders content.',
      '',
    ].join('\n');

    // Drives the full import-book pathway and returns once the reader landed.
    const { bookId } = await spa.importMarkdownBook(page, spa, {
      name: 'heavy-pathway-import.md',
      content,
    });
    expect(bookId).toMatch(/^book_\d+/);
    expect(await spa.getStructure(page)).toBe('reader');

    // Landed on a healthy reader: registry initialised for the reader page and
    // the converted content rendered. (We keep the reader check light — the
    // import pathway can leave a post-import "References detected" dialog that
    // interferes with the deeper edit-mode toggle; the pathway landing healthy
    // is what this spec is asserting.)
    await spa.assertRegistryHealthy(page, 'reader');
    expect(
      await page.evaluate(() => (document.querySelector('main.main-content')?.textContent || '').length),
      'imported reader should have rendered content'
    ).toBeGreaterThan(0);

    // SPA back to home and prove the import flow didn't leave home's
    // interactive components dead — registry health + the book-actions menu +
    // the drop listener/overlay balance. (We use the probes directly rather
    // than the full verifyHomePage, whose synthetic drop re-opens the import
    // form — fragile immediately after an import shared the same newBookButton.)
    await spa.navigateToHome(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('home');
    await spa.assertRegistryHealthy(page, 'home');
    await probeBookActionsMenu(page, spa, { expectPage: 'home', clickPreview: false });
    await probeDropListenerBalance(page);
  });
});
