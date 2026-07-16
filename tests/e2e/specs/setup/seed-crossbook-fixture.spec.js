import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { test, expect } from '../../fixtures/navigation.fixture.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EPUB_PATH = path.join(REPO_ROOT, 'tests/conversion/import-samples/dropbox/rockhill.epub');
const ENV_PATH = path.join(REPO_ROOT, 'tests/e2e/.env.e2e');

/**
 * SEEDING SPEC — run explicitly, never as part of a normal suite:
 *
 *   E2E_SEED_CROSSBOOK=1 npx playwright test --config tests/e2e/playwright.config.js specs/setup/seed-crossbook-fixture.spec.js
 *
 * Rebuilds the cross-book hypercite fixture pair that `same-template
 * reader → reader` and the grand tour's `book-to-book via hypercite` depend
 * on (E2E_READER_BOOK must contain an `a.open-icon` hypercite link pointing
 * at E2E_READER_BOOK_2). The original book_1778118593947 was deleted in the
 * dev-DB shrink and E2E_READER_BOOK lost its hypercites with it.
 *
 * What it does — all through REAL app gestures (same recipe as the
 * cross-book tour, which builds and discards this data every run):
 *   1. Imports rockhill.epub as a NEW book — the hypercite SOURCE
 *      (this becomes E2E_READER_BOOK_2).
 *   2. In that book: edit mode → select a deep paragraph substring →
 *      #copy-hypercite (creates the `u.single` source marker).
 *   3. In E2E_READER_BOOK: edit mode → pastes the hypercite content
 *      (creates the `a.open-icon` citation link).
 *   4. Verifies navigateViaHypercite actually lands on the new book.
 *   5. Rewrites E2E_READER_BOOK_2 in tests/e2e/.env.e2e.
 *
 * Idempotent-ish: re-running adds another pasted link to E2E_READER_BOOK and
 * a fresh source book; harmless, but don't run it on every lap.
 */

test.describe('seed cross-book hypercite fixture', () => {
  test('import source book, hypercite into E2E_READER_BOOK, update .env.e2e', async ({ page, spa }) => {
    test.skip(!process.env.E2E_SEED_CROSSBOOK, 'seeding spec — run explicitly with E2E_SEED_CROSSBOOK=1');
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'seed in scroll mode (edit-heavy flow)');
    test.setTimeout(600_000);

    const book1 = process.env.E2E_READER_BOOK;
    expect(book1, 'E2E_READER_BOOK must be set in tests/e2e/.env.e2e').toBeTruthy();

    // ── 1. Import the SOURCE book (future E2E_READER_BOOK_2) ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const { bookId: sourceBookId } = await spa.importMarkdownBook(page, spa, { filePath: EPUB_PATH });
    expect(sourceBookId).toBeTruthy();

    // ── 2. Create the hypercite source marker in it ──
    if (!(await page.evaluate(() => !!window.isEditing))) {
      await page.click('#editButton');
      await spa.waitForEditMode(page);
    }
    await spa.openToc(page);
    const tocEntries = await spa.getTocEntries(page);
    expect(tocEntries.length).toBeGreaterThan(2);
    const deepEntry = tocEntries[Math.min(tocEntries.length - 1, Math.floor(tocEntries.length * 0.7))];
    await spa.clickTocEntry(page, deepEntry.index);

    const paraInfo = await page.evaluate((hash) => {
      const targetId = (hash || '').replace(/^#/, '');
      const heading = document.querySelector(`[id="${targetId}"]`);
      if (!heading) return null;
      let p = heading.nextElementSibling;
      while (p && (p.tagName !== 'P' || (p.textContent || '').trim().length < 40)) p = p.nextElementSibling;
      if (!p) return null;
      const tag = p.tagName.toLowerCase();
      if (p.id) return { selector: `${tag}[id="${p.id}"]` };
      const parent = p.parentElement;
      const idx = [...parent.querySelectorAll(`:scope > ${tag}`)].indexOf(p);
      return { selector: `.main-content ${tag}:nth-of-type(${idx + 1})` };
    }, deepEntry.href);
    expect(paraInfo, `no paragraph found after heading ${deepEntry.href}`).not.toBeNull();

    const paraText = (await page.locator(paraInfo.selector).textContent()).trim();
    await spa.selectTextInElement(page, paraInfo.selector, 0, Math.min(30, Math.max(15, paraText.length - 10)));
    await spa.waitForHyperlightButtons(page);
    await page.click('#copy-hypercite');
    await page.waitForSelector('u[id^="hypercite_"].single', { timeout: 5000 });

    const clipboard = await page.evaluate(() => {
      const uEl = document.querySelector('u[id^="hypercite_"].single');
      const hcId = uEl.id;
      const bookIdMatch = location.pathname.match(/\/(book_\d+[\w-]*)/);
      const bookId = window.book || (bookIdMatch ? bookIdMatch[1] : null) || document.querySelector('.main-content')?.id;
      const selectedText = uEl.textContent;
      const href = `${window.location.origin}/${bookId}#${hcId}`;
      return {
        hyperciteId: hcId,
        html: `'${selectedText}'⁠<a href="${href}" id="${hcId}" class="open-icon">↗</a>`,
        text: `'${selectedText}' [↗](${href})`,
      };
    });
    expect(clipboard.hyperciteId).toMatch(/^hypercite_/);

    // Sync green so the source marker is durable before we leave the book.
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // ── 3. Paste the citation link into E2E_READER_BOOK ──
    await page.goto(`/${book1}`);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.main-content p, .main-content h1, .main-content h2', { timeout: 15000 });
    await page.click('#editButton');
    await spa.waitForEditMode(page);
    // Seat the caret at the end of a real paragraph before pasting (the paste
    // inserts at the caret; without this it lands nowhere — same prep as the
    // cross-book tour).
    const pastePositioned = await page.evaluate(() => {
      const p = [...document.querySelectorAll('.main-content p[id]')]
        .find((el) => (el.textContent || '').trim().length > 40);
      if (!p) return false;
      const range = document.createRange();
      range.selectNodeContents(p);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.focus();
      return true;
    });
    expect(pastePositioned, 'no paragraph to paste into in E2E_READER_BOOK').toBe(true);
    await page.waitForTimeout(300);
    await spa.pasteHyperciteContent(page, clipboard.html, clipboard.text);
    // The paste handler assigns the pasted anchor a FRESH element id — only
    // the href keeps the source hypercite id. Match on href.
    await page.waitForSelector(`.main-content a.open-icon[href*="${clipboard.hyperciteId}"]`, { timeout: 10000 });
    await page.waitForFunction(() => {
      const cloudSvg = document.querySelector('#cloudRef-svg .cls-1');
      return cloudSvg && cloudSvg.getAttribute('fill') === '#63B995';
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.click('#editButton');
    await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 });

    // ── 4. Verify the pair actually navigates (the consumers' exact gesture) ──
    await page.goto(`/${book1}`);
    await page.waitForLoadState('networkidle');
    await spa.navigateViaHypercite(page);
    await spa.waitForTransition(page);
    await page.waitForFunction(
      (id) => location.pathname.includes(id),
      sourceBookId,
      { timeout: 15000 }
    );
    expect(await spa.getStructure(page)).toBe('reader');

    // ── 5. Point E2E_READER_BOOK_2 at the new source book ──
    const env = fs.readFileSync(ENV_PATH, 'utf8');
    const updated = env.match(/^E2E_READER_BOOK_2=.*$/m)
      ? env.replace(/^E2E_READER_BOOK_2=.*$/m, `E2E_READER_BOOK_2=${sourceBookId}`)
      : `${env.trimEnd()}\nE2E_READER_BOOK_2=${sourceBookId}\n`;
    fs.writeFileSync(ENV_PATH, updated);
    // eslint-disable-next-line no-console
    console.log(`[seed-crossbook] E2E_READER_BOOK now hypercites ${sourceBookId}; .env.e2e updated (E2E_READER_BOOK_2=${sourceBookId}).`);
  });
});
