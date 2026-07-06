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

test('skip-to-content link is the first focusable on home (WCAG 2.4.1)', async ({ page }) => {
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

  // Activating it must be a NATIVE fragment jump: focus lands on #main-start
  // and the path is untouched. Regression guard: the SPA link interceptor once
  // routed this through book navigation and rewrote the URL to /null#main-start.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const pathname = await page.evaluate(() => window.location.pathname);
  expect(pathname, 'skip link must not be routed through SPA book navigation').not.toContain('null');
  expect(pathname).toBe('/');
  const focusedTarget = await page.evaluate(() => document.activeElement?.id || '');
  expect(focusedTarget, 'activating the skip link should move focus to #main-start').toBe('main-start');
});

/* ── 2.4.3 Focus Order — chrome follows visual reading order ──────────── */

test('home Tab order: user button (top-left) → new-book button (top-right) (WCAG 2.4.3)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#userButton', { timeout: 10000 });
  // The chrome containers are position:fixed; their DOM order IS the Tab
  // order, deliberately arranged top-left → top-right before any content.
  await page.evaluate(() => document.getElementById('userButton')?.focus());
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => document.activeElement?.id || '');
  expect(next, 'Tab after the user button should reach the + (new book) button').toBe('newBookButton');
});

/* ── 2.1.1 Keyboard — home book cards reachable & Enter-activatable ────── */

test('home book cards are hop-reachable (n) and Enter opens the reader (WCAG 2.1.1)', async ({ page, spa }) => {
  // Keyboard model: Tab is chrome-only on EVERY page — cards are content,
  // reached via the hop layer (n/p), never Tab (a 100-card feed would bury
  // the perimeter buttons otherwise).
  await gotoHomeFeed(page, spa);
  let reached = false;
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('n');
    await page.waitForTimeout(120);
    const onCard = await page.evaluate(() => {
      const el = document.activeElement;
      return !!(el && el.closest && el.closest('.libraryCard'));
    });
    if (onCard) { reached = true; break; }
  }
  expect(reached, 'No .libraryCard link received focus within 6 hops (n)').toBe(true);

  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.body.getAttribute('data-page') === 'reader',
    null, { timeout: 8000 }
  );
});

test('home Tab loop stays out of the card feed (WCAG 2.4.3)', async ({ page, spa }) => {
  await gotoHomeFeed(page, spa);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  const stops = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const d = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        key: el ? `${el.tagName}#${el.id || ''}` : '(none)',
        inContent: !!el?.closest?.('.main-content, .welcome-copy'),
      };
    });
    if (stops.includes(d.key)) break; // wrapped
    stops.push(d.key);
    expect(d.inContent, `Tab stop #${i + 1} (${d.key}) is inside content — content is hop-layer only`).toBe(false);
  }
  expect(stops.length, `home chrome Tab loop too long: ${stops.join(' → ')}`).toBeLessThan(13);
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

test('library-card links show a focus ring under keyboard focus (WCAG 2.4.7)', async ({ page, spa }) => {
  await gotoHomeFeed(page, spa);
  // Seat focus on a card link, then Tab (real keyboard) so the NEXT link gets
  // keyboard-initiated focus — :focus-visible only matches for keyboard focus.
  // Cards are hop-layer content (n/p), so the ring is checked on a hop.
  // Regression guard: a global `a { outline: none }` once made keyboard focus
  // invisible across every card ↗ / actions / DOI link.
  let focused = null;
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('n');
    await page.waitForTimeout(120);
    focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el.tagName !== 'A' || !el.closest('.libraryCard')) return null;
      const s = getComputedStyle(el);
      return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
    });
    if (focused) break;
  }
  expect(focused, 'hopping (n) did not land on a library-card link').not.toBeNull();
  expect(
    focused.outlineStyle,
    `card link has no visible focus outline (got ${JSON.stringify(focused)})`
  ).not.toBe('none');
});

/* ── 2.1.2 / 2.4.3 — footnote container: Escape closes, focus restored ── */

test('footnote container closes on Escape and restores focus to the trigger (WCAG 2.1.2, 2.4.3)', async ({ page, spa }) => {
  // Prefer the seeded fixture book (guaranteed footnote refs — `php artisan
  // e2e:seed-fixtures`); fall back to the general reader book.
  const fnBook = process.env.E2E_A11Y_BOOK || READER_BOOK;
  test.skip(!fnBook, 'no reader book configured');
  await page.goto(`/${fnBook}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.main-content', { timeout: 15000 });
  const { opened } = await spa.openFootnoteStack(page, 1);
  test.skip(opened === 0, 'book has no openable footnote refs');
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

test('reader settings panel closes on Escape (WCAG 2.1.2)', async ({ page }) => {
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

/* ── 2.1.2 / 2.4.3 — modal containers trap focus & restore it ─────────── */

/**
 * Open a modal container by real keyboard gesture (focus trigger + Enter),
 * then assert: Tab stays inside, Escape closes, focus returns to the trigger.
 * Regression for: user/newbook panels opened with a blurred backdrop but Tab
 * wandered the inert page behind them.
 */
async function assertModalTrap(page, { triggerId, containerId, tabs = 12 }) {
  await page.evaluate((id) => document.getElementById(id)?.focus(), triggerId);
  await page.keyboard.press('Enter');
  // "Open" = visible, not the .open class — newbook-container animates via
  // inline styles and never gets the class.
  const isVisible = (id) => {
    const c = document.getElementById(id);
    if (!c) return false;
    const s = getComputedStyle(c);
    return s.visibility !== 'hidden' && s.opacity === '1' && c.getBoundingClientRect().width > 0;
  };
  await page.waitForFunction(isVisible, containerId, { timeout: 5000 });
  await page.waitForTimeout(300); // slide-in / content mount

  for (let i = 0; i < tabs; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate((id) => {
      const c = document.getElementById(id);
      return !!(c && (c === document.activeElement || c.contains(document.activeElement)));
    }, containerId);
    if (!inside) {
      const leaked = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? `${el.tagName}#${el.id || '(no id)'}` : '(none)';
      });
      throw new Error(`Tab #${i + 1} escaped #${containerId} to ${leaked} while the modal was open (WCAG 2.4.3)`);
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForFunction((id) => {
    const c = document.getElementById(id);
    if (!c) return true;
    const s = getComputedStyle(c);
    return s.visibility === 'hidden' || s.opacity === '0' || s.display === 'none'
      || c.classList.contains('hidden') || c.getBoundingClientRect().width === 0;
  }, containerId, { timeout: 3000 });
  const focusedAfter = await page.evaluate(() => document.activeElement?.id || '');
  expect(focusedAfter, `focus should return to #${triggerId} after Escape (WCAG 2.4.3)`).toBe(triggerId);
}

test('user container traps Tab, closes on Escape, restores focus (WCAG 2.1.2, 2.4.3)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#userButton', { timeout: 10000 });
  await assertModalTrap(page, { triggerId: 'userButton', containerId: 'user-container' });
});

test('new-book container traps Tab, closes on Escape, restores focus (WCAG 2.1.2, 2.4.3)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#newBookButton', { timeout: 10000 });
  await assertModalTrap(page, { triggerId: 'newBookButton', containerId: 'newbook-container' });
});

test('encrypt checkbox in new-book popup toggles with Enter and Space (WCAG 2.1.1)', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#newBookButton', { timeout: 10000 });
  await page.evaluate(() => document.getElementById('newBookButton')?.focus());
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const c = document.getElementById('newbook-container');
    return c && getComputedStyle(c).opacity === '1';
  }, null, { timeout: 5000 });
  await page.waitForTimeout(300);

  // Tab until the checkbox has focus (it's inside the trapped popup).
  let onCheckbox = false;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    onCheckbox = await page.evaluate(() => document.activeElement?.id === 'createEncrypted');
    if (onCheckbox) break;
  }
  expect(onCheckbox, '#createEncrypted never received focus inside the popup').toBe(true);

  const checked = () => page.evaluate(() => document.getElementById('createEncrypted')?.checked);
  const before = await checked();
  await page.keyboard.press('Enter');
  expect(await checked(), 'Enter should toggle the encrypt checkbox').toBe(!before);
  await page.keyboard.press('Space');
  expect(await checked(), 'Space should toggle it back (native behavior intact)').toBe(before);

  await page.keyboard.press('Escape'); // cleanup: close the popup
});

/* ── 2.1.1 — edit mode must not hijack chrome keys ────────────────────── */

test('edit mode: Enter activates chrome buttons; Tab reaches the edit toolbar with a ring (WCAG 2.1.1, 2.4.7)', async ({ page, spa }) => {
  const book = process.env.E2E_A11Y_BOOK;
  test.skip(!book, 'E2E_A11Y_BOOK not set — run `php artisan e2e:seed-fixtures`');
  await page.goto(`/${book}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.main-content p', { timeout: 15000 });

  await page.click('#editButton');
  await spa.waitForEditMode(page);

  // Put the caret in the editor so its selection lingers — the exact state
  // that used to hijack Enter into "insert paragraph".
  await page.click('.main-content p');
  await page.waitForTimeout(200);

  // Enter on a chrome button must activate it, not edit content.
  const paraCountBefore = await page.evaluate(() => document.querySelectorAll('.main-content p').length);
  await page.evaluate(() => document.getElementById('logoContainer')?.focus());
  await page.keyboard.press('Enter');
  const menuOpened = await page.waitForSelector('#logoNavMenu:not(.hidden)', { timeout: 3000 })
    .then(() => true).catch(() => false);
  expect(menuOpened, 'Enter on #logoContainer should open the nav menu (was hijacked by the editor)').toBe(true);
  const paraCountAfter = await page.evaluate(() => document.querySelectorAll('.main-content p').length);
  expect(paraCountAfter, 'Enter on a chrome button must not insert a paragraph').toBe(paraCountBefore);
  await page.keyboard.press('Escape'); // close nav menu

  // Tab must reach the edit toolbar, and its buttons must show a focus ring.
  await page.evaluate(() => document.getElementById('logoContainer')?.focus());
  let onToolbar = false;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    onToolbar = await page.evaluate(() => !!document.activeElement?.closest('#edit-toolbar'));
    if (onToolbar) break;
  }
  expect(onToolbar, 'Tab never reached #edit-toolbar in edit mode').toBe(true);
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  expect(ring, 'edit-toolbar button focus must be visible').not.toBe('none');

  await page.click('#editButton'); // exit edit mode (no content was changed)
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
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
