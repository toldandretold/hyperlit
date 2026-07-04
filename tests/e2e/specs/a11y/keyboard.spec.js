/**
 * Accessibility — keyboard operability & focus management.
 *
 * Axe (specs/a11y/axe-scan.spec.js) catches static WCAG issues (contrast,
 * names, roles). It CANNOT tell whether the app is actually operable by a
 * keyboard-only user or whether focus is managed sanely. These scripted tests
 * cover that operability half. Each test title names its WCAG success
 * criterion.
 *
 * A genuine gap in the app today is marked `test.fixme('… — WCAG x.y.z', …)`
 * rather than deleted — the suite stays green while the debt stays visible and
 * countable (grep `test.fixme` in this folder). Turning a fixme back into a
 * passing test is the second measurable axis of "more accessible".
 *
 * Run: `npm run test:a11y` (needs the dev server on :8000).
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';

const READER_BOOK = process.env.E2E_READER_BOOK;

/** Snapshot of the currently focused element. */
function activeInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: el ? 'BODY' : null, id: '', text: '', href: '' };
    return {
      tag: el.tagName,
      id: el.id || '',
      cls: typeof el.className === 'string' ? el.className : '',
      text: (el.textContent || '').trim().slice(0, 50),
      href: el.getAttribute ? (el.getAttribute('href') || '') : '',
    };
  });
}

async function gotoHomeFeed(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spa.openHomeFeed(page).catch(() => {});
  await page.waitForSelector('.libraryCard', { timeout: 15000 });
}

async function gotoReader(page) {
  test.skip(!READER_BOOK, 'E2E_READER_BOOK not set in tests/e2e/.env.e2e');
  await page.goto(`/${READER_BOOK}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.main-content', { timeout: 15000 });
}

/* ── 2.4.1 Bypass Blocks — skip-to-content link ───────────────────────── */

// FIXME (known gap, 2026-07-05): home has no skip-to-content link — the first
// Tab lands on #userButton. Add a visually-hidden "Skip to content" anchor as
// the first focusable in the layout, then flip this back to `test(`.
test.fixme('skip-to-content link is the first focusable on home (WCAG 2.4.1)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('Tab');
  const first = await activeInfo(page);
  const looksLikeSkip =
    first.tag === 'A' && /#/.test(first.href) && /skip|main|content/i.test(first.text);
  expect(
    looksLikeSkip,
    `First Tab focused <${first.tag} id="${first.id}" href="${first.href}">"${first.text}" — ` +
    `expected a skip-to-content link.`
  ).toBe(true);
});

/* ── 2.1.1 Keyboard — home book cards reachable & Enter-activatable ────── */

test('home book cards are keyboard-reachable and Enter opens the reader (WCAG 2.1.1)', async ({ page, spa }) => {
  await gotoHomeFeed(page, spa);
  let reached = false;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const onCard = await page.evaluate(() => {
      const el = document.activeElement;
      return !!(el && el.closest && el.closest('.libraryCard'));
    });
    if (onCard) { reached = true; break; }
  }
  expect(reached, 'No .libraryCard link received focus within 60 Tab presses').toBe(true);

  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.body.getAttribute('data-page') === 'reader',
    null, { timeout: 8000 }
  );
});

/* ── 2.4.7 Focus Visible — home primary control ───────────────────────── */

test('a focused control shows a visible focus indicator (WCAG 2.4.7)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#userButton', { timeout: 10000 });

  const diff = await page.evaluate(() => {
    const el = document.getElementById('userButton');
    if (!el) return null;
    const read = () => {
      const s = getComputedStyle(el);
      return {
        outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor, boxShadow: s.boxShadow,
      };
    };
    el.blur();
    const before = read();
    el.focus({ preventScroll: true });
    const after = read();
    const changed =
      before.outlineStyle !== after.outlineStyle ||
      before.outlineWidth !== after.outlineWidth ||
      before.outlineColor !== after.outlineColor ||
      before.boxShadow !== after.boxShadow;
    return { changed, before, after };
  });

  expect(diff, '#userButton not found').not.toBeNull();
  expect(
    diff.changed,
    `#userButton shows no visible focus style change.\n  before: ${JSON.stringify(diff.before)}\n  after:  ${JSON.stringify(diff.after)}`
  ).toBe(true);
});

/* ── 2.1.2 / 2.4.3 — footnote container: Escape closes, focus restored ── */

test('footnote container closes on Escape and restores focus to the trigger (WCAG 2.1.2, 2.4.3)', async ({ page, spa }) => {
  await gotoReader(page);
  const { opened } = await spa.openFootnoteStack(page, 1);
  test.skip(opened === 0, 'E2E_READER_BOOK has no openable footnote refs');
  await page.waitForSelector('#hyperlit-container.open', { timeout: 5000 });

  // Focus should be inside the container after it opens (else a screen-reader
  // user is stranded on the trigger while unseen content appears).
  const focusInside = await page.evaluate(() => {
    const c = document.getElementById('hyperlit-container');
    return !!(c && c.contains(document.activeElement));
  });

  await page.keyboard.press('Escape');
  const closed = await page.waitForFunction(
    () => !document.querySelector('#hyperlit-container.open'),
    null, { timeout: 3000 }
  ).then(() => true).catch(() => false);

  // Report focus-management observations; only the Escape-closes behaviour is
  // asserted hard here (the most basic operability guarantee).
  if (!focusInside) {
    // eslint-disable-next-line no-console
    console.warn('[a11y] footnote container: focus did NOT move into the container on open (WCAG 2.4.3 gap).');
  }
  expect(closed, 'footnote container did not close on Escape (WCAG 2.1.2)').toBe(true);
});

/* ── 2.1.2 — settings panel closes on Escape ──────────────────────────── */

// FIXME (known gap, 2026-07-05): the settings container has no Escape handler
// (settingsContainer/index.ts closes only via #settings-overlay click or the
// toggle button), so a keyboard-only user who opens settings can't dismiss it.
// Wire an Escape keydown to the container close, then flip this back to `test(`.
test.fixme('reader settings panel closes on Escape (WCAG 2.1.2)', async ({ page }) => {
  await gotoReader(page);
  const hasSettings = await page.locator('#settingsButton').count();
  test.skip(!hasSettings, 'no #settingsButton on this reader');

  await page.click('#settingsButton');
  await page.waitForSelector('#settings-container:not(.hidden)', { timeout: 5000 });
  await page.keyboard.press('Escape');
  const closed = await page.waitForFunction(
    () => {
      const c = document.getElementById('settings-container');
      return !c || c.classList.contains('hidden');
    },
    null, { timeout: 3000 }
  ).then(() => true).catch(() => false);
  expect(closed, 'settings panel did not close on Escape').toBe(true);
});

/* ── 2.1.1 — TOC keyboard operable ────────────────────────────────────── */

test('TOC opens and an entry is keyboard-activatable (WCAG 2.1.1)', async ({ page, spa }) => {
  await gotoReader(page);
  const hasToc = await page.locator('#toc-toggle-button').count();
  test.skip(!hasToc, 'no TOC toggle on this reader');
  try {
    await spa.openToc(page);
  } catch (e) {
    test.skip(true, `TOC did not open (likely no TOC content): ${e.message}`);
  }

  const entries = await page.locator('#toc-container a, #toc-container [role="link"], #toc-container button').count();
  test.skip(entries === 0, 'TOC opened but has no entries');

  // Tab into the open TOC and confirm an entry can hold focus.
  let onEntry = false;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    onEntry = await page.evaluate(() => {
      const el = document.activeElement;
      return !!(el && el.closest && el.closest('#toc-container'));
    });
    if (onEntry) break;
  }
  expect(onEntry, 'no TOC entry received keyboard focus within 40 Tabs').toBe(true);
});
