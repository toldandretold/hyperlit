/**
 * Citation modal — full insertion flow.
 *
 * Asserts that selecting a citation result writes:
 *   - an inline (Author Year) marker in the DOM
 *   - a bibliography record in IndexedDB with the correct pointer shape
 *     (source_id for canonical-with-version / library, canonical_source_id
 *      for canonical results)
 *
 * Gated by E2E_READER_BOOK because the test needs an editable book where the
 * inserter can actually rewrite a node.
 */

import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  findCitableParagraph,
  openCitationModal,
  lastBibliographyRecord,
  waitForCitationResults,
} from '../../helpers/citationModal.js';

const READER_BOOK = process.env.E2E_READER_BOOK || 'book_1777271888985';

test.describe('Citation modal — insertion', () => {
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

  test('selecting a result inserts (Author Year) inline + writes bibliography record', async ({ page }) => {
    await page.fill('#citation-search-input', 'marx');
    const state = await waitForCitationResults(page);
    if (state !== 'results') test.skip(true, `no results for "marx" in this library (state=${state})`);

    // Snapshot existing citation-refs so we can find the new one
    const beforeIds = await page.locator('a.citation-ref').evaluateAll(els => els.map(el => el.id));

    // Click the first result
    await page.locator('.citation-result-item').first().click();

    // Wait for a new citation-ref to appear
    await page.waitForFunction(
      (before) => Array.from(document.querySelectorAll('a.citation-ref')).map(el => el.id).filter(id => !before.includes(id)).length > 0,
      beforeIds,
      { timeout: 10_000 }
    );

    const newRefId = await page.evaluate((before) => {
      const all = Array.from(document.querySelectorAll('a.citation-ref')).map(el => el.id);
      return all.find(id => !before.includes(id));
    }, beforeIds);

    expect(newRefId).toMatch(/^Ref\d+_/);

    // The inserted anchor sits inside "(Author <a>Year</a>)" — verify the year text
    const yearText = await page.locator(`a.citation-ref#${newRefId}`).textContent();
    expect(yearText).toBeTruthy();
    expect(yearText.trim().length).toBeGreaterThan(0);

    // Verify bibliography record landed in IDB
    const bib = await page.evaluate((refId) => {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('MarkdownDB');
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('bibliography', 'readonly');
          const store = tx.objectStore('bibliography');
          const out = [];
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = (evt) => {
            const cursor = evt.target.result;
            if (cursor) {
              if (cursor.value.referenceId === refId) out.push(cursor.value);
              cursor.continue();
            } else {
              resolve(out[0] || null);
            }
          };
          cursorReq.onerror = () => reject(new Error('cursor failed'));
        };
        req.onerror = () => reject(new Error('open MarkdownDB failed'));
      });
    }, newRefId);

    expect(bib).not.toBeNull();
    expect(bib.referenceId).toBe(newRefId);
    expect(bib.content).toBeTruthy();
    // At least one of the two pointers must be set
    expect(bib.source_id || bib.canonical_source_id).toBeTruthy();
  });

  test('canonical-only result writes canonical_source_id but null source_id', async ({ page }) => {
    // Find a result tagged source=canonical-only and click it.
    await page.fill('#citation-search-input', 'marx');
    const state = await waitForCitationResults(page);
    if (state !== 'results') test.skip(true, 'no results to pick from');

    const canonicalOnlyCount = await page.locator('.citation-result-item[data-source="canonical-only"]').count();
    if (canonicalOnlyCount === 0) {
      test.skip(true, 'no canonical-only results available — this library has the version');
    }

    const beforeIds = await page.locator('a.citation-ref').evaluateAll(els => els.map(el => el.id));

    await page.locator('.citation-result-item[data-source="canonical-only"]').first().click();

    await page.waitForFunction(
      (before) => Array.from(document.querySelectorAll('a.citation-ref')).map(el => el.id).filter(id => !before.includes(id)).length > 0,
      beforeIds,
      { timeout: 10_000 }
    );

    const newRefId = await page.evaluate((before) => {
      const all = Array.from(document.querySelectorAll('a.citation-ref')).map(el => el.id);
      return all.find(id => !before.includes(id));
    }, beforeIds);

    const bib = await page.evaluate((refId) => {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('MarkdownDB');
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction('bibliography', 'readonly');
          const store = tx.objectStore('bibliography');
          const out = [];
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = (evt) => {
            const cursor = evt.target.result;
            if (cursor) {
              if (cursor.value.referenceId === refId) out.push(cursor.value);
              cursor.continue();
            } else {
              resolve(out[0] || null);
            }
          };
          cursorReq.onerror = () => reject(new Error('cursor failed'));
        };
        req.onerror = () => reject(new Error('open MarkdownDB failed'));
      });
    }, newRefId);

    expect(bib).not.toBeNull();
    expect(bib.canonical_source_id).toBeTruthy();
    // Canonical-only: book pointer should be empty (PR4 controller shape: book='' for canonical-only)
    expect(bib.source_id || '').toBe('');
  });
});
