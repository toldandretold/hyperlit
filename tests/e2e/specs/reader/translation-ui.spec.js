// @ts-check
//
// "Translate this book" — the source panel's state machine, driven by REAL
// gestures against MOCKED /api/book-translation + /api/book-versions routes
// (the ai-archivist / audioHarness pattern: fake OUR api, never the provider;
// the money path runs the real pipeline in specs/stripe/translation-billing).
//
// Covered: the offer (commons wording), confirm dialog → POST → running state
// (button text + "See live progress ▸" row), cancel sends nothing, the
// stage-chain overlay renders live stages and closing it never stops the run,
// an EXISTING translation hides the Translate section and surfaces in the
// Versions rail instead (language-as-link + MT provenance meta), and a
// translation copy's citation provenance note.
//
// RegExp routes, never globs (the audio harness's silent-no-match lesson);
// service workers blocked or page.route never sees the requests.
//
// Run: npm run test:e2e -- specs/reader/translation-ui.spec.js

import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const BASE = process.env.E2E_BASE_URL || 'https://hyperlit.test';
const READER_BOOK = process.env.E2E_READER_BOOK;

const OFFER = {
  success: true, available: true, source_lang: 'en', target_lang: 'zh-Hans',
  target_label: 'Chinese', characters: 1000, estimated_cost: 0.51,
  logged_in: true, will_be_public: true, running: false, progress: null, existing: null,
};

const RUNNING = {
  ...OFFER, estimated_cost: null, running: true,
  progress: {
    status: 'running', phase: 'text', percent: 0.42, error: null, stage: 'text',
    stages: {
      queued: { status: 'completed' },
      text: { status: 'progress', section: 2, sections: 5, title: '第二章', chars_done: 420, chars_total: 1000 },
    },
    new_book: null,
  },
  telemetry: [{ t: '2026-01-01T00:00:00Z', stage: 'text', status: 'progress', detail: 'Section 2/5: 第二章' }],
};

const DONE = {
  ...OFFER, running: false,
  existing: { book: 'book_mock_zh', title: 'Mock（中文）', own: true, creator: 'pleaseplease' },
  progress: { status: 'done', phase: 'notes', percent: 1, error: null, stage: 'write', stages: {}, new_book: 'book_mock_zh' },
};

/** versions payload: viewing the ORIGINAL, one finished translation. */
const RAIL_WITH_TRANSLATION = (current) => ({
  success: true, book: current,
  versions: [
    { book: current, title: 'The Original', language: 'en', creator: 'owner', created_at: null, kind: 'original', is_current: true, translation: null },
    {
      book: 'book_mock_zh', title: 'Mock（中文）', language: 'zh-Hans', creator: 'pleaseplease',
      created_at: null, kind: 'translation', is_current: false,
      translation: { target: 'zh-Hans', model: 'accounts/fireworks/models/kimi-k3', human_reviewed: false, original_edited_since: true },
    },
  ],
});

/** versions payload: viewing the TRANSLATION itself (provenance note case). */
const RAIL_AS_TRANSLATION = (current) => ({
  success: true, book: current,
  versions: [
    { book: 'book_mock_original', title: 'The Original', language: 'en', creator: 'owner', created_at: null, kind: 'original', is_current: false, translation: null },
    {
      book: current, title: 'Mock（中文）', language: 'zh-Hans', creator: 'pleaseplease',
      created_at: null, kind: 'translation', is_current: true,
      translation: { target: 'zh-Hans', model: 'accounts/fireworks/models/kimi-k3', human_reviewed: false, original_edited_since: true },
    },
  ],
});

/**
 * Mock the translation/versions API around a mutable state box. The map
 * route stays REAL (static stage descriptions). Returns the POST log.
 */
async function mockTranslationApi(page, state) {
  const posts = [];
  // Status + start — but NOT /map (negative lookahead), which the overlay
  // fetches for the real TranslationMap stage descriptions.
  await page.route(/\/api\/book-translation\/(?!map($|\?))[^/?]+(\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().url());
      state.current = state.afterStart ?? state.current;
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ success: true, target_lang: 'zh-Hans' }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.current) });
  });
  await page.route(/\/api\/book-versions\/[^/?]+(\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.rail) });
  });

  return posts;
}

async function openSourcePanel(page) {
  await page.goto(`${BASE}/${READER_BOOK}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.main-content', { timeout: 15_000 });
  await page.waitForSelector('#cloudRef', { timeout: 15_000 });
  // ButtonRegistry binds handlers after boot, so the first click can land on
  // a deaf button (the auth.setup lesson) — retry the whole gesture. And
  // click through the DOM: perimeter buttons can fail Playwright's
  // interception check (the post-nav probe lesson).
  await expect(async () => {
    await page.evaluate(() => document.getElementById('cloudRef')?.click());
    await page.waitForFunction(() => !!document.querySelector('#source-container.open'), null, { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

test.beforeEach(() => {
  test.skip(!READER_BOOK, 'E2E_READER_BOOK not set');
});

test('offer → confirm → running: commons wording, live row, overlay narrates the run', async ({ page }) => {
  const state = { current: OFFER, afterStart: RUNNING, rail: { success: true, book: READER_BOOK, versions: [] } };
  const posts = await mockTranslationApi(page, state);
  await openSourcePanel(page);

  // The offer, with the commons promise spelled out.
  const button = page.locator('.book-translation-btn');
  await expect(button).toHaveText('Translate into Chinese');
  await expect(page.locator('.book-translation-note')).toContainText('you pay once, nobody pays again');

  // Confirm dialog → POST → optimistic running state.
  await button.click();
  await expect(page.locator('.app-dialog-card')).toContainText('Translate into Chinese?');
  await page.click('.app-dialog-card [data-act="confirm"]');
  await expect(button).toBeDisabled();
  await expect(button).toContainText('Waiting to translate into Chinese');
  expect(posts.length).toBe(1);

  // The live row appears; the overlay opens from it and renders the REAL
  // TranslationMap chain fed by the mocked stage payload.
  const toggle = page.locator('#book-translation-live .book-translation-viz-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  const overlay = page.locator('#translation-viz-overlay');
  await expect(overlay).toBeVisible();
  // First paint is the OPTIMISTIC status (no stages yet); the mocked RUNNING
  // payload arrives on the next poll of the 5s cadence — wait past it.
  await expect(overlay).toContainText('Translating the text', { timeout: 12_000 }); // map title, running stage
  await expect(overlay).toContainText('第二章', { timeout: 12_000 });                // live section signal
  await expect(overlay).toContainText('420');                                        // chars_done

  // Closing the overlay never stops the run: the row survives, and the
  // next poll (5s cadence) still shows the running button text.
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(toggle).toBeVisible();
  await expect(button).toContainText('Translating text into Chinese… 42%', { timeout: 10_000 });
});

test('cancel sends nothing and the offer stays armed', async ({ page }) => {
  const state = { current: OFFER, afterStart: RUNNING, rail: { success: true, book: READER_BOOK, versions: [] } };
  const posts = await mockTranslationApi(page, state);
  await openSourcePanel(page);

  const button = page.locator('.book-translation-btn');
  await expect(button).toHaveText('Translate into Chinese');
  await button.click();
  await page.click('.app-dialog-card [data-act="cancel"]');

  await expect(button).toBeEnabled();
  await expect(button).toHaveText('Translate into Chinese');
  expect(posts.length).toBe(0);
});

test('an existing translation: Translate section hides, the Versions rail is the surface', async ({ page }) => {
  const state = { current: DONE, rail: RAIL_WITH_TRANSLATION(READER_BOOK) };
  await mockTranslationApi(page, state);
  await openSourcePanel(page);

  // The section never shows an open-link of its own any more.
  await expect(page.locator('#book-translation-section')).toBeHidden();

  // The rail: translate glyph in the heading, the LANGUAGE as the link,
  // full MT provenance in the meta line.
  const rail = page.locator('#book-versions-section');
  await expect(rail).toBeVisible();
  await expect(rail.locator('.book-versions-heading')).toContainText('Translations');
  await expect(rail.locator('.book-versions-heading .book-version-translate-icon')).toHaveCount(1);
  const link = rail.locator('a.book-version-title');
  await expect(link).toContainText('简体中文');
  await expect(link).toHaveAttribute('href', '/book_mock_zh');
  await expect(rail.locator('.book-version-meta')).toContainText('machine translation (Kimi K3), commissioned by pleaseplease');
  // The staleness disclosure rides the rail's translation entry.
  await expect(rail.locator('.book-version-stale')).toContainText('The original has been edited since this translation was made.');
});

test('a translation copy discloses MT provenance under its citation', async ({ page }) => {
  const state = { current: { ...OFFER, available: false, reason: 'already a translation' }, rail: RAIL_AS_TRANSLATION(READER_BOOK) };
  await mockTranslationApi(page, state);
  await openSourcePanel(page);

  const note = page.locator('.citation-translation-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Machine translation (Kimi K3) into 简体中文, commissioned by pleaseplease');
  await expect(note).toContainText('describe the original work');
  await expect(note.locator('a')).toHaveAttribute('href', '/book_mock_original');
  // The rail names the original by language, linked.
  await expect(page.locator('#book-versions-section a.book-version-title').first()).toContainText('Original');
});
