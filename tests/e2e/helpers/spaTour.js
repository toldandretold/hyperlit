/**
 * SPA Grand Tour orchestration.
 *
 * The "tour" walks a declarative path of SPA transitions through home →
 * user → reader and back, exercising the per-page verifier at every landing.
 * Loop it N times to surface state-accumulation bugs, then replay history
 * backward / forward to surface bfcache and history-state bugs.
 *
 * Used by:
 *   - specs/workflows/spa-grand-tour.spec.js
 */

import { expect } from '@playwright/test';
import {
  navigateToHome,
  navigateToUserPage,
  clickFirstBookLink,
} from './pageHelpers.js';
import {
  verifyHomePage,
  verifyUserPage,
  verifyReaderPage,
} from './pageVerifiers.js';

// Anchor book id captured at tour setup. The tour navigates to this book
// (by URL) instead of clicking an arbitrary library card, so it's immune
// to whatever corruption sits in the test user's existing library.
let _tourAnchorBookId = null;

/**
 * Create a fresh book from home (via the homepage + button) and remember
 * its id as the tour's anchor reader. Subsequent reader landings in the
 * tour navigate directly to this book's URL.
 *
 * Call ONCE per test before `runTour`.
 */
export async function setupTourAnchor(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(await spa.getStructure(page)).toBe('home');

  // Trigger the homepage + → New flow programmatically (same path as the
  // home page button — independent of where the + button physically sits).
  await page.evaluate(() => document.getElementById('newBook')?.click());
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
 * SPA navigation to the tour anchor reader. Used in TOUR_STEPS where the
 * old grand tour called `clickFirstBookLink`. The anchor is set by
 * `setupTourAnchor`; if missing, falls back to clickFirstBookLink so
 * pre-anchor specs (callers that haven't been migrated) still work.
 */
async function gotoAnchorReader(page) {
  if (_tourAnchorBookId) {
    await page.goto(`/${_tourAnchorBookId}`);
    return;
  }
  await clickFirstBookLink(page);
}

/**
 * SPA transition: from a reader, open the logo nav menu, click +, click
 * "New" — creating a fresh book and transitioning to its reader. Used as
 * a TOUR_STEP go() so the cyclic / accumulation / back-forward phases all
 * exercise the reader → new-book SPA pathway (NewBookTransition).
 *
 * Leaves the new reader OUT of edit mode so the standard verifyReaderPage
 * (which expects to start with `window.isEditing === false`) works.
 */
export async function createNewBookFromReader(page) {
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
  // The transition's edit-mode entry is awaited by the tour's
  // spa.waitForTransition + waitForEditMode wrapper, but we need to leave
  // edit mode here so verifyReaderPage's click → toggle flow starts clean.
  await page.waitForFunction(() => window.isEditing === true, null, { timeout: 10000 });
  await page.click('#editButton');
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });
}

/**
 * Tour steps. Each step:
 *   - `go(page)` — perform the SPA navigation. Returns when the click is dispatched.
 *   - `verify(page, spa)` — assert the destination page is healthy + interactive.
 *   - `page` — the expected destination structure (`'home'` | `'user'` | `'reader'`).
 *   - `label` — short human-readable identifier for error messages.
 *
 * Path covers: home→user, user→reader, reader→(+)→reader (new book),
 * reader→home, home→reader, reader→user, user→reader, reader→home.
 * The reader→reader-via-+ step exercises the NewBookTransition pathway
 * inside the cyclic/accumulation/back-forward replay phases.
 */
export const TOUR_STEPS = [
  { label: 'home (start)',          go: async (p) => { await p.goto('/'); }, verify: verifyHomePage,   page: 'home'   },
  { label: 'home → user',           go: navigateToUserPage,                  verify: verifyUserPage,   page: 'user'   },
  { label: 'user → reader',         go: gotoAnchorReader,                    verify: verifyReaderPage, page: 'reader' },
  { label: 'reader → reader (+)',   go: createNewBookFromReader,             verify: verifyReaderPage, page: 'reader' },
  { label: 'reader → home',         go: navigateToHome,                      verify: verifyHomePage,   page: 'home'   },
  { label: 'home → reader',         go: gotoAnchorReader,                    verify: verifyReaderPage, page: 'reader' },
  { label: 'reader → user',         go: navigateToUserPage,                  verify: verifyUserPage,   page: 'user'   },
  { label: 'user → reader (2)',     go: gotoAnchorReader,                    verify: verifyReaderPage, page: 'reader' },
  { label: 'reader → home (end)',   go: navigateToHome,                      verify: verifyHomePage,   page: 'home'   },
];

/**
 * Run the tour `loops` times in sequence.
 *
 * Returns the step history (array of `{ loop, stepIndex, label, page }`)
 * suitable for feeding into replayBackToStart / replayForwardToEnd.
 *
 * On failure, the error message includes loop+step coordinates so you can
 * see exactly which transition broke (e.g. "lap 2, step 3 'reader → home'").
 */
export async function runTour(page, spa, { loops = 1 } = {}) {
  const history = [];
  for (let loop = 1; loop <= loops; loop++) {
    for (let i = 0; i < TOUR_STEPS.length; i++) {
      const step = TOUR_STEPS[i];
      try {
        await step.go(page);
        // First step (`page.goto('/')`) waits for load; subsequent ones use the SPA transition.
        if (i === 0 && loop === 1) {
          await page.waitForLoadState('networkidle');
        } else {
          await spa.waitForTransition(page);
        }
        await step.verify(page, spa);
        history.push({ loop, stepIndex: i, label: step.label, page: step.page });
      } catch (err) {
        throw new Error(
          `SPA tour failed at lap ${loop}, step ${i} (${step.label}, expected page=${step.page}): ${err.message}`
        );
      }
    }
  }
  return history;
}

/**
 * Walk the browser history backward from the current position, verifying the
 * landing at each step. The `history` arg should be the array returned by
 * runTour. We replay it in reverse: pop the last step, page.goBack(), verify
 * the *previous* step's expected page.
 *
 * Skips the first entry (we can't go back from the tour's starting point).
 */
export async function replayBackToStart(page, spa, history) {
  // history[i] is the page we LANDED on after step i. To go back, we expect
  // to arrive at history[i-1]'s page. So replay from end down to index 1.
  for (let i = history.length - 1; i >= 1; i--) {
    const target = history[i - 1];
    try {
      await page.goBack();
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe(target.page);
      await pickVerifier(target.page)(page, spa);
    } catch (err) {
      throw new Error(
        `Back-button replay failed going back to "${target.label}" (expected page=${target.page}): ${err.message}`
      );
    }
  }
}

/**
 * Mirror of replayBackToStart, but with page.goForward().
 * Assumes you've already walked back to the start.
 */
export async function replayForwardToEnd(page, spa, history) {
  // After replayBackToStart we're sitting at history[0]. Go forward through
  // history[1..end], verifying each landing.
  for (let i = 1; i < history.length; i++) {
    const target = history[i];
    try {
      await page.goForward();
      await spa.waitForTransition(page);
      expect(await spa.getStructure(page)).toBe(target.page);
      await pickVerifier(target.page)(page, spa);
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
