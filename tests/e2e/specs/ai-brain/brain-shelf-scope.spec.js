import { test, expect } from '../../fixtures/navigation.fixture.js';
import { startBrainNetworkCapture } from '../../helpers/networkCapture.js';
import {
  findSelectableParagraph,
  openBrainQueryFromSelection,
  setBrainMode,
  setBrainScope,
  pickShelf,
  submitQuestion,
  waitForBrainResult,
} from '../../helpers/brainQuery.js';

const READER_BOOK = process.env.E2E_READER_BOOK || 'book_1777271888985';
const LIVE = process.env.RUN_AI_BRAIN_LIVE === '1';

test.describe('AI Brain shelf scope', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/${READER_BOOK}`);
    // Reset persisted preferences so every test starts in first-time defaults
    await page.evaluate(() => {
      try {
        localStorage.removeItem('hyperlit:brain:mode');
        localStorage.removeItem('hyperlit:brain:scope');
        localStorage.removeItem('hyperlit:brain:shelfId');
      } catch {}
    });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForSelector('.main-content', { timeout: 20_000 });
    const selector = await findSelectableParagraph(page, 80);
    if (!selector) test.skip(true, 'No usable paragraph in test book');
    await openBrainQueryFromSelection(page, selector, 80);
    // Default is Quick — these tests all need Archivist to expose the scope row
    await setBrainMode(page, 'archivist');
  });

  test('clicking Shelf reveals the shelf picker and loads /api/shelves', async ({ page }) => {
    const responsePromise = page.waitForResponse(r => r.url().includes('/api/shelves') && r.request().method() === 'GET',
      { timeout: 10_000 }).catch(() => null);

    expect(await setBrainScope(page, 'shelf')).toBe(true);
    await expect(page.locator('.brain-shelf-picker')).toBeVisible();

    const resp = await responsePromise;
    expect(resp, 'expected GET /api/shelves to fire when Shelf is activated').toBeTruthy();

    // Dropdown should be populated within a second
    await page.waitForFunction(() => {
      const sel = document.querySelector('.brain-shelf-select');
      return sel && sel.options.length > 0;
    }, null, { timeout: 5000 });
  });

  test('selecting another scope hides the shelf picker', async ({ page }) => {
    await setBrainScope(page, 'shelf');
    await expect(page.locator('.brain-shelf-picker')).toBeVisible();
    await setBrainScope(page, 'public');
    await expect(page.locator('.brain-shelf-picker')).toBeHidden();
  });

  test('submitting Shelf scope without picking a shelf shows inline error', async ({ page }) => {
    await setBrainScope(page, 'shelf');
    // Wait for shelves to load so the select exists
    await page.waitForFunction(() => !!document.querySelector('.brain-shelf-select'), null, { timeout: 5000 });
    // Force the placeholder (empty value) to be selected
    await page.evaluate(() => {
      const sel = document.querySelector('.brain-shelf-select');
      if (!sel) return;
      sel.selectedIndex = 0;
    });
    await submitQuestion(page, 'A question that should not actually fire.');

    const status = await page.locator('.brain-status').textContent();
    expect((status || '').toLowerCase()).toContain('shelf');
    // The submit must not have produced a network request
    const reqs = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter(r => r.name.includes('/api/ai-brain/query')).length);
    expect(reqs).toBe(0);
  });

  test(LIVE ? 'Archivist round-trip with shelf scope' : 'Archivist round-trip with shelf scope [skipped]', async ({ page }) => {
    test.skip(!LIVE, 'Set RUN_AI_BRAIN_LIVE=1 to run live LLM calls');
    test.setTimeout(180_000);

    await setBrainScope(page, 'shelf');
    await page.waitForFunction(() => {
      const sel = document.querySelector('.brain-shelf-select');
      return sel && Array.from(sel.options).some(o => o.value);
    }, null, { timeout: 5000 });

    // Pick the first real shelf (index 1 — index 0 is the placeholder "— pick a shelf —")
    const shelfId = await pickShelf(page, 1);
    test.skip(!shelfId, 'Test user has no shelves — create one to run this test');

    const capture = startBrainNetworkCapture(page);
    await submitQuestion(page, 'Summarize the main argument and connect to one shelf source.');
    const result = await waitForBrainResult(page, { timeout: 150_000 });
    capture.stop();

    const req = capture.events().find(e => e.kind === 'request');
    expect(req).toBeTruthy();
    const body = JSON.parse(req.postData);
    expect(body.sourceScope).toBe('shelf');
    expect(body.shelfId).toBe(shelfId);
    // We accept success OR a graceful "no matches" error — both indicate plumbing worked
    expect(['success', 'error']).toContain(result.outcome);
  });
});
