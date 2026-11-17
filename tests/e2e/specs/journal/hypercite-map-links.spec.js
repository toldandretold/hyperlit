/**
 * Hypercite-network map (the hero's inline SVG, JournalHyperciteMap) — its dots
 * are `<a>` elements inside an `<svg>`, and they must open the right book in
 * EVERY lifecycle state of a hero page, not just on a fresh load.
 *
 * The bug this pins (2026-11-16): once a feed lazy loader exists on the page
 * (feed opened, back/forward into the hero, bfcache return), its document-level
 * click handler routed every anchor via `new URL(link.href)`. An SVG anchor's
 * `href` is an SVGAnimatedString OBJECT, so the dot was preventDefault-ed and
 * SPA-routed to a book called "[object SVGAnimatedString]". A fresh hero has no
 * loader, so the first click worked and the bug read as "comes and goes after
 * coming back to the tab". Unit coverage: tests/javascript/utilities/anchorHref,
 * SPA/navigation/svgAnchorLinkRouting, lazyLoader/svgAnchorClick.
 *
 * Legs: fresh hero (native nav) → back → feed open, dot click while the loader
 * is ALIVE (SPA, sentinel survives) → back → feed closed (loader released) →
 * dot click again. Resolves a live archive from /a; falls back to the GSCJ
 * journal; skips when neither renders a map. Treat skips as gaps (CLAUDE.md).
 *
 * The home-page variant of the same lifecycle (feed open → ✕ → dot) is a step
 * of the SPA grand tour (helpers/spaTour.js enterReaderViaMapDot), so it runs
 * on every lap and replay; this spec is the deep pin for /j and /a heroes.
 *
 * Manual: `npm run test:e2e tests/e2e/specs/journal/hypercite-map-links.spec.js`.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

const DOT = 'a[data-map-node]';

async function awaitStructureSettled(page, spa, structure) {
  await page.waitForFunction((s) => document.body.getAttribute('data-page') === s, structure, { timeout: 30_000 });
  await expect
    .poll(async () => (await spa.getRegistryStatus(page))?.currentPage, { timeout: 30_000 })
    .toBe(structure);
}

/** The first dot's book path (href without any hash). */
async function firstDotPath(page) {
  return page.evaluate((sel) => {
    const a = document.querySelector(sel);
    const href = a?.getAttribute('href') ?? '';
    return href.split('#')[0];
  }, DOT);
}

/**
 * A REAL mouse click on the first dot: scroll it into view, move the pointer
 * onto it (the map shows its hover card), click. Playwright's locator click
 * with `force` aimed at the 4px SVG anchor did not reliably register; the raw
 * mouse gesture does, and it is the gesture a user makes.
 */
async function mouseClickFirstDot(page) {
  const dot = page.locator(DOT).first();
  await dot.scrollIntoViewIfNeeded();
  const box = await dot.boundingBox();
  expect(box, 'first map dot must have a box').not.toBeNull();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  await page.mouse.click(x, y);
}

/** Dispatch a desktop click on the first dot the way the browser would (bubbles, cancelable). */
async function clickFirstDotViaDom(page) {
  return page.evaluate((sel) => {
    const a = document.querySelector(sel);
    const circle = a.querySelector('circle') || a;
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    circle.dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented, href: a.getAttribute('href') };
  }, DOT);
}

async function expectLandedOnDot(page, spa, dotPath) {
  await expect(page.locator('.reader-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'reader');
  await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 15_000 }).toBe(dotPath);
  expect(page.url()).not.toContain('SVGAnimatedString');
}

async function resolveHeroWithMap(page) {
  await page.goto('/a');
  const archives = page.locator('.jp-works a.jp-title');
  const n = await archives.count();
  for (let i = 0; i < Math.min(n, 5); i++) {
    const path = await archives.nth(i).getAttribute('href');
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    if (await page.locator(DOT).count()) return path;
    await page.goto('/a');
  }
  const journal = '/j/global-social-challenges-journal';
  const r = await page.goto(journal);
  if (r.status() !== 404) {
    await page.waitForLoadState('networkidle');
    if (await page.locator(DOT).count()) return journal;
  }
  return null;
}

test('map dots open the right book: fresh hero, with a live feed loader, and after the feed closed', async ({ page, spa }) => {
  test.setTimeout(180_000);

  const heroPath = await resolveHeroWithMap(page);
  test.skip(!heroPath, 'no hero page with a hypercite map (needs an archive/journal whose documents are hypercited together)');

  expect(await spa.getStructure(page)).toBe('journal');
  const dotPath = await firstDotPath(page);
  expect(dotPath).toMatch(/^\/[^/]+/);

  // ── Leg 1: fresh hero, no feed loader → the browser navigates natively ──
  await mouseClickFirstDot(page);
  await expectLandedOnDot(page, spa, dotPath);

  // ── Leg 2: back into the hero, open a feed (mints the lazy loader), click a dot
  //    while the loader is ALIVE — this is the state that used to route to
  //    "[object SVGAnimatedString]". The SPA sentinel proves an in-page transition. ──
  await page.goBack();
  await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'journal');
  await page.click('.arranger-button[data-sort="published"]');
  await expect(page.locator('.libraryCard').first()).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => { window.__mapSentinel = 'live'; });
  const live = await clickFirstDotViaDom(page);
  expect(live.defaultPrevented).toBe(true); // the SPA took it…
  await expectLandedOnDot(page, spa, dotPath); // …to the REAL book
  expect(await page.evaluate(() => window.__mapSentinel === 'live')).toBe(true);
  expect(decodeURIComponent(page.url())).toContain(live.href.split('#')[0]);

  // ── Leg 3: back again (bfcache or popstate), close the feed → the loader is
  //    released and the dot is a plain link once more; it must still land. ──
  await page.goBack();
  await expect(page.locator('.journal-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'journal');
  if (await page.locator('#copy-feed-close').count()) {
    await page.click('#copy-feed-close');
    await expect(page.locator('#app-container.content-active')).toHaveCount(0);
    // closeFeed then GLIDES the hero back to centre (.hero-return, 700ms); a
    // click aimed mid-glide lands beside the dot. Wait the glide out.
    await expect(page.locator('#app-container.hero-return')).toHaveCount(0, { timeout: 5_000 });
  }
  await mouseClickFirstDot(page);
  await expectLandedOnDot(page, spa, dotPath);

  // Gates: no page errors, nothing in the console about the stringified href.
  expect(page.pageErrors).toEqual([]);
  expect(page.consoleErrors.filter((m) => String(m).includes('SVGAnimatedString'))).toEqual([]);
});
