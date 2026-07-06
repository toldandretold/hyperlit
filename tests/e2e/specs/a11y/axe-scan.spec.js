/**
 * Accessibility (a11y) axe-core scan — WCAG 2.2 Level AA.
 *
 * One test per page-state. Each test drives the app into a known state using
 * the SAME helpers the grand tour uses (so states render identically), settles
 * the page on an explicit wait (never scans straight after a click), then runs
 * an axe scan and ratchets the result against tests/e2e/specs/a11y/a11yBaseline.json.
 *
 * Ratchet contract (mirrors tests/javascript/architecture/noNewConsole.test.js):
 *   - a NEW failing rule in a known state, or a node count ABOVE baseline → fail
 *   - a count BELOW baseline (or a rule now gone) → the test still passes but
 *     prints the suggested lower baseline so the gain can be locked in
 *   - a state with NO baseline entry at all → report-only (bootstrap): the test
 *     passes and prints the counts to seed a11yBaseline.json
 *
 * Reader states use the stable E2E_READER_BOOK book via a direct navigation
 * (a full render is the right target for a DOM a11y scan; SPA-transition
 * correctness is the grand tour's job). States whose preconditions are absent
 * (no reader book, book not editable, no TOC, no footnotes) `test.skip`
 * themselves — a skip is an honest coverage gap, not a pass.
 *
 * Run: `npm run test:a11y` (needs the dev server on :8000).
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { a11yScan, violationsToCounts, diffAgainstBaseline } from '../../helpers/a11y.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const READER_BOOK = process.env.E2E_READER_BOOK;

/** Load the baseline; missing/empty file → {} (first-run bootstrap). */
function loadBaseline() {
  try {
    const raw = JSON.parse(readFileSync(join(HERE, 'a11yBaseline.json'), 'utf8'));
    delete raw._comment;
    return raw;
  } catch {
    return {};
  }
}
const BASELINE = loadBaseline();

/* ── state setup helpers ──────────────────────────────────────────────── */

/**
 * Settle the page before an axe scan. The app's load/transition progress panel
 * (`.navigation-overlay`, incl. #initial-navigation-overlay) holds low-contrast
 * text and, while visible, is scanned by axe — a flaky source of color-contrast
 * findings. Wait for every overlay to be hidden and the network to be idle so
 * each scan sees the same fully-rendered state. Best-effort (never throws).
 */
async function settleForScan(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForFunction(() => {
    for (const el of document.querySelectorAll('.navigation-overlay')) {
      const s = getComputedStyle(el);
      if (s.display !== 'none' && s.visibility !== 'hidden') return false;
    }
    return true;
  }, null, { timeout: 8000 }).catch(() => {});
}

async function gotoReader(page) {
  test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in tests/e2e/.env.e2e');
  await page.goto(`/${READER_BOOK}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.main-content', { timeout: 15000 });
  // Settle: reader defers chunk render; wait for at least one real block.
  await page.waitForFunction(
    () => !!document.querySelector('.main-content p, .main-content h1, .main-content h2, .main-content li'),
    null, { timeout: 15000 }
  );
}

/**
 * Each state: { label, setup(page, spa) }. setup navigates + settles, or calls
 * test.skip when its precondition is missing.
 */
const STATES = [
  {
    label: 'home',
    async setup(page, spa) {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      // Homepage defers its feed — open Most Recent so cards actually render.
      await spa.openHomeFeed(page).catch(() => {});
      await page.waitForSelector('.libraryCard', { timeout: 15000 });
    },
  },
  {
    label: 'user',
    async setup(page, spa) {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spa.navigateToUserPage(page);
      await page.waitForFunction(
        () => document.body.getAttribute('data-page') === 'user',
        null, { timeout: 10000 }
      );
      await page.waitForLoadState('networkidle');
    },
  },
  {
    label: 'reader',
    async setup(page) {
      await gotoReader(page);
    },
  },
  {
    label: 'reader-edit-mode',
    async setup(page, spa) {
      await gotoReader(page);
      const editable = await page.evaluate(() => {
        const b = document.getElementById('editButton');
        if (!b) return false;
        if (b.getAttribute('data-is-locked') === 'true' || b.classList.contains('locked-state')) return false;
        return window.getComputedStyle(b).display !== 'none' && b.offsetParent !== null;
      });
      test.skip(!editable, 'E2E_READER_BOOK is not editable by the test user');
      await page.click('#editButton');
      await spa.waitForEditMode(page);
      await page.waitForTimeout(300); // let the edit toolbar settle in
    },
  },
  {
    label: 'reader-settings-open',
    async setup(page) {
      await gotoReader(page);
      const hasSettings = await page.locator('#settingsButton').count();
      test.skip(!hasSettings, 'no #settingsButton on this reader');
      await page.click('#settingsButton');
      await page.waitForSelector('#settings-container:not(.hidden)', { timeout: 5000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(300);
    },
  },
  {
    label: 'reader-toc-open',
    async setup(page, spa) {
      await gotoReader(page);
      const hasToc = await page.locator('#toc-toggle-button').count();
      test.skip(!hasToc, 'no TOC toggle on this reader');
      try {
        await spa.openToc(page);
      } catch (e) {
        test.skip(true, `TOC did not open (likely no TOC content): ${e.message}`);
      }
      await page.waitForTimeout(200);
    },
  },
  {
    label: 'reader-footnote-open',
    async setup(page, spa) {
      // Prefer the seeded fixture book (guaranteed footnote refs).
      const fnBook = process.env.E2E_A11Y_BOOK || READER_BOOK;
      test.skip(!fnBook, 'no reader book configured');
      await page.goto(`/${fnBook}`);
      await page.waitForLoadState('networkidle');
      await page.waitForSelector('.main-content', { timeout: 15000 });
      const { opened } = await spa.openFootnoteStack(page, 1);
      test.skip(opened === 0, 'book has no openable footnote refs');
      await page.waitForSelector('#hyperlit-container.open', { timeout: 5000 });
      // Anti-flake: wait for the sub-book CONTENT (not just the shell) — the
      // async enrichment re-render otherwise races the scan and the counts
      // wobble between the preview and enriched states.
      await page.waitForFunction(
        () => !!document.querySelector('#hyperlit-container .sub-book-content a[href], #hyperlit-container .sub-book-content p'),
        null, { timeout: 8000 }
      ).catch(() => {});
      await page.waitForTimeout(600); // enrichment re-render settle
    },
  },
];

/* ── the scan tests ───────────────────────────────────────────────────── */

test.describe('a11y axe scan (WCAG 2.2 AA)', () => {
  for (const { label, setup } of STATES) {
    test(`axe scan: ${label}`, async ({ page, spa }) => {
      await setup(page, spa);
      await settleForScan(page);

      let counts = violationsToCounts(await a11yScan(page, label));
      let { failures, improvements, known } = diffAgainstBaseline(counts, BASELINE[label]);

      // Anti-flake: axe on a mid-animation SPA page can wobble a node or two.
      // Re-drive the state once and re-scan before failing.
      if (failures.length) {
        await setup(page, spa);
        await settleForScan(page);
        counts = violationsToCounts(await a11yScan(page, `${label}-retry`));
        ({ failures, improvements, known } = diffAgainstBaseline(counts, BASELINE[label]));
      }

      if (!known) {
        // eslint-disable-next-line no-console
        console.warn(
          `[a11y] "${label}" has no baseline entry (report-only). Seed a11yBaseline.json:\n` +
          `  ${JSON.stringify({ [label]: counts })}`
        );
      } else if (improvements.length) {
        // eslint-disable-next-line no-console
        console.warn(
          `[a11y-ratchet] "${label}" improved — lower a11yBaseline.json["${label}"] to:\n` +
          `  ${JSON.stringify(counts)}\n  (${improvements.join('; ')})`
        );
      }

      expect(
        failures,
        `"${label}" a11y regressions:\n  ${failures.join('\n  ')}\n` +
        `Fix them, or — as a reviewed, diff-visible decision — raise ` +
        `tests/e2e/specs/a11y/a11yBaseline.json["${label}"].`
      ).toEqual([]);
    });
  }
});
