import { test, expect } from '../../fixtures/navigation.fixture.js';
import { startBrainNetworkCapture } from '../../helpers/networkCapture.js';
import {
  findSelectableParagraph,
  openBrainQueryFromSelection,
  setBrainMode,
  setBrainScope,
  submitQuestion,
  waitForBrainResult,
} from '../../helpers/brainQuery.js';

const READER_BOOK = process.env.E2E_READER_BOOK || 'book_1777271888985';
const LIVE = process.env.RUN_AI_BRAIN_LIVE === '1';

test.describe('AI Brain modes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/${READER_BOOK}`);
    // Clear persisted preferences so each test starts from first-time defaults
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
  });

  test('first-time default is Quick Chat with scope toggle hidden', async ({ page }) => {
    const quickActive = await page.locator('.brain-mode-btn[data-mode="quick"].active').count();
    expect(quickActive).toBe(1);
    await expect(page.locator('.brain-scope-toggle')).toBeHidden();
    await expect(page.locator('.brain-section-label')).toBeHidden();
    await expect(page.locator('.brain-shelf-picker')).toBeHidden();
  });

  test('scope row exposes only Public, Personal, Shelf (no All, no Here)', async ({ page }) => {
    await setBrainMode(page, 'archivist');
    const buttons = await page.locator('.brain-scope-toggle .brain-scope-btn').evaluateAll(
      els => els.map(el => el.dataset.scope)
    );
    expect(buttons).toEqual(['public', 'mine', 'shelf']);
  });

  test('selecting AI Archivist shows scope toggle and section label', async ({ page }) => {
    expect(await setBrainMode(page, 'archivist')).toBe(true);
    await expect(page.locator('.brain-mode-btn[data-mode="archivist"]')).toHaveClass(/active/);
    await expect(page.locator('.brain-scope-toggle')).toBeVisible();
    await expect(page.locator('.brain-section-label')).toBeVisible();
  });

  test('toggling back to Quick Chat hides scope toggle', async ({ page }) => {
    await setBrainMode(page, 'archivist');
    await expect(page.locator('.brain-scope-toggle')).toBeVisible();
    await setBrainMode(page, 'quick');
    await expect(page.locator('.brain-scope-toggle')).toBeHidden();
    await expect(page.locator('.brain-section-label')).toBeHidden();
  });

  test('mode + scope persist across container reopens', async ({ page, spa }) => {
    // First open: switch to Archivist + Personal
    await setBrainMode(page, 'archivist');
    await setBrainScope(page, 'mine');

    // Close and reopen
    await spa.closeHyperlitContainer(page);
    await page.waitForFunction(() =>
      !document.getElementById('hyperlit-container')?.classList.contains('open'),
      null, { timeout: 5000 });

    const selector = await findSelectableParagraph(page, 80);
    await openBrainQueryFromSelection(page, selector, 80);

    // Choices should be restored
    await expect(page.locator('.brain-mode-btn[data-mode="archivist"]')).toHaveClass(/active/);
    await expect(page.locator('.brain-scope-btn[data-scope="mine"]')).toHaveClass(/active/);
    await expect(page.locator('.brain-scope-toggle')).toBeVisible();
  });

  test(LIVE ? 'Quick Chat round-trip' : 'Quick Chat round-trip [skipped — set RUN_AI_BRAIN_LIVE=1]', async ({ page }) => {
    test.skip(!LIVE, 'Set RUN_AI_BRAIN_LIVE=1 to run live LLM calls');
    test.setTimeout(180_000);

    const capture = startBrainNetworkCapture(page);
    await setBrainMode(page, 'quick');
    await submitQuestion(page, 'Summarize this passage in one sentence.');
    const result = await waitForBrainResult(page, { timeout: 150_000 });
    capture.stop();

    expect(result.outcome).toBe('success');

    const req = capture.events().find(e => e.kind === 'request');
    expect(req, 'expected a POST request to /api/ai-brain/query').toBeTruthy();
    const body = JSON.parse(req.postData);
    expect(body.mode).toBe('quick');
  });

  test(LIVE ? 'Archivist round-trip with Public scope' : 'Archivist round-trip with Public scope [skipped]', async ({ page }) => {
    test.skip(!LIVE, 'Set RUN_AI_BRAIN_LIVE=1 to run live LLM calls');
    test.setTimeout(180_000);

    const capture = startBrainNetworkCapture(page);
    await setBrainMode(page, 'archivist');
    await setBrainScope(page, 'public');
    await submitQuestion(page, 'What is the central claim of this passage?');
    const result = await waitForBrainResult(page, { timeout: 150_000 });
    capture.stop();

    expect(result.outcome).toBe('success');
    const req = capture.events().find(e => e.kind === 'request');
    expect(req).toBeTruthy();
    const body = JSON.parse(req.postData);
    expect(body.mode).toBe('archivist');
    expect(body.sourceScope).toBe('public');
  });
});
