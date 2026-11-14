/**
 * Hero pages: browser BACK from a book returns to the FEED you left, where you
 * left it — not to the hero.
 *
 * The reported journey (prod, /a/decolonising-security): open a feed tab,
 * scroll down the list, click a card into the reader, press Back → the page
 * came back as the centered hero card with no feed. Cause: homepageHero wiped
 * history.state.userPageActiveTab on EVERY init ("always boot to the hero"),
 * including the init a popstate return runs — so the entry's own memory of
 * its open feed was deleted just before homepageDisplayUnit went to read it.
 *
 * Contract pinned here, for the home page AND the journal structure
 * (/j/{slug}; /a/{slug} runs the same structure and component set):
 *   1. Back restores the SAME feed tab — a non-first tab on purpose: the
 *      journal's three buttons share one shelf id, so a restore keyed on the
 *      shelf alone always reopens "Most Recent".
 *   2. Back restores the scroll position — the card that was clicked is back
 *      where it was on screen (within a tolerance), not at the top of the list.
 *   3. It was an in-page (SPA) return, and Forward still reaches the book.
 *   4. A RELOAD still boots to the hero (the deliberate hero contract —
 *      smoke/home-lava-homepage.spec.js step 6).
 *   5. × pressed while a feed is still loading closes it without a console
 *      error and it stays closed.
 *
 * Skips (treat as gaps): the journal variant needs GSCJ in the local registry.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

const JOURNAL_PATH = '/j/global-social-challenges-journal';
// The docked hero card re-measures after its 0.6s glide, and the feed's first
// rows sit under a mask — "same place" is "same card on screen", not "same px".
const TOP_TOLERANCE_PX = 200;

async function awaitStructureSettled(page, spa, structure) {
  await page.waitForFunction((s) => document.body.getAttribute('data-page') === s, structure, { timeout: 30_000 });
  await expect
    .poll(async () => (await spa.getRegistryStatus(page))?.currentPage, { timeout: 30_000 })
    .toBe(structure);
}

/** The feed's scroll container (journal pages carry both wrapper classes). */
const WRAPPER = '.home-content-wrapper';

/**
 * Scroll the feed, pick the card nearest the middle of the viewport, and
 * return its id + on-screen top. Returns null when the feed is too short to
 * scroll (nothing to restore — the caller skips the scroll assertions).
 */
async function scrollAndPickCard(page) {
  await page.locator(WRAPPER).evaluate((el) => el.scrollBy({ top: 1400 }));
  // let lazy chunks land + the 250ms-throttled position save fire
  await page.waitForTimeout(1200);
  return page.evaluate((wrapperSel) => {
    const wrapper = document.querySelector(wrapperSel);
    if (!wrapper || wrapper.scrollTop < 200) return null;
    const mid = window.innerHeight / 2;
    let best = null;
    for (const card of document.querySelectorAll('.libraryCard')) {
      if (!card.querySelector('a[href^="/"]')) continue;
      const top = card.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight) continue;
      if (!best || Math.abs(top - mid) < Math.abs(best.top - mid)) {
        best = { id: card.id, nodeId: card.getAttribute('data-node-id'), top };
      }
    }
    return best ? { ...best, scrollTop: wrapper.scrollTop } : null;
  }, WRAPPER);
}

async function cardTop(page, nodeId) {
  return page.evaluate((id) => {
    const card = document.querySelector(`.libraryCard[data-node-id="${CSS.escape(id)}"]`);
    return card ? card.getBoundingClientRect().top : null;
  }, nodeId);
}

async function feedBackRestoreTour(page, spa, { heroPath, structure, tabSelector }) {
  await spa.assertRegistryHealthy(page, structure);

  // ── open a NON-FIRST feed tab and scroll into the list ──
  await page.click(tabSelector);
  await expect(page.locator('.libraryCard a[href^="/"]').first()).toBeVisible({ timeout: 15_000 });
  const feedBookId = await page.locator(`${WRAPPER} .main-content`).getAttribute('id');
  const picked = await scrollAndPickCard(page);

  // ── click the card into the reader (SPA) ──
  await page.evaluate(() => { window.__feedBackSentinel = 'live'; });
  const link = picked
    ? page.locator(`.libraryCard[data-node-id="${picked.nodeId}"] a[href^="/"]`).first()
    : page.locator('.libraryCard a[href^="/"]').first();
  await link.click();
  await expect(page.locator('.reader-content-wrapper')).toBeAttached({ timeout: 30_000 });
  await awaitStructureSettled(page, spa, 'reader');
  await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 10_000 }).not.toBe(heroPath);
  const readerPath = await page.evaluate(() => location.pathname);

  // ── BACK: the feed, the tab and the position come back ──
  await page.goBack();
  await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 30_000 }).toBe(heroPath);
  await awaitStructureSettled(page, spa, structure);
  expect(await page.evaluate(() => window.__feedBackSentinel === 'live'), 'back was a full reload, not SPA').toBe(true);

  await expect(page.locator('#app-container.content-active'), 'back landed on the hero instead of the feed').toBeAttached({ timeout: 20_000 });
  await expect(page.locator(`${tabSelector}.active`), 'the tab that was open is not the active one').toBeAttached({ timeout: 20_000 });
  await expect(page.locator(`${WRAPPER} .main-content`)).toHaveAttribute('id', feedBookId, { timeout: 20_000 });
  await expect(page.locator('.libraryCard').first()).toBeAttached({ timeout: 20_000 });

  if (picked) {
    await expect
      .poll(async () => {
        const top = await cardTop(page, picked.nodeId);
        return top === null ? Infinity : Math.abs(top - picked.top);
      }, {
        timeout: 20_000,
        message: `clicked card ${picked.nodeId} was at top=${picked.top.toFixed(0)} (scrollTop ${picked.scrollTop.toFixed(0)}) and did not come back there`,
      })
      .toBeLessThan(TOP_TOLERANCE_PX);
  } else {
    test.info().annotations.push({ type: 'gap', description: 'feed too short to scroll — scroll-position restore NOT exercised' });
  }
  await spa.assertRegistryHealthy(page, structure);

  // ── FORWARD still reaches the book (the restore pushed no history) ──
  await page.goForward();
  await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 30_000 }).toBe(readerPath);
  await awaitStructureSettled(page, spa, 'reader');

  // ── and BACK again restores again (the entry state survived the round trip) ──
  await page.goBack();
  await awaitStructureSettled(page, spa, structure);
  await expect(page.locator(`${tabSelector}.active`)).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('.libraryCard').first()).toBeAttached({ timeout: 20_000 });

  // ── a RELOAD still boots to the hero ──
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  expect(await page.locator(`${WRAPPER} .main-content`).count(), 'reload must boot to the hero').toBe(0);
  expect(await page.locator('#app-container.content-active').count()).toBe(0);
  expect(await page.locator('.arranger-button.active').count()).toBe(0);

  // ── × while a feed is still LOADING closes cleanly ──
  // A back/forward return starts the entry's feed loading on its own, so a
  // tab press followed straight away by × now happens for real. Removing the
  // container under an in-flight load used to log "Container element … not
  // found in the DOM"; the close must instead win quietly and stay closed.
  const errorsBefore = spa.filterConsoleErrors(page.consoleErrors).length;
  await page.click(tabSelector);
  await page.click('#copy-feed-close');
  await expect(page.locator('#app-container.content-active')).toHaveCount(0);
  await page.waitForTimeout(3000); // let the abandoned load settle
  expect(await page.locator(`${WRAPPER} .main-content`).count(), 'a feed closed mid-load came back').toBe(0);
  expect(await page.locator('#app-container.content-active').count()).toBe(0);
  const newErrors = spa.filterConsoleErrors(page.consoleErrors).slice(errorsBefore);
  expect(newErrors, `console errors closing a feed mid-load:\n${newErrors.join('\n---\n')}`).toHaveLength(0);
}

test.describe('hero pages: back from a book restores the feed tab + scroll position', () => {
  test.setTimeout(150_000);

  test('home: Most Connected → scroll → book → back', async ({ page, spa }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await feedBackRestoreTour(page, spa, {
      heroPath: '/',
      structure: 'home',
      tabSelector: '.arranger-button[data-content="most-connected"]',
    });
  });

  test('journal: Most Connected → scroll → article → back', async ({ page, spa }) => {
    const response = await page.goto(JOURNAL_PATH);
    test.skip(response.status() === 404, 'GSCJ not in this environment\'s registry — run: php artisan journal:sync-registry --issn=2752-3349');
    await page.waitForLoadState('networkidle');
    await feedBackRestoreTour(page, spa, {
      heroPath: JOURNAL_PATH,
      structure: 'journal',
      tabSelector: '.arranger-button[data-sort="connected"]',
    });
  });
});
