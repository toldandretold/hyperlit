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

/**
 * Tour steps. Each step:
 *   - `go(page)` — perform the SPA navigation. Returns when the click is dispatched.
 *   - `verify(page, spa)` — assert the destination page is healthy + interactive.
 *   - `page` — the expected destination structure (`'home'` | `'user'` | `'reader'`).
 *   - `label` — short human-readable identifier for error messages.
 *
 * Path covers: home→user, user→reader, reader→home, home→reader,
 * reader→user, user→reader, reader→home (full cycle).
 */
export const TOUR_STEPS = [
  { label: 'home (start)',        go: async (p) => { await p.goto('/'); }, verify: verifyHomePage,   page: 'home'   },
  { label: 'home → user',         go: navigateToUserPage,                  verify: verifyUserPage,   page: 'user'   },
  { label: 'user → reader',       go: clickFirstBookLink,                  verify: verifyReaderPage, page: 'reader' },
  { label: 'reader → home',       go: navigateToHome,                      verify: verifyHomePage,   page: 'home'   },
  { label: 'home → reader',       go: clickFirstBookLink,                  verify: verifyReaderPage, page: 'reader' },
  { label: 'reader → user',       go: navigateToUserPage,                  verify: verifyUserPage,   page: 'user'   },
  { label: 'user → reader (2)',   go: clickFirstBookLink,                  verify: verifyReaderPage, page: 'reader' },
  { label: 'reader → home (end)', go: navigateToHome,                      verify: verifyHomePage,   page: 'home'   },
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
