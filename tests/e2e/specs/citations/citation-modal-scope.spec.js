/**
 * Citation modal — scope-chip UI contract.
 *
 * Tests the scope selector (PR2): chip presence, default state, click toggles
 * the active button, localStorage persistence across modal reopens, shelf
 * picker visibility, scope-aware fetch URL.
 *
 * Stays at the DOM level (no actual citation insertion) so it's fast and
 * stable regardless of what the test book's library contains.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  findCitableParagraph,
  openCitationModal,
  setCitationScope,
} from '../../helpers/citationModal.js';

const READER_BOOK = process.env.E2E_READER_BOOK || 'book_1777271888985';

test.describe('Citation modal — scope chips', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/${READER_BOOK}`);
    await page.evaluate(() => {
      try {
        localStorage.removeItem('hyperlit:citation:scope');
        localStorage.removeItem('hyperlit:citation:shelfId');
      } catch {}
    });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('.main-content', { timeout: 20_000 });

    const sel = await findCitableParagraph(page, 40);
    if (!sel) test.skip(true, 'no citable paragraph in test book');
    await openCitationModal(page, sel, 10);
  });

  test('all three scope chips render with public as default', async ({ page }) => {
    const buttons = await page.locator('.citation-scope-btn').evaluateAll(
      els => els.map(el => ({ scope: el.dataset.scope, active: el.classList.contains('active') }))
    );

    expect(buttons.map(b => b.scope)).toEqual(['public', 'mine', 'shelf']);
    expect(buttons.find(b => b.scope === 'public').active).toBe(true);
    expect(buttons.find(b => b.scope === 'mine').active).toBe(false);
    expect(buttons.find(b => b.scope === 'shelf').active).toBe(false);
  });

  test('shelf picker is hidden by default and shown on shelf chip click', async ({ page }) => {
    await expect(page.locator('.citation-shelf-picker')).toBeHidden();

    await setCitationScope(page, 'shelf');

    await expect(page.locator('.citation-shelf-picker')).toBeVisible();
  });

  test('switching back from shelf to public hides the picker again', async ({ page }) => {
    await setCitationScope(page, 'shelf');
    await expect(page.locator('.citation-shelf-picker')).toBeVisible();

    await setCitationScope(page, 'public');

    await expect(page.locator('.citation-shelf-picker')).toBeHidden();
  });

  test('scope persists in localStorage', async ({ page }) => {
    await setCitationScope(page, 'mine');

    const stored = await page.evaluate(() => localStorage.getItem('hyperlit:citation:scope'));
    expect(stored).toBe('mine');
  });

  test('search request URL includes sourceScope param', async ({ page }) => {
    const requestPromise = page.waitForRequest(
      req => req.url().includes('/api/search/combined'),
      { timeout: 5000 }
    );

    await page.fill('#citation-search-input', 'marx');
    const req = await requestPromise;

    const url = new URL(req.url());
    expect(url.searchParams.get('sourceScope')).toBe('public');
    expect(url.searchParams.get('q')).toBe('marx');
  });

  test('changing scope re-fires the search with new scope param', async ({ page }) => {
    // The scope chips are hidden by CSS the moment any character is typed
    // (#citation-toolbar-results[data-has-query="true"] .citation-scope-bar
    // { display: none }), so a chip can only be clicked BEFORE typing. Select
    // the new scope first, then type — the search must carry the chosen scope.
    await setCitationScope(page, 'mine');

    const requestPromise = page.waitForRequest(
      req => req.url().includes('/api/search/combined') && req.url().includes('sourceScope=mine'),
      { timeout: 5000 }
    );

    await page.fill('#citation-search-input', 'marx');
    const req = await requestPromise;

    const url = new URL(req.url());
    expect(url.searchParams.get('sourceScope')).toBe('mine');
    expect(url.searchParams.get('offset')).toBe('0'); // pagination reset
  });

  test('regression: type → clear → click Shelf keeps picker reachable', async ({ page }) => {
    // Bug: stale currentQuery from prior search re-fired on scope change, hitting
    // the no-shelfId empty state and hiding the chip bar — picker disappeared
    // right when the user needed it.
    await page.fill('#citation-search-input', 'marx');
    await page.waitForFunction(
      () => ['results', 'empty'].includes(document.getElementById('citation-toolbar-results')?.dataset.state),
      null,
      { timeout: 5000 }
    );

    // Clear text
    await page.fill('#citation-search-input', '');

    // Click Shelf
    await setCitationScope(page, 'shelf');

    // Scope bar AND picker must both be visible — and no "Pick a shelf" empty
    // message should have appeared (no stale search was fired).
    await expect(page.locator('.citation-scope-bar')).toBeVisible();
    await expect(page.locator('.citation-shelf-picker')).toBeVisible();
    await expect(page.locator('.citation-search-empty')).toHaveCount(0);
  });

  test('shelf scope without shelfId + typed query shows picker AND empty message', async ({ page }) => {
    // Even when the user types something with shelf-no-shelfId, the picker must
    // stay visible so they can actually pick a shelf.
    await setCitationScope(page, 'shelf');
    await page.fill('#citation-search-input', 'anything');

    await page.waitForFunction(
      () => document.getElementById('citation-toolbar-results')?.dataset.state === 'empty',
      null,
      { timeout: 5000 }
    );

    await expect(page.locator('.citation-shelf-picker')).toBeVisible();
    await expect(page.locator('.citation-search-empty')).toContainText(/pick a shelf/i);
  });

  test('scope chips hide once results render, return when query cleared', async ({ page }) => {
    await expect(page.locator('.citation-scope-bar')).toBeVisible();

    await page.fill('#citation-search-input', 'a'); // single char — still empty
    await page.fill('#citation-search-input', 'marx');

    await page.waitForFunction(
      () => ['results', 'empty'].includes(document.getElementById('citation-toolbar-results')?.dataset.state),
      null,
      { timeout: 5000 }
    );

    await expect(page.locator('.citation-scope-bar')).toBeHidden();

    await page.fill('#citation-search-input', '');
    await expect(page.locator('.citation-scope-bar')).toBeVisible();
  });
});
