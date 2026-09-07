/**
 * Anonymous-creator variant of the image-insert persistence spec — the phone
 * report shape: anon book (creator_token cookie, no login), insert a photo,
 * the <img> must serve + decode through the RLS-gated media route.
 */
import { test, expect } from '@playwright/test';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('divEditor — ANON image insert serve+decode', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('anon-created book: inserted image serves and decodes', async ({ page }) => {
    test.setTimeout(120_000);

    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('response', (r) => {
      if (r.url().includes('/media/') || (r.url().includes('/images') && r.request().method() === 'POST')) {
        errors.push(`NET ${r.request().method()} ${r.status()} ${r.url().slice(-80)}`);
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.click('#newBookButton');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');

    await page.waitForSelector('.main-content[contenteditable="true"]', { timeout: 15000 });
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });

    await page.click('h1[id="100"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('anon image below');
    await page.waitForTimeout(1500);

    await page.setInputFiles('#imageFileInput', {
      name: 'anon-insert.png',
      mimeType: 'image/png',
      buffer: ONE_PX_PNG,
    });

    await page.waitForSelector('.main-content img[src*="/media/"]', { timeout: 15000 });
    await page.waitForTimeout(2500);

    const state = await page.evaluate(async () => {
      const img = document.querySelector('.main-content img[src*="/media/"]');
      const probe = await fetch(img.getAttribute('src'), { credentials: 'include' })
        .then((r) => `${r.status} ${r.headers.get('content-type')}`)
        .catch((e) => `fetch-error ${e}`);
      return {
        src: img.getAttribute('src'),
        naturalWidth: img.naturalWidth,
        complete: img.complete,
        wrapped: !!img.closest('.broken-image-wrapper'),
        probe,
      };
    });
    console.log('[anon-image] state:', JSON.stringify(state), 'events:', JSON.stringify(errors.slice(-10)));

    expect(state.probe, 'media fetch must be 200 for the anon creator').toContain('200');
    expect(state.naturalWidth, 'image must decode (not broken placeholder)').toBeGreaterThan(0);
    expect(state.wrapped).toBe(false);
  });
});
