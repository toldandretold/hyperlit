/**
 * SPA Grand Tour orchestration.
 *
 * The "tour" walks a declarative path of SPA transitions through home →
 * user → reader and back, exercising the per-page verifier at every landing.
 * Loop it N times to surface state-accumulation bugs, then replay history
 * backward / forward to surface bfcache and history-state bugs.
 *
 * COVERAGE GOAL: every SPA navigation pathway is exercised by a real UI
 * gesture (a link/card/button click — NOT page.goto, which is a full reload
 * that bypasses the SPA router entirely). Each step is tagged with the
 * `pathway` it exercises and asserts — via a survives-a-reload sentinel — that
 * it actually used an in-page SPA transition. After a lap the caller can read
 * `getCoveredPathways()` and assert nothing was missed.
 *
 * Pathways (see resources/js/navigation/): fresh-page-load, different-template,
 * same-template (home content-swap), create-new-book, book-to-book,
 * user-to-user, import-book (heavy spec), popstate-back/forward (replay).
 *
 * Used by:
 *   - specs/workflows/spa-grand-tour.spec.js
 *   - specs/workflows/spa-pathways-heavy.spec.js (import-book)
 */

import { expect } from '@playwright/test';
import {
  navigateToHome,
  navigateToUserPage,
  navigateViaHypercite,
  openHomeFeed,
} from './pageHelpers.js';
import {
  verifyHomePage,
  verifyUserPage,
  verifyReaderPage,
} from './pageVerifiers.js';

// Anchor book id captured at tour setup. The tour prefers this book's library
// card when entering a reader, so it's immune to whatever corruption sits in
// the test user's existing library; it falls back to the first card if absent.
let _tourAnchorBookId = null;

/* ── Pathway coverage tracking ─────────────────────────────────────────── */

/** Canonical pathway ids the grand tour aims to cover (import-book lives in
 *  the heavy spec). popstate-* come from the replay phases. */
export const ALL_SPA_PATHWAYS = [
  'fresh-page-load',
  'different-template',
  'same-template',
  'create-new-book',
  'book-to-book',
  'user-to-user',
  'popstate-back',
  'popstate-forward',
];

let _covered = new Set();
export function resetCoverage() { _covered = new Set(); }
export function getCoveredPathways() { return Array.from(_covered).sort(); }
function markCovered(pathway) { if (pathway) _covered.add(pathway); }

/* ── SPA sentinel: prove a step used an in-page transition, not a reload ─── */

/** Plant a token on window. A full page load wipes it; any SPA transition
 *  keeps it. Call right before triggering a navigation. */
async function plantSpaSentinel(page) {
  await page.evaluate(() => { window.__tourSpaSentinel = 'live'; });
}
/** True if the sentinel survived (i.e. the last navigation was an SPA transition). */
async function spaSentinelSurvived(page) {
  return page.evaluate(() => window.__tourSpaSentinel === 'live');
}

/* ── Reader entry via a real library-card click (SPA, DifferentTemplate) ─── */

/**
 * Enter a reader by CLICKING a library card — the real SPA path
 * (DifferentTemplate). Replaces the old page.goto(), which was a full reload
 * and therefore never exercised SPA reader-entry. Prefers the anchor book's
 * card; falls back to the first card (the reader verifier is book-agnostic).
 */
async function enterReaderViaCard(page) {
  await openHomeFeed(page); // homepage defers its feed — press Most Recent first
  await page.waitForSelector('.libraryCard a[href]', { timeout: 10000 });
  const pick = async () => {
    if (_tourAnchorBookId) {
      const anchor = page.locator(`.libraryCard a[href$="/${_tourAnchorBookId}"]`).first();
      if (await anchor.count()) return anchor;
    }
    // Prefer an actual book-reader link (/book_…) over any other card anchor.
    const bookLink = page.locator('.libraryCard a[href^="/book_"]').first();
    if (await bookLink.count()) return bookLink;
    return page.locator('.libraryCard a[href]').first();
  };
  await (await pick()).click();
  // The generic runTour waitForTransition can race this DifferentTemplate
  // pathway (the structure briefly reads stale). Wait for the reader to
  // actually land; retry the click once if the first didn't register — but
  // ONLY if no transition is observably in flight (loading overlay visible =
  // the first click DID register and the entry is just slow, e.g. parked
  // behind the home book's background hydration; a blind second click then
  // stacks a second full transition on top and doubles the stall).
  try {
    await page.waitForFunction(() => document.body.getAttribute('data-page') === 'reader', null, { timeout: 8000 });
  } catch {
    const inFlight = await page.evaluate(() => {
      const ov = document.getElementById('initial-navigation-overlay');
      return !!ov && getComputedStyle(ov).display !== 'none';
    });
    if (!inFlight) {
      await (await pick()).click();
    }
    await page.waitForFunction(() => document.body.getAttribute('data-page') === 'reader', null, { timeout: 15000 });
  }
}

/* ── Reader entry via a hypercite-map dot (SVG anchor, after a feed open+close) ── */

/**
 * Enter a reader by CLICKING a dot in the hero's hypercite-network map — an
 * `<a>` INSIDE an `<svg>`, whose `href` is an SVGAnimatedString object rather
 * than a string. Every other hero→reader hop in the lap goes through a library
 * card (a plain HTML anchor), so the lap walked straight past the 2026-11-16
 * bug: with a feed lazy loader alive on the hero, its document click handler
 * built the URL from `link.href` and routed the dot to a book called
 * "[object SVGAnimatedString]".
 *
 * The gesture is the one the user actually hit: open a feed (mints the lazy
 * loader; the hero — map included — is hidden under `.content-active`), close
 * it with ✕ (the hero returns), click a dot. Closing the feed must RELEASE the
 * loader (homepageDisplayUnit.closeFeedContent → resetCurrentLazyLoader), so a
 * hero with no feed has no SPA anchor router and the dot navigates NATIVELY —
 * the step is therefore `spa: false` in TOUR_STEPS and asserts the reload
 * itself: a surviving sentinel means the loader outlived the feed, which was
 * the whole bug. (If dots are ever made to SPA-route on a bare hero by design,
 * flip that assertion deliberately.) Either way it must land on the dot's own
 * book, never on the stringified href object.
 *
 * FAILS LOUDLY when the hero renders no dot (the home map needs ≥2 public,
 * hypercited-together books; the dev DB has them). A silent fallback to a card
 * would quietly narrow coverage, which is the gap this step closes.
 */
async function enterReaderViaMapDot(page) {
  await openHomeFeed(page); // mints the feed lazy loader
  const closeFeed = page.locator('#copy-feed-close');
  if (await closeFeed.count()) {
    await closeFeed.click();
    // closeFeed drops .content-active at once, then GLIDES the hero back to
    // centre (.hero-return, 700ms). A click aimed during the glide lands on
    // whatever has moved under the dot's old box (it hit "Most Connected" and
    // reopened the feed) — wait the glide out before measuring anything.
    await page.waitForFunction(
      () => !document.querySelector('#app-container.content-active') && !document.querySelector('#app-container.hero-return'),
      null,
      { timeout: 10000 },
    );
  }
  const dot = page.locator('a[data-map-node]').first();
  if (!(await dot.count())) {
    throw new Error(
      'hero page renders no hypercite-map dot (a[data-map-node]); the map needs public books hypercited together — '
      + 'seed two connected books (or wait out the 15-min home-map cache) rather than letting this step fall back to a card',
    );
  }
  const dotPath = (await dot.getAttribute('href') || '').split('#')[0];
  expect(dotPath, 'map dot href should be a book path').toMatch(/^\/[^/]+/);
  await expect(dot).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => { window.__mapDotSentinel = 'live'; });
  // A real click (actionability: stable + receives events); force only if the
  // map's hover card sits over the small SVG target.
  await dot.click({ timeout: 5000 }).catch(() => dot.click({ force: true }));
  await page.waitForFunction(() => document.body.getAttribute('data-page') === 'reader', null, { timeout: 15000 });
  // Pathname only — the map's own desktop capture handler may append a
  // `#hypercite_…` intro hash before navigation.
  await expect
    .poll(() => page.evaluate(() => location.pathname), { timeout: 15000 })
    .toBe(dotPath);
  expect(page.url(), 'dot must route to its real book, never the stringified href object').not.toContain('SVGAnimatedString');
  const loaderOutlivedFeed = await page.evaluate(() => window.__mapDotSentinel === 'live');
  expect(loaderOutlivedFeed, 'closing the feed must release its lazy loader: a dot on a bare hero navigates natively (full load), '
    + 'so the sentinel must NOT survive — a surviving one means a feed loader is still routing anchors on the hero').toBe(false);
}

/**
 * Same-template home content-swap (dedicated phase, NOT part of the replayed
 * lap — back-button over an arranger swap full-reloads, which would desync
 * history replay). Switch to a different arranger tab (Most Recent ↔ Most
 * Connected ↔ Most Lit): keeps the wrapper, swaps only .main-content. Returns
 * false (covers nothing) if there's no alternate tab to swap to.
 */
export async function homeToHomeArranger(page, spa) {
  expect(await spa.getStructure(page)).toBe('home');
  // The lava-lamp homepage defers its feed — open it first (Most Recent), so
  // the swap below is a genuine .main-content content-swap, not a feed-open.
  await openHomeFeed(page);
  const alt = page.locator('.arranger-button:not(.active)').first();
  if (!(await alt.count())) return false;

  await plantSpaSentinel(page);
  await alt.click();
  await spa.waitForTransition(page).catch(() => {});
  // Content-swap keeps the page (no reload): sentinel must survive, still home.
  expect(await spaSentinelSurvived(page), 'arranger home-swap should not reload').toBe(true);
  expect(await spa.getStructure(page)).toBe('home');
  await verifyHomePage(page, spa);
  markCovered('same-template');
  return true;
}

/**
 * user → user SPA transition (DifferentTemplate via handleUserToUser),
 * dedicated phase — NOT in the replayed lap: it navigates to the SAME
 * /u/username URL, and consecutive same-URL history entries don't reverse
 * cleanly under back-button replay. Re-navigates to the own user page from the
 * user page via the real userButton → My Books gesture.
 */
export async function navigateUserToUser(page, spa) {
  if (await spa.getStructure(page) !== 'user') {
    await navigateToUserPage(page);
    await spa.waitForTransition(page);
    expect(await spa.getStructure(page)).toBe('user');
  }
  await plantSpaSentinel(page);
  await navigateToUserPage(page);
  await spa.waitForTransition(page);
  expect(await spaSentinelSurvived(page), 'user→user should be an SPA transition').toBe(true);
  expect(await spa.getStructure(page)).toBe('user');
  await verifyUserPage(page, spa);
  markCovered('user-to-user');
}

/* ── Tour setup ────────────────────────────────────────────────────────── */

/**
 * Create a fresh book from home (via the homepage + button) and remember
 * its id as the tour's anchor reader. Call ONCE per test before `runTour`.
 * Also resets pathway coverage for the run.
 */
export async function setupTourAnchor(page, spa) {
  resetCoverage();
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(await spa.getStructure(page)).toBe('home');

  await page.evaluate(() => document.getElementById('newBookButton')?.click());
  await page.waitForFunction(() => {
    const c = document.getElementById('newbook-container');
    if (!c) return false;
    const style = window.getComputedStyle(c);
    return style.opacity === '1' && c.getBoundingClientRect().width > 0;
  }, null, { timeout: 5000 });
  await page.evaluate(() => document.getElementById('createNewBook')?.click());

  await spa.waitForTransition(page);
  expect(await spa.getStructure(page)).toBe('reader');
  await spa.waitForEditMode(page);

  const id = await spa.getCurrentBookId(page);
  if (!/^book_\d+$/.test(id)) {
    throw new Error(`setupTourAnchor: unexpected anchor book id "${id}"`);
  }
  _tourAnchorBookId = id;

  // Exit edit mode so verifyReaderPage's toggle flow starts in a known state.
  await page.click('#editButton');
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

  return id;
}

/**
 * SPA transition: from a reader, open the logo nav menu, click +, click
 * "New" — creating a fresh book and transitioning to its reader
 * (NewBookTransition / create-new-book pathway). Leaves the new reader OUT of
 * edit mode so the standard verifyReaderPage works.
 */
export async function createNewBookFromReader(page) {
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
  // 15s, deliberately ABOVE enableEditMode's internal 10s first-chunk cap: a
  // slow entry (reader getAll parked behind home-book hydration) engages edit
  // mode via that cap path, and a 10s test wait mathematically loses to it.
  await page.waitForFunction(() => window.isEditing === true, null, { timeout: 15000 });
  await page.click('#editButton');
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
}

/* ── Tour steps ────────────────────────────────────────────────────────── */
/**
 * Each step:
 *   - `go(page)` — perform the navigation (a real UI gesture).
 *   - `verify(page, spa)` — assert the destination is healthy + interactive.
 *   - `page` — expected destination structure.
 *   - `pathway` — the SPA pathway this step exercises (for coverage).
 *   - `spa` — false for the initial full page load; otherwise the step must
 *     prove (via the sentinel) it used an in-page SPA transition.
 *   - `label` — short identifier for error messages.
 *
 * Covers, in one lap: fresh-page-load, different-template (home↔user↔reader via
 * card, AND home→reader via a hypercite-map SVG dot with the feed loader alive),
 * user-to-user, create-new-book, same-template (home content-swap).
 * book-to-book + import-book are exercised by dedicated phases/specs;
 * popstate-back/forward by the replay phases.
 */
export const TOUR_STEPS = [
  { label: 'home (start)',          go: async (p) => { await p.goto('/'); }, verify: verifyHomePage,   page: 'home',   pathway: 'fresh-page-load',     spa: false },
  { label: 'home → user',           go: navigateToUserPage,                  verify: verifyUserPage,   page: 'user',   pathway: 'different-template' },
  { label: 'user → reader (card)',  go: enterReaderViaCard,                  verify: verifyReaderPage, page: 'reader', pathway: 'different-template' },
  { label: 'reader → reader (+)',   go: createNewBookFromReader,             verify: verifyReaderPage, page: 'reader', pathway: 'create-new-book' },
  { label: 'reader → home',         go: navigateToHome,                      verify: verifyHomePage,   page: 'home',   pathway: 'different-template' },
  { label: 'home → reader (map dot)', go: enterReaderViaMapDot,              verify: verifyReaderPage, page: 'reader', pathway: 'different-template', spa: false }, // native by design — see enterReaderViaMapDot
  { label: 'reader → user',         go: navigateToUserPage,                  verify: verifyUserPage,   page: 'user',   pathway: 'different-template' },
  { label: 'user → reader (card 2)',go: enterReaderViaCard,                  verify: verifyReaderPage, page: 'reader', pathway: 'different-template' },
  { label: 'reader → home (end)',   go: navigateToHome,                      verify: verifyHomePage,   page: 'home',   pathway: 'different-template' },
];

/**
 * Run the tour `loops` times. Returns step history for the replay phases.
 * Each step plants the SPA sentinel before navigating and (unless spa===false)
 * asserts it survived — proving a real in-page transition, not a reload.
 */
export async function runTour(page, spa, { loops = 1 } = {}) {
  const history = [];
  for (let loop = 1; loop <= loops; loop++) {
    for (let i = 0; i < TOUR_STEPS.length; i++) {
      const step = TOUR_STEPS[i];
      try {
        if (step.spa !== false) await plantSpaSentinel(page);
        await step.go(page);
        if (i === 0 && loop === 1) {
          await page.waitForLoadState('networkidle');
        } else {
          await spa.waitForTransition(page);
        }
        if (step.spa !== false) {
          const survived = await spaSentinelSurvived(page);
          expect(survived, `${step.label} should be an SPA transition (not a full reload)`).toBe(true);
        }
        await step.verify(page, spa);
        markCovered(step.pathway);
        history.push({ loop, stepIndex: i, label: step.label, page: step.page, pathway: step.pathway });
      } catch (err) {
        throw new Error(
          `SPA tour failed at lap ${loop}, step ${i} (${step.label}, expected page=${step.page}, pathway=${step.pathway}): ${err.message}`
        );
      }
    }
  }
  return history;
}

/* ── book-to-book (dedicated, needs a hypercite-bearing book) ──────────── */

/**
 * reader → reader via a hypercite link (book-to-book / BookToBookTransition).
 * Requires a book whose reader contains a hypercite. Returns false (and covers
 * nothing) if none present, so callers can skip rather than fail.
 */
export async function navigateBookToBook(page, spa, bookId) {
  await page.goto(`/${bookId}`);
  await page.waitForLoadState('networkidle');
  expect(await spa.getStructure(page)).toBe('reader');

  const hasHypercite = await page.locator('a.open-icon[id^="hypercite_"], u.couple[id^="hypercite_"]').count();
  if (!hasHypercite) return false;

  await plantSpaSentinel(page);
  await navigateViaHypercite(page);
  await spa.waitForTransition(page);
  expect(await spaSentinelSurvived(page), 'book-to-book should be an SPA transition').toBe(true);
  expect(await spa.getStructure(page)).toBe('reader');
  await verifyReaderPage(page, spa);
  markCovered('book-to-book');
  return true;
}

/* ── History replay ────────────────────────────────────────────────────── */

/**
 * Wait for a popstate landing to SETTLE on the expected structure.
 *
 * `waitForTransition` returns when the nav overlay hides (+300ms), but that is
 * only the FIRST reconcile pass: LinkNavigationHandler.handlePopstate runs a
 * convergence loop (up to 3 more passes) whenever the rendered DOM doesn't
 * match the live URL — the documented "burst back lands on home" desync. So
 * sampling getStructure() at one instant races the convergence and reads the
 * PREVIOUS page (observed: forward to "home → user" intermittently seeing
 * "home", ~2 failures in 5 runs).
 *
 * Polling here does not weaken the assertion — it still fails if the DOM never
 * reaches the expected page, which is exactly what a real desync looks like.
 * It only stops the test from judging before the handler has finished.
 */
async function expectStructureSettles(page, spa, expected) {
  await expect
    .poll(() => spa.getStructure(page), {
      timeout: 10_000,
      message: `popstate landing never converged on "${expected}"`,
    })
    .toBe(expected);
}

export async function replayBackToStart(page, spa, history) {
  for (let i = history.length - 1; i >= 1; i--) {
    const target = history[i - 1];
    try {
      await page.goBack();
      await spa.waitForTransition(page);
      await expectStructureSettles(page, spa, target.page);
      await pickVerifier(target.page)(page, spa);
      markCovered('popstate-back');
    } catch (err) {
      throw new Error(
        `Back-button replay failed going back to "${target.label}" (expected page=${target.page}): ${err.message}`
      );
    }
  }
}

export async function replayForwardToEnd(page, spa, history) {
  for (let i = 1; i < history.length; i++) {
    const target = history[i];
    try {
      await page.goForward();
      await spa.waitForTransition(page);
      await expectStructureSettles(page, spa, target.page);
      await pickVerifier(target.page)(page, spa);
      markCovered('popstate-forward');
    } catch (err) {
      throw new Error(
        `Forward-button replay failed going forward to "${target.label}" (expected page=${target.page}): ${err.message}`
      );
    }
  }
}

function pickVerifier(pageType) {
  switch (pageType) {
    case 'home':   return verifyHomePage;
    case 'user':   return verifyUserPage;
    case 'reader': return verifyReaderPage;
    default: throw new Error(`Unknown page type: ${pageType}`);
  }
}
