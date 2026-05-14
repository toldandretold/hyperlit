/**
 * SPA Grand Tour.
 *
 * The catch-all SPA correctness test. Per-page verifiers are exercised in
 * isolation, then chained through every transition path, looped to surface
 * accumulation bugs, then walked back/forward through browser history to
 * surface bfcache / history-state bugs. Finally a deep-authoring lap creates
 * a book, hyperlights + hypercites text, navigates home, and runs one more
 * SPA cycle to verify the heavy-state didn't poison the next page.
 *
 * Each phase is a separate `test()` under describe.serial so you can run any
 * piece alone via `--grep`.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  verifyHomePage,
  verifyUserPage,
  verifyReaderPage,
  moveCursorToEnd,
  findParagraphByText,
  waitForCloudGreen,
} from '../../helpers/pageVerifiers.js';
import {
  runTour,
  replayBackToStart,
  replayForwardToEnd,
} from '../../helpers/spaTour.js';

test.describe.serial('SPA Grand Tour', () => {

  /* ── Phase 1: per-page verifiers in isolation ───────────────────── */

  test('home page in isolation', async ({ page, spa }) => {
    test.setTimeout(30_000);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await verifyHomePage(page, spa);
  });

  test('user page in isolation', async ({ page, spa }) => {
    test.setTimeout(30_000);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Navigate via the real userButton → My Books SPA path
    const { navigateToUserPage } = await import('../../helpers/pageHelpers.js');
    await navigateToUserPage(page);
    await spa.waitForTransition(page);
    await verifyUserPage(page, spa);
  });

  test('reader page in isolation', async ({ page, spa }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const { clickFirstBookLink } = await import('../../helpers/pageHelpers.js');
    await clickFirstBookLink(page);
    await spa.waitForTransition(page);
    await verifyReaderPage(page, spa);
  });

  /* ── Phase 2: single tour lap ───────────────────────────────────── */

  test('single tour lap', async ({ page, spa }) => {
    test.setTimeout(90_000);
    const history = await runTour(page, spa, { loops: 1 });
    expect(history.length).toBeGreaterThan(0);
  });

  /* ── Phase 3: three-lap tour (accumulation test) ────────────────── */

  test('three-lap tour (state accumulation)', async ({ page, spa }) => {
    test.setTimeout(240_000);
    const history = await runTour(page, spa, { loops: 3 });
    // Sanity: history should have 3 × TOUR_STEPS.length entries
    expect(history.length).toBeGreaterThan(20);
  });

  /* ── Phase 4: back-button replay to start ───────────────────────── */

  test('back-button replay to start', async ({ page, spa }) => {
    test.setTimeout(180_000);
    const history = await runTour(page, spa, { loops: 1 });
    await replayBackToStart(page, spa, history);
  });

  /* ── Phase 5: forward-button replay to end ──────────────────────── */

  test('forward-button replay to end', async ({ page, spa }) => {
    test.setTimeout(240_000);
    const history = await runTour(page, spa, { loops: 1 });
    await replayBackToStart(page, spa, history);
    await replayForwardToEnd(page, spa, history);
  });

  /* ── Phase 6: deep authoring inside tour ────────────────────────── */
  /*
   * Mirrors the heaviest parts of authoring-workflow.spec.js:
   *   - Create a book via #newBook
   *   - Type heading + paragraph
   *   - Hyperlight a selection (assert <mark> appears)
   *   - Hypercite a different selection (capture clipboard payload)
   *   - Navigate home
   *   - Run a single tour lap after to prove authoring state didn't
   *     poison the next SPA cycle
   */
  test('authoring inside tour: create + hyperlight + hypercite + post-lap', async ({ page, spa }) => {
    test.setTimeout(180_000);

    // Start at home
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');

    // Create a book
    await page.evaluate(() => document.getElementById('newBook')?.click());
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.evaluate(() => document.getElementById('createNewBook')?.click());

    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');
    await spa.waitForEditMode(page);

    const bookId = await spa.getCurrentBookId(page);
    expect(bookId).toMatch(/^book_\d+$/);

    // Type heading + paragraph
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Grand Tour Test Book');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('Source text for hyperlight and hypercite. Some content that we will both highlight and quote.');
    await page.waitForTimeout(500);

    // ── Hyperlight ──
    const hlSelector = await findParagraphByText(page, 'Source text');
    expect(hlSelector).not.toBeNull();
    const hlText = await page.locator(hlSelector).textContent();
    const hlStart = hlText.indexOf('highlight');
    expect(hlStart).toBeGreaterThanOrEqual(0);
    await spa.selectTextInElement(page, hlSelector, hlStart, hlStart + 'highlight'.length);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hyperlight');
    await page.waitForFunction(() => {
      const c = document.getElementById('hyperlit-container');
      return c && c.classList.contains('open');
    }, null, { timeout: 10000 });
    const markCount = await page.locator('.main-content mark.user-highlight, .main-content mark.highlight').count();
    expect(markCount).toBeGreaterThanOrEqual(1);
    await spa.closeHyperlitContainer(page);

    // ── Hypercite ──
    await moveCursorToEnd(page);
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.keyboard.type('A second paragraph just to be sure quoted text works.');
    await page.waitForTimeout(500);
    const hcSelector = await findParagraphByText(page, 'quoted text');
    expect(hcSelector).not.toBeNull();
    const hcText = await page.locator(hcSelector).textContent();
    const hcStart = hcText.indexOf('quoted text');
    expect(hcStart).toBeGreaterThanOrEqual(0);
    await spa.selectTextInElement(page, hcSelector, hcStart, hcStart + 'quoted text'.length);
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hypercite');
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 5000 });

    // Wait for sync
    await waitForCloudGreen(page);

    // Exit edit mode (fires integrity verifier — important now that we shipped the
    // latex canonicalisation fix)
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // Navigate home and run a single tour lap to prove authoring state didn't poison
    // subsequent SPA cycles
    const { navigateToHome } = await import('../../helpers/pageHelpers.js');
    await navigateToHome(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('home');

    // One full tour lap after authoring
    await runTour(page, spa, { loops: 1 });
  });

});
