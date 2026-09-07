/**
 * Editor image insert (toolbar picker path) must persist: upload → new <img>
 * node at the caret → survives a reload (IndexedDB + server round trip).
 *
 * Regression spec for the 2026-09 "insert an image but on page refresh it's
 * gone" bug: INLINE_SKIP_TAGS includes IMG (a numeric-id img INSIDE a
 * paragraph is a copy-paste artifact), and batch.ts silently dropped the
 * top-level image NODE from every save. The fix is the isImageNodeElement
 * exemption (utilities/blockElements.ts) applied across the save + integrity
 * pipeline — this spec locks the end-to-end behavior.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('divEditor — toolbar image insert persistence', () => {
  test('an inserted image node survives a reload', async ({ page, spa }) => {
    test.setTimeout(120_000);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.click('#newBookButton');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    await page.click('#createNewBook');

    await spa.waitForTransition(page);
    await spa.waitForEditMode(page);
    await page.waitForSelector('h1[id="100"]', { timeout: 5000 });

    // A real paragraph so the caret anchor is an ordinary node.
    await page.click('h1[id="100"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('image goes after this paragraph');
    await page.waitForTimeout(1500);

    // Feed the hidden picker input directly (the toolbar button just .click()s it).
    await page.setInputFiles('#imageFileInput', {
      name: 'e2e-insert.png',
      mimeType: 'image/png',
      buffer: ONE_PX_PNG,
    });

    // Upload → insert happens async after the change event.
    await page.waitForSelector('.main-content img[src*="/media/"]', { timeout: 15000 });

    const inserted = await page.evaluate(() => {
      const img = document.querySelector('.main-content img[src*="/media/"]');
      return {
        id: img?.id ?? null,
        src: img?.getAttribute('src') ?? null,
        parentIsChunk: img?.parentElement?.classList?.contains('chunk') ?? false,
      };
    });
    expect(inserted.id).toMatch(/^\d+(\.\d+)?$/);
    expect(inserted.src).toContain('/media/');
    expect(inserted.parentIsChunk).toBe(true);

    // Give the debounced save + sync time to flush, then verify the record
    // actually landed in IndexedDB (the bug dropped it silently right here).
    await page.waitForTimeout(4000);
    const idbHasNode = await page.evaluate(async (startLine) => {
      const dbs = await indexedDB.databases();
      const open = (name) => new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const meta of dbs) {
        try {
          const db = await open(meta.name);
          if (!db.objectStoreNames.contains('nodes')) { db.close(); continue; }
          const rows = await new Promise((res, rej) => {
            const tx = db.transaction('nodes', 'readonly');
            const all = tx.objectStore('nodes').getAll();
            all.onsuccess = () => res(all.result);
            all.onerror = () => rej(all.error);
          });
          db.close();
          if (rows.some((r) => String(r.startLine) === String(startLine) && (r.content || '').includes('/media/'))) {
            return true;
          }
        } catch { /* skip */ }
      }
      return false;
    }, inserted.id);
    expect(idbHasNode, 'image node record must land in IndexedDB').toBe(true);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await spa.waitForTransition(page).catch(() => {});
    await page.waitForSelector('.main-content .chunk', { timeout: 15000 });
    await page.waitForTimeout(1500);

    const after = await page.evaluate((id) => {
      const byId = document.getElementById(id);
      const anyMediaImg = document.querySelector('.main-content img[src*="/media/"]');
      return {
        byIdTag: byId?.tagName ?? null,
        anyMediaImg: !!anyMediaImg,
      };
    }, inserted.id);

    expect(after.anyMediaImg, 'inserted image node must survive the reload').toBe(true);
    expect(after.byIdTag).toBe('IMG');

    // The bytes must actually SERVE and decode (RLS-gated media route) — a
    // node whose src 404s renders as a broken-image placeholder.
    const decoded = await page.evaluate(async (id) => {
      const img = document.getElementById(id);
      if (!img) return { ok: false, why: 'missing' };
      if (img.complete && img.naturalWidth > 0) return { ok: true };
      const status = await fetch(img.currentSrc || img.src, { credentials: 'include' })
        .then((r) => `${r.status} ${r.headers.get('content-type')}`)
        .catch((e) => `fetch-error ${e}`);
      return { ok: false, why: `naturalWidth=${img.naturalWidth} complete=${img.complete} probe=${status}` };
    }, inserted.id);
    expect(decoded.ok, `image bytes must serve + decode (${decoded.why ?? ''})`).toBe(true);
  });
});
