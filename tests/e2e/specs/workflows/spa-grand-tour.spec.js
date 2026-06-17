/**
 * SPA Grand Tour.
 * npm run test:e2e -- tests/e2e/specs/workflows/spa-grand-tour.spec.js
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
import { openToc } from '../../helpers/tocNav.js';
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

  /* ── Phase 5b-iii: toc-container resize (full-height right edge) ──── */
  /*
   * The TOC is left-anchored and resizes from its RIGHT edge — same dragger,
   * mirror geometry of hyperlit's left edge (was a cramped bottom-right corner
   * handle; now a full-height strip). Open the TOC and drive a REAL drag on its
   * `.resize-edge.resize-right` via the same generalised probe. require:true.
   */
  test('toc-container resize edge (real drag)', async ({ page, spa }) => {
    test.setTimeout(90_000);
    test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in .env.e2e');

    await page.goto(`/${READER_BOOK}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    const res = await probeResizeHandle(page, spa, {
      require: true,
      openSel: '#toc-container.open',
      edgeSel: '.resize-edge.resize-right',
      openFn: openToc,
    });
    expect(res.skipped, 'toc resize should run (TOC always opens)').toBeFalsy();
  });

  /* ── Phase 5b-iv: source-container resize (full-height left edge) ── */
  /*
   * The source/citation panel (#source-container, opened by #cloudRef) is
   * right-anchored like hyperlit, so it resizes from its LEFT edge. Its content
   * (incl. the resize edge) is built by sourceButton.js at runtime, and drag.js
   * had no source-container branch at all until now. Open it and drive a REAL
   * drag on `.resize-edge.resize-left` via the same generalised probe.
   */
  test('source-container resize edge (real drag)', async ({ page, spa }) => {
    test.setTimeout(90_000);
    test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in .env.e2e');

    await page.goto(`/${READER_BOOK}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    const res = await probeResizeHandle(page, spa, {
      require: true,
      openSel: '#source-container.open',
      edgeSel: '.resize-edge.resize-left',
      openFn: async (p) => {
        await p.click('#cloudRef');
        await p.waitForFunction(() => !!document.querySelector('#source-container.open'), null, { timeout: 8000 });
      },
    });
    expect(res.skipped, 'source resize should run (#cloudRef opens the panel)').toBeFalsy();
  });

  /* ── Phase 5b-v: source-container CLOSES after a resize (real close) ── */
  /*
   * Regression for the exact "won't close after I drag it" bug. A resize drag
   * sets inline transform/width !important on the panel; SourceManager.closeContainer
   * must clear them, otherwise removing `.open` fires no transition → transitionend
   * never lands → `.hidden` is never added and the panel is stuck open forever
   * (isAnimating also sticks true, blocking every later close). Open, REAL-drag,
   * then REAL-close (overlay click) and assert the panel actually leaves the screen.
   * NB: the resize probe above force-closes via classList, which would mask this.
   */
  test('source-container closes after resize (real close)', async ({ page, spa }) => {
    test.setTimeout(90_000);
    test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in .env.e2e');

    await page.goto(`/${READER_BOOK}`);
    await page.waitForLoadState('networkidle');
    expect(await spa.getStructure(page)).toBe('reader');

    // Open the source panel; wait for its left edge to settle on-screen.
    await page.click('#cloudRef');
    await page.waitForFunction(() => {
      const c = document.querySelector('#source-container.open');
      const e = c && c.querySelector('.resize-edge.resize-left');
      if (!e) return false;
      // Slide-in transform must rest at translateX(0) before we drag — `.open` is
      // set at animation START, so hit-testing alone passes mid-slide and the real
      // mousedown then lands on a moving target → no resize. Mirror the settle guard
      // in helpers/elementProbes.js probeResizeHandle.
      const t = getComputedStyle(c).transform;
      const tx = t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : 0;
      if (Math.abs(tx) > 1) return false;
      const r = e.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return !!(top && top.closest('.resize-edge.resize-left'));
    }, null, { timeout: 8000 });

    // Real drag on the left edge to resize.
    const g = await page.evaluate(() => {
      const e = document.querySelector('#source-container .resize-edge.resize-left');
      const r = e.getBoundingClientRect();
      const c = document.getElementById('source-container').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: c.width };
    });
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await page.mouse.move(g.x - 80, g.y, { steps: 8 });
    await page.mouse.up();
    const widened = await page.evaluate(() => document.getElementById('source-container').getBoundingClientRect().width);
    expect(Math.abs(widened - g.width), 'source resize drag had no effect').toBeGreaterThanOrEqual(6);

    // REAL close via the overlay (the gesture that hung before the fix), then assert the
    // panel is no longer .open AND has actually slid off-screen (inline transform cleared).
    await page.evaluate(() => document.getElementById('source-overlay')?.click());
    await page.waitForFunction(() => {
      const c = document.getElementById('source-container');
      if (!c || c.classList.contains('open')) return false;
      const r = c.getBoundingClientRect();
      return r.left >= window.innerWidth - 2 || r.right <= 2 || c.classList.contains('hidden');
    }, null, { timeout: 6000 });
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
    await page.evaluate(() => document.getElementById('newBookButton')?.click());
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

    // ── Resize the just-opened container with a REAL drag ──
    // The hyperlight above opened #hyperlit-container from content WE created — no
    // dependence on READER_BOOK having a pre-existing footnote. This is the gesture
    // that silently died after SPA nav when the dragger wasn't ButtonRegistry-managed.
    // Real Playwright mouse only (a user can't dispatch synthetic events); assert the
    // dragger exists, the edge is the topmost element, and the drag changes the width.
    // Wait for the slide-in (translateX, 0.3s) to settle so the edge is on-screen and
    // hit-testable — `.open` is set at animation START, so measuring immediately would
    // catch the edge still partway off the right of the viewport.
    await page.waitForFunction(() => {
      const e = document.querySelector('#hyperlit-container.open .resize-edge.resize-left');
      if (!e) return false;
      const r = e.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return !!(top && top.closest('.resize-edge.resize-left'));
    }, null, { timeout: 4000 });
    const rz = await page.evaluate(() => {
      const c = document.getElementById('hyperlit-container');
      const edge = c && c.querySelector('.resize-edge.resize-left'); // the full-height strip a user drags
      if (!edge) return null;
      const er = edge.getBoundingClientRect();
      const top = document.elementFromPoint(er.x + er.width / 2, er.y + er.height / 2);
      return {
        width: c.getBoundingClientRect().width,
        x: er.x + er.width / 2,
        y: er.y + er.height / 2,
        topIsEdge: !!(top && top.closest('.resize-edge.resize-left')),
        hasDragger: !!window.containerDragger,
      };
    });
    expect(rz, 'hyperlit-container opened but exposes no .resize-edge').not.toBeNull();
    expect(rz.hasDragger, 'window.containerDragger missing → resize dragger not initialised by ButtonRegistry on this page').toBe(true);
    expect(rz.topIsEdge, `resize edge is covered (not topmost at its centre) — a real drag would land elsewhere — ${JSON.stringify(rz)}`).toBe(true);
    await page.mouse.move(rz.x, rz.y);
    await page.mouse.down();
    await page.mouse.move(rz.x - 80, rz.y, { steps: 8 });
    const rzMid = await page.evaluate(() => !!document.querySelector('.resize-edge.resizing, .resize-handle.resizing'));
    await page.mouse.up();
    const rzAfter = await page.evaluate(() => {
      const c = document.getElementById('hyperlit-container');
      return c ? c.getBoundingClientRect().width : null;
    });
    expect(
      rzMid && Math.abs((rzAfter ?? rz.width) - rz.width) >= 6,
      `REAL drag on the resize edge did nothing (midResizing=${rzMid}, width ${rz.width}→${rzAfter}) — resize is dead on created content`,
    ).toBe(true);

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
    await expect(page.locator('#newBookButton')).toBeVisible();

    await page.click('#newBookButton');
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
      await page.click('#newBookButton');
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
      // Reach a reader page so the logo-nav new-book flow is in scope. The first
      // global home card is the newest *listed* book and may be owned by anyone,
      // so we do NOT assert editability on it — clicking it just gets us onto a
      // reader. We then CREATE the origin book below, guaranteeing an owned,
      // editable reader independent of shared DB state (whoever's import happens
      // to top the home list). A freshly-created reader is still "an existing
      // reader" for the purposes of entering the chain.
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spa.clickFirstBookLink(page);
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe('reader');

      // Create the origin (owned) book and sanity-check its perimeter buttons.
      const originId = await createOneNewBook();
      await verifyPerimeterButtonsWorking();

      const chainIds = [originId];

      // Chain N more new books, verifying perimeter buttons after each
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
