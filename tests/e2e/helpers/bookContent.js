/**
 * Long-book content generation + import wrapper.
 *
 * Generates reproducible markdown with predictable headings, anchor-friendly
 * paragraph prefixes, and `[^N]` footnote references — the canonical footnote
 * shape consumed by the import pipeline (see CLAUDE.md PDF-to-md pipeline).
 *
 * `importMarkdownBook` drives the same drag-drop flow exercised by
 * file-import-drag-drop.spec.js and returns the imported book's id.
 */
import { dropFileOnWindow } from './dropFile.js';
import path from 'path';

const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
];

const CHAPTER_TITLES = [
  'Origins', 'Theory', 'Practice', 'Reception', 'Critique',
  'Legacy', 'Afterlives', 'Coda', 'Appendix', 'Notes',
];

function generateWords(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(LOREM_WORDS[i % LOREM_WORDS.length]);
  return out.join(' ');
}

/**
 * Build a reproducible long-book markdown document.
 *
 * Anchor format is `ANCHORcCpP` (no underscores, no spaces) because
 * markdown italicises `_text_` and we want the rendered text to match the
 * source text exactly for selector queries.
 *
 * @param {Object} opts
 * @param {string} [opts.title]
 * @param {number} [opts.chapters]              Number of `# Chapter N` sections
 * @param {number} [opts.paragraphsPerChapter]
 * @param {number} [opts.wordsPerParagraph]
 * @returns {string}
 */
export function generateLongMarkdown({
  title = 'Stress Test Book',
  chapters = 6,
  paragraphsPerChapter = 4,
  wordsPerParagraph = 60,
} = {}) {
  const lines = [`# ${title}`, ''];

  for (let c = 1; c <= chapters; c++) {
    const chapTitle = CHAPTER_TITLES[(c - 1) % CHAPTER_TITLES.length];
    lines.push(`# Chapter ${c}: ${chapTitle}`);
    lines.push('');
    for (let p = 1; p <= paragraphsPerChapter; p++) {
      const anchor = `ANCHORc${c}p${p}`;
      lines.push(`${anchor} ${generateWords(wordsPerParagraph)}.`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Import a markdown book via the homepage drag-and-drop flow.
 *
 * Assumes the test is starting from anywhere — navigates to home first.
 * Returns { bookId } once the SPA transition into the reader has settled,
 * `body[data-page="reader"]` is set, and `window.book` matches the
 * book_<digits> shape. Home has its own `.main-content` tabs
 * (most-recent / most-connected / most-lit), so plain `.main-content`
 * is NOT a reliable reader-landing signal.
 */
export async function importMarkdownBook(page, spa, opts) {
  const { name, content, filePath } = opts;
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  let expectedName;

  if (filePath) {
    // Open the import form, then attach the real file via setInputFiles —
    // binary-safe (epub/docx/pdf) and bypasses synthetic drag.
    expectedName = path.basename(filePath);
    await page.click('#newBook');
    await page.waitForFunction(() => {
      const c = document.getElementById('newbook-container');
      return c && window.getComputedStyle(c).opacity !== '0' && window.getComputedStyle(c).width !== '0px';
    }, null, { timeout: 5000 });
    const importBtn = page.locator('#importBook');
    if (await importBtn.count() > 0) await importBtn.click().catch(() => {});
    await page.waitForSelector('#cite-form', { timeout: 10000 });
    await page.waitForSelector('#markdown_file', { timeout: 5000 });
    await page.locator('#markdown_file').setInputFiles(filePath);
  } else {
    expectedName = name;
    await dropFileOnWindow(page, { name, type: 'text/markdown', content });
    await page.waitForSelector('#cite-form', { timeout: 15000 });
  }

  await page.waitForFunction((expected) => {
    const input = document.getElementById('markdown_file');
    if (!input?.files?.length) return false;
    if (input.files[0].name !== expected) return false;
    const dz = document.getElementById('markdown-file-dropzone');
    const dzText = dz?.textContent || '';
    return dzText.includes('File ready') && dzText.includes(expected);
  }, expectedName, { timeout: 15000 });

  await page.click('#createButton');
  await spa.waitForTransition(page);

  // Strict reader-landing check. window.book is NOT set after the import
  // pathway (only some pathways set it), so we identify the reader's main
  // element by the URL-derived bookId rather than relying on the global.
  let lastDiag = null;
  try {
    await page.waitForFunction(() => {
      const diag = {
        url: location.pathname,
        dataPage: document.body.getAttribute('data-page'),
        mainIds: [...document.querySelectorAll('main.main-content')].map(m => m.id),
      };
      window.__importDiag = diag;
      if (diag.dataPage !== 'reader') return false;
      const urlBookId = (location.pathname.match(/\/(book_\d+[\w-]*)/) || [])[1];
      if (!urlBookId) return false;
      const main = document.getElementById(urlBookId);
      return !!(main && main.classList.contains('main-content'));
    }, null, { timeout: 30000 });
  } catch (err) {
    lastDiag = await page.evaluate(() => window.__importDiag).catch(() => null);
    throw new Error(`importMarkdownBook landing failed. Diagnostics: ${JSON.stringify(lastDiag)}`);
  }

  const bookId = await page.evaluate(() => {
    const urlMatch = location.pathname.match(/\/(book_\d+[\w-]*)/);
    return urlMatch ? urlMatch[1] : (document.querySelector('.main-content')?.id || null);
  });
  if (!/^book_\d+/.test(String(bookId))) {
    throw new Error(`importMarkdownBook: expected book_<digits>, got "${bookId}"`);
  }

  // Dismiss the post-import "References detected?" / "PDF imported" dialog if it appears.
  // The modal blocks subsequent interactions like clicking #toc-toggle-button.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const looksGood = buttons.find(b => /Looks good/i.test(b.textContent || ''));
    if (looksGood) looksGood.click();
  });
  await page.waitForTimeout(300);
  return { bookId };
}
