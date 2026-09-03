/**
 * AI Archivist on the homepage — SPA navigation / history contract.
 *
 * Walks the exact user journey that kept regressing:
 *   ask → answer renders as a real book → click its hypercite ↗ → container →
 *   "See in source text" → source book → BACK (answer must restore) →
 *   × close (dismissal) → exit AI mode → open Most Recent → click a book →
 *   BACK (the DISMISSED answer must NOT resurrect).
 *
 * POST /api/ai-brain/ask is route-mocked with a fabricated SSE stream whose
 * result points at a REAL seeded answer book — everything downstream (book
 * render, hypercite container, source navigation, back-restore) is live.
 * Fixture: `php artisan e2e:seed-archivist-answer` (run in beforeAll).
 *
 * Every waypoint attaches a full nav-state dump (history.state, dismissal
 * tombstone, URL, feed-slot occupant, search mode) — when an assertion fails,
 * the dumps show exactly which history entry carried what.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test, expect } from '../../fixtures/navigation.fixture.js';

const APP_ROOT = resolve(import.meta.dirname, '../../../..');

const ANSWER_BOOK = 'book_e2e_archivist_answer';
const SOURCE_BOOK = 'book_e2e_archivist_source';
const HYPERCITE = 'hypercite_e2earchv1';
const QUESTION = 'What does the e2e fixture archive say about delinking?';

// public/sw.js proxies non-/api GETs through its own fetch — the reader-page
// loads this spec triggers are a known stall source under the dev server.
test.use({ serviceWorkers: 'block' });

let seeded = false;
test.beforeAll(() => {
  try {
    execSync('php artisan e2e:seed-archivist-answer', { cwd: APP_ROOT, stdio: 'pipe' });
    seeded = true;
  } catch (err) {
    console.warn('e2e:seed-archivist-answer failed — skipping suite:', String(err.stderr || err));
  }
});

/** Fabricated SSE response for the ask endpoint — bookId is the REAL fixture. */
async function mockAsk(page, hits = { count: 0 }) {
  await page.route('**/api/ai-brain/ask', (route) => {
    hits.count += 1;
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body:
        'event: status\ndata: {"message":"Considering your question..."}\n\n'
        + 'event: status\ndata: {"message":"Searching library for relevant sources..."}\n\n'
        + `event: result\ndata: ${JSON.stringify({
          success: true,
          bookId: ANSWER_BOOK,
          nodes: [],
          shelf: { id: null, name: 'AI Archivist' },
        })}\n\n`,
    });
  });
}

/** The observability payload — attach + log the complete nav state. */
async function dumpNavState(page, testInfo, label) {
  const state = await page.evaluate(() => {
    const occupant = document.querySelector('.main-content');
    return {
      href: window.location.href,
      dataPage: document.body.getAttribute('data-page'),
      historyState: history.state,
      historyLength: history.length,
      tombstone: sessionStorage.getItem('hyperlit:archivist:dismissed:home'),
      modeLS: localStorage.getItem('homepage_search_mode'),
      occupant: occupant ? { id: occupant.id, className: occupant.className } : null,
      activeTab: document.querySelector('.arranger-button.active')?.dataset?.content ?? null,
      archivistModeClass: !!document.querySelector('.arranger-buttons-container.archivist-mode'),
      contentActive: !!document.querySelector('#app-container.content-active'),
    };
  });
  console.log(`\n[navState:${label}]`, JSON.stringify(state, null, 2));
  await testInfo.attach(`navState-${label}`, {
    body: JSON.stringify(state, null, 2),
    contentType: 'application/json',
  });
  return state;
}

async function settleStructure(page, structure) {
  await page.waitForFunction((s) => document.body.getAttribute('data-page') === s, structure, { timeout: 30_000 });
  await page.waitForTimeout(500); // let registry init + restore hooks run
}

/**
 * Enter AI mode, retrying: the registry binds the brain button's listener
 * late (same late-binding auth.setup.js retry-clicks #userButton around),
 * and a persisted 'archivist' mode may mean we're ALREADY in — idempotent.
 */
async function enterAiMode(page) {
  await expect
    .poll(async () => {
      if (await page.locator('.arranger-buttons-container.archivist-mode').count()) return true;
      await page.click('#archivist-brain-button');
      await page.waitForTimeout(400);
      return (await page.locator('.arranger-buttons-container.archivist-mode').count()) > 0;
    }, { timeout: 20_000 })
    .toBe(true);
}

/** Exit AI mode (retrying, mirror of enterAiMode). */
async function exitAiMode(page) {
  await expect
    .poll(async () => {
      if (!(await page.locator('.arranger-buttons-container.archivist-mode').count())) return true;
      await page.click('#archivist-brain-button');
      await page.waitForTimeout(400);
      return (await page.locator('.arranger-buttons-container.archivist-mode').count()) === 0;
    }, { timeout: 20_000 })
    .toBe(true);
}

/** Brain on → prompt → Ask → real answer book mounted in the feed slot. */
async function askQuestion(page) {
  await enterAiMode(page);
  await expect(page.locator('#archivist-ask-button')).toBeVisible();
  await page.fill('#homepage-search-input', QUESTION);
  await page.click('#archivist-ask-button');
  // The checklist panel appears, then is REPLACED by the real book render
  await page.waitForSelector(`.main-content.archivist-panel[id="${ANSWER_BOOK}"]`, { timeout: 30_000 });
  await page.waitForSelector('.archivist-action-row .archivist-view-btn', { timeout: 15_000 });
}

test.describe('AI Archivist homepage SPA nav', () => {
  test.beforeEach(() => {
    test.skip(!seeded, 'e2e:seed-archivist-answer failed — is the dev DB migrated?');
  });

  test('full journey: ask → hypercite → back restores → dismiss → feed → book → back stays dismissed', async ({ page, spa }, testInfo) => {
    test.setTimeout(180_000);
    const consoleSnapshot = spa.filterConsoleErrors(page.consoleErrors).length;
    await mockAsk(page);

    // 1. hero boot
    await page.goto('/');
    await expect(page.locator('#app-container.lava-lamp-background')).toBeVisible();
    expect(await page.locator('.home-content-wrapper .main-content').count()).toBe(0);
    await dumpNavState(page, testInfo, '1-hero-boot');

    // 2. ask → answer mounts as the real book
    await askQuestion(page);
    const s2 = await dumpNavState(page, testInfo, '2-answer-mounted');
    expect(s2.historyState?.archivistAnswer?.bookId).toBe(ANSWER_BOOK);
    expect(s2.archivistModeClass).toBe(true);

    // 3. hypercite ↗ → container → See in source → source book
    const arrow = page.locator(`.main-content a.open-icon[id^="hypercite_"]:not([data-cite-group])`).first();
    await expect(arrow).toBeVisible({ timeout: 15_000 });
    await arrow.click();
    await page.waitForSelector('#hyperlit-container a.see-in-source-btn', { timeout: 15_000 });
    await dumpNavState(page, testInfo, '3-container-open');
    await page.locator('#hyperlit-container a.see-in-source-btn').first().click();
    await settleStructure(page, 'reader');
    expect(new URL(page.url()).pathname).toBe(`/${SOURCE_BOOK}`);
    await dumpNavState(page, testInfo, '3b-source-book');

    // 4. BACK → home with the answer restored
    await page.goBack();
    await settleStructure(page, 'home');
    const s4 = await dumpNavState(page, testInfo, '4-back-to-home');
    await expect(page.locator(`.main-content.archivist-panel[id="${ANSWER_BOOK}"]`)).toBeVisible({ timeout: 20_000 });
    expect(s4.tombstone).toBeNull();

    // 5. × dismisses the answer — tombstone written, entry state stripped
    await page.click('#copy-feed-close');
    await page.waitForTimeout(300);
    const s5 = await dumpNavState(page, testInfo, '5-after-close');
    expect(await page.locator('.main-content.archivist-panel').count()).toBe(0);
    expect(s5.tombstone).toBe(ANSWER_BOOK);
    expect(s5.historyState?.archivistAnswer ?? null).toBeNull();

    // 6. brain off — back to regular search header. Clear the leftover prompt:
    // mode exit re-runs it as a LIBRARY search and the results dropdown would
    // overlay the feed buttons (pointer-interception).
    await exitAiMode(page);
    await page.fill('#homepage-search-input', '');
    await page.locator('#homepage-search-input').press('Escape');
    await dumpNavState(page, testInfo, '6-ai-mode-off');

    // 7. open Most Recent → click the top book
    await spa.openHomeFeed(page);
    await expect(page.locator('.libraryCard a').first()).toBeVisible({ timeout: 15_000 });
    await dumpNavState(page, testInfo, '7-feed-open');
    await spa.clickFirstBookLink(page);
    await settleStructure(page, 'reader');
    await dumpNavState(page, testInfo, '7b-book-open');

    // 8. BACK → the dismissed answer must NOT resurrect
    await page.goBack();
    await settleStructure(page, 'home');
    const s8 = await dumpNavState(page, testInfo, '8-back-after-dismissal');
    expect(
      await page.locator('.main-content.archivist-panel').count(),
      `dismissed answer resurrected — nav state: ${JSON.stringify(s8)}`,
    ).toBe(0);
    // Ideal (not yet implemented): this back should restore the most-recent
    // feed. Current contract only guarantees "not the archivist".
    testInfo.annotations.push({
      type: 'todo',
      description: `back-after-dismissal should restore the feed tab; currently shows: ${s8.occupant ? s8.occupant.id : 'hero'}`,
    });

    // 9. no new console errors across the whole journey
    const newErrors = spa.filterConsoleErrors(page.consoleErrors).slice(consoleSnapshot);
    expect(newErrors, `New console errors:\n${newErrors.join('\n---\n')}`).toHaveLength(0);
  });

  test('guest: Ask opens the login flow, never the panel or the endpoint', async ({ browser }, testInfo) => {
    test.setTimeout(60_000);
    // storageState MUST be explicitly emptied: the fixture-wrapped
    // browser.newContext() inherits the project's authenticated state.
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    const hits = { count: 0 };
    await mockAsk(page, hits);

    await page.goto('/');
    await enterAiMode(page);
    await page.fill('#homepage-search-input', QUESTION);
    await page.click('#archivist-ask-button');

    // The user-container login form opens (or the in-panel auth prompt)
    await expect(
      page.locator('input[name="email"], .archivist-auth-message .import-auth-login').first(),
    ).toBeVisible({ timeout: 15_000 });
    expect(hits.count, 'ask endpoint must not be hit by a guest').toBe(0);
    expect(await page.locator(`.main-content[id="${ANSWER_BOOK}"]`).count()).toBe(0);

    await context.close();
  });

  test('brain toggle hides/reshows the answer; × clears it for good', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await mockAsk(page);

    await page.goto('/');
    await askQuestion(page);
    // × reads "Clear answer" while the answer is up
    await expect(page.locator('#copy-feed-close')).toHaveAttribute('aria-label', 'Clear answer');
    await dumpNavState(page, testInfo, 'toggle-1-answer-up');

    // brain OFF → answer HIDDEN (header and feed slot agree), NOT cleared
    await exitAiMode(page);
    await expect(page.locator('.main-content.archivist-panel')).toHaveCount(0);
    const sOff = await dumpNavState(page, testInfo, 'toggle-2-brain-off');
    expect(sOff.tombstone).toBeNull();
    expect(sOff.historyState?.archivistAnswer?.bookId).toBe(ANSWER_BOOK);

    // brain ON → answer RESHOWS
    await enterAiMode(page);
    await expect(page.locator(`.main-content.archivist-panel[id="${ANSWER_BOOK}"]`)).toBeVisible({ timeout: 20_000 });
    await dumpNavState(page, testInfo, 'toggle-3-brain-on-reshown');

    // × → cleared for good: still in AI mode, but brain-off/on won't revive it
    await page.click('#copy-feed-close');
    await page.waitForTimeout(300);
    const sClear = await dumpNavState(page, testInfo, 'toggle-4-cleared');
    expect(sClear.tombstone).toBe(ANSWER_BOOK);
    expect(sClear.archivistModeClass).toBe(true); // × does not exit AI mode
    await expect(page.locator('#copy-feed-close')).toHaveAttribute('aria-label', 'Close feed');

    await exitAiMode(page);
    await enterAiMode(page);
    await page.waitForTimeout(800);
    expect(await page.locator('.main-content.archivist-panel').count()).toBe(0);
    await dumpNavState(page, testInfo, 'toggle-5-stays-cleared');
  });

  test('back after "View full hypertext" restores the answer', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await mockAsk(page);

    await page.goto('/');
    await askQuestion(page);

    await page.click('.archivist-view-btn');
    await settleStructure(page, 'reader');
    expect(new URL(page.url()).pathname).toBe(`/${ANSWER_BOOK}`);
    await dumpNavState(page, testInfo, 'view-full-reader');

    await page.goBack();
    await settleStructure(page, 'home');
    await dumpNavState(page, testInfo, 'view-full-back');
    await expect(page.locator(`.main-content.archivist-panel[id="${ANSWER_BOOK}"]`)).toBeVisible({ timeout: 20_000 });
  });
});
