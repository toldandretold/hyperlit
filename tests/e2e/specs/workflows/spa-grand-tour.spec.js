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
import { probeResizeHandle } from '../../helpers/elementProbes.js';
import {
  runTour,
  replayBackToStart,
  replayForwardToEnd,
  setupTourAnchor,
  navigateBookToBook,
  homeToHomeArranger,
  navigateUserToUser,
  getCoveredPathways,
  ALL_SPA_PATHWAYS,
} from '../../helpers/spaTour.js';

const READER_BOOK = process.env.E2E_READER_BOOK;

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
    test.setTimeout(120_000);
    await setupTourAnchor(page, spa);
    const history = await runTour(page, spa, { loops: 1 });
    expect(history.length).toBeGreaterThan(0);
  });

  /* ── Phase 3: three-lap tour (accumulation test) ────────────────── */

  test('three-lap tour (state accumulation)', async ({ page, spa }) => {
    test.setTimeout(300_000);
    await setupTourAnchor(page, spa);
    const history = await runTour(page, spa, { loops: 3 });
    // Sanity: history should have 3 × TOUR_STEPS.length entries
    expect(history.length).toBeGreaterThan(20);
  });

  /* ── Phase 4: back-button replay to start ───────────────────────── */

  test('back-button replay to start', async ({ page, spa }) => {
    test.setTimeout(240_000);
    await setupTourAnchor(page, spa);
    const history = await runTour(page, spa, { loops: 1 });
    await replayBackToStart(page, spa, history);
  });

  /* ── Phase 5: forward-button replay to end ──────────────────────── */

  test('forward-button replay to end', async ({ page, spa }) => {
    test.setTimeout(300_000);
    await setupTourAnchor(page, spa);
    const history = await runTour(page, spa, { loops: 1 });
    await replayBackToStart(page, spa, history);
    await replayForwardToEnd(page, spa, history);
  });

  /* ── Phase 5b: book-to-book (hypercite) pathway ─────────────────── */
  /*
   * reader→reader via a hypercite link — the BookToBookTransition pathway,
   * which the goto-based / +-based reader entries never exercise. Needs a
   * book whose reader contains a hypercite (E2E_READER_BOOK).
   */
  test('book-to-book via hypercite', async ({ page, spa }) => {
    test.setTimeout(60_000);
    test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in .env.e2e');
    const navigated = await navigateBookToBook(page, spa, READER_BOOK);
    test.skip(!navigated, `${READER_BOOK} has no hypercite to drive book-to-book`);
  });

  /* ── Phase 5b-ii: resize handle survives SPA nav ────────────────── */
  /*
   * One of the three reported "dead after SPA nav" elements. Drive the resize
   * edge against a content-rich book, then SPA-navigate away (home) and back
   * (card click — keeps the persistent containerDragger singleton alive) and
   * drive it again. require:true → a non-engaging or stuck-`.resizing` resize
   * is a hard failure here (controlled book, unlike the generic verifier).
   */
  test('resize handle survives SPA nav', async ({ page, spa }) => {
    test.setTimeout(90_000);
    test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in .env.e2e');

    await page.goto(`/${READER_BOOK}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');
    const baseline = await probeResizeHandle(page, spa, { require: true });
    expect(baseline.skipped, 'baseline resize should run (book needs a footnote/hypercite)').toBeFalsy();

    // SPA away to home, then SPA back to the same book via its card.
    await page.evaluate(() => document.getElementById('homeButtonNav')?.click());
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('home');
    const card = page.locator(`.libraryCard a[href$="${READER_BOOK}"]`).first();
    if (await card.count()) {
      await card.click();
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('reader');
      const afterNav = await probeResizeHandle(page, spa, { require: true });
      expect(afterNav.skipped).toBeFalsy();
    }
  });

  /* ── Phase 5c: every SPA pathway is covered ─────────────────────── */
  /*
   * Guard against silent coverage gaps. Run a full lap + book-to-book +
   * back/forward replay, then assert the union of pathways exercised equals
   * the canonical ALL_SPA_PATHWAYS set. If a future refactor drops a pathway
   * from the tour (or a new pathway is added), this fails loudly.
   * (import-book is asserted by spa-pathways-heavy.spec.js.)
   */
  test('all SPA pathways covered', async ({ page, spa }) => {
    test.setTimeout(300_000);
    // A lap covers fresh-page-load, different-template, user-to-user,
    // create-new-book; it ends on home.
    await setupTourAnchor(page, spa);
    const lapHistory = await runTour(page, spa, { loops: 1 });

    // Replay back/forward FIRST (covers popstate) while the lap's history is
    // still intact — book-to-book's goto below would otherwise wipe it.
    await replayBackToStart(page, spa, lapHistory);
    await replayForwardToEnd(page, spa, lapHistory); // ends on home

    await homeToHomeArranger(page, spa);             // same-template (stays home)
    await navigateUserToUser(page, spa);             // user-to-user
    if (READER_BOOK) await navigateBookToBook(page, spa, READER_BOOK); // book-to-book

    const covered = getCoveredPathways();
    const expected = READER_BOOK
      ? ALL_SPA_PATHWAYS
      : ALL_SPA_PATHWAYS.filter((p) => p !== 'book-to-book');
    const missing = expected.filter((p) => !covered.includes(p));
    expect(missing, `uncovered SPA pathways: ${missing.join(', ')} (covered: ${covered.join(', ')})`).toEqual([]);
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

    // Set a fresh anchor before the followup tour so we don't hit any
    // corrupted book in the test user's library.
    await setupTourAnchor(page, spa);
    await runTour(page, spa, { loops: 1 });
  });

  /* ── Phase 7: authoring originating FROM reader (new transition path) ── */
  /*
   * Phase 6 starts from home. This one starts from a reader page and uses
   * the +-in-logo-nav entry point that lives only on reader.blade.php —
   * a same-template (reader → reader) SPA transition triggered by the
   * NewBookContainerManager, which is new wiring on the reader.
   *
   * What's exercised:
   *   - Logo nav opens, + becomes visible
   *   - Click + → buttons popup
   *   - Click "New" → SPA transition to a freshly created reader
   *   - Editing works in the new reader
   *   - Exit edit + navigate home → state is clean
   *   - One follow-up tour lap to surface any state poisoning
   */
  test('authoring originating from reader: + → New → reader → home', async ({ page, spa }) => {
    test.setTimeout(180_000);

    // Land on a reader page via the real SPA path
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('home');
    await spa.clickFirstBookLink(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');

    const originBookId = await spa.getCurrentBookId(page);
    expect(originBookId).toMatch(/^book_\d+$/);

    // Open the logo nav → + → buttons popup
    await page.click('#logoContainer');
    await page.waitForSelector('#logoNavMenu:not(.hidden)', { timeout: 3000 });
    await expect(page.locator('#newBook')).toBeVisible();

    await page.click('#newBook');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      if (!c) return false;
      const style = window.getComputedStyle(c);
      const rect = c.getBoundingClientRect();
      return style.opacity === '1' && rect.width > 0 && rect.height > 0;
    }, null, { timeout: 5000 });

    // "New" → SPA transition to a fresh reader page
    await page.click('#createNewBook');
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('reader');
    await spa.waitForEditMode(page);

    const newBookId = await spa.getCurrentBookId(page);
    expect(newBookId).toMatch(/^book_\d+$/);
    expect(newBookId).not.toBe(originBookId); // confirm it's actually a new book

    // Type a heading so editing path is exercised (mirrors Phase 6)
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
    await page.click('h1[id="100"]');
    await page.keyboard.type('Reader-Origin Test Book');
    await page.waitForTimeout(300);

    // Wait for the autosave/sync to settle before navigating away
    await waitForCloudGreen(page);

    // Exit edit mode → integrity verifier fires
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // Navigate home → state should be clean, no integrity overlay
    const { navigateToHome } = await import('../../helpers/pageHelpers.js');
    await navigateToHome(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('home');
    expect(await page.locator('#integrity-failure-backdrop').count()).toBe(0);

    // Re-visit the newly created book directly. The save-queue / IDB state
    // for this book should be self-consistent — DOM h1 matches IDB. If the
    // body-replacement raced the SaveQueue flush, this revisit would trip
    // the integrity verifier on the just-typed h1.
    await page.goto(`/${newBookId}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');
    expect(await page.locator('#integrity-failure-backdrop').count()).toBe(0);
  });

  /* ── Phase 8: chained new-book transitions + history walk + loops ───── */
  /*
   * The reader-origin new-book flow needs the button registry to rebind
   * after each body replacement so perimeter buttons (edit, TOC, settings)
   * stay alive on the freshly inserted DOM. This phase chains multiple
   * new-book creations from a reader, verifies the perimeter buttons work
   * at every depth, then walks back AND forward through history. The
   * full sequence is run TWICE to surface accumulation bugs.
   *
   * Concretely tests:
   *   - perimeter buttons not stuck in `.loading` after SPA transition
   *   - #editButton listeners alive (clicking it toggles window.isEditing)
   *   - #toc-toggle-button visible
   *   - back/forward through the new-book chain lands on the right book
   *     with working buttons at each step
   *   - re-entering the chain from home in a second loop doesn't poison
   *     the registry
   */
  test('chained new books from reader + history walk, two loops', async ({ page, spa }) => {
    test.setTimeout(360_000);

    const CHAIN_DEPTH = 3;
    const LOOPS = 2;

    const verifyPerimeterButtonsWorking = async () => {
      await expect(page.locator('#editButton')).toBeVisible();
      await expect(page.locator('#toc-toggle-button')).toBeVisible();

      // The .loading class hides perimeter clusters until init removes it.
      // If the registry didn't rebind, .loading is stuck on the new DOM.
      const editLoading = await page.evaluate(
        () => document.getElementById('bottom-right-buttons')?.classList.contains('loading')
      );
      expect(editLoading, '#bottom-right-buttons stuck in .loading').toBe(false);

      // Click edit → window.isEditing flips. Proves the button's listeners
      // were bound to the CURRENT DOM (not stale references).
      const before = await page.evaluate(() => window.isEditing);
      await page.click('#editButton');
      await page.waitForFunction(
        (b) => window.isEditing !== b,
        before,
        { timeout: 5000 }
      );
      // Toggle back so subsequent steps start out of edit mode
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
    };

    const createOneNewBook = async () => {
      await page.click('#logoContainer');
      await page.waitForSelector('#logoNavMenu:not(.hidden)', { timeout: 3000 });
      await page.click('#newBook');
      await page.waitForFunction(() => {
        const c = document.getElementById('newbook-container');
        if (!c) return false;
        const style = window.getComputedStyle(c);
        return style.opacity === '1' && c.getBoundingClientRect().width > 0;
      }, null, { timeout: 5000 });
      await page.click('#createNewBook');
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('reader');
      await spa.waitForEditMode(page);

      const id = await spa.getCurrentBookId(page);
      expect(id).toMatch(/^book_\d+$/);

      // Exit edit mode so verifyPerimeterButtonsWorking starts in a known state
      await page.click('#editButton');
      await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
      return id;
    };

    for (let loop = 1; loop <= LOOPS; loop++) {
      // Land on an existing reader
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spa.clickFirstBookLink(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('reader');

      // Sanity-check the origin reader's perimeter buttons
      await verifyPerimeterButtonsWorking();

      const chainIds = [await spa.getCurrentBookId(page)];

      // Chain N new books, verifying perimeter buttons after each
      for (let depth = 1; depth <= CHAIN_DEPTH; depth++) {
        const id = await createOneNewBook();
        chainIds.push(id);
        await verifyPerimeterButtonsWorking();
      }
      expect(new Set(chainIds).size, 'all books in chain distinct').toBe(chainIds.length);

      // Walk back through history; each landing must be a working reader
      for (let i = chainIds.length - 1; i >= 1; i--) {
        await page.goBack();
        await spa.waitForTransition(page);
        expect(await spa.getStructure(page)).toBe('reader');
        expect(await spa.getCurrentBookId(page)).toBe(chainIds[i - 1]);
        await verifyPerimeterButtonsWorking();
      }

      // Walk forward back to the deepest new book
      for (let i = 1; i < chainIds.length; i++) {
        await page.goForward();
        await spa.waitForTransition(page);
        expect(await spa.getStructure(page)).toBe('reader');
        expect(await spa.getCurrentBookId(page)).toBe(chainIds[i]);
        await verifyPerimeterButtonsWorking();
      }
    }
  });

});
