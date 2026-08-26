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
import { dropFileOnWindow, dropFilesOnWindow } from './dropFile.js';
import { dismissConversionFeedbackToast } from './pageHelpers.js';
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
 * Build markdown for a long image-bearing book (scroll-restore fixtures).
 *
 * Layout: `chapters` × (heading + paragraphsPerChapter paragraphs + one image
 * `![fig c-i](fig-c-i.png)` after every `imageEvery` paragraphs). A marker
 * paragraph `SCROLLTARGETMARKER …` is injected in `markerChapter` so specs can
 * find the deep anchor by text, regardless of the id numbering the import
 * pipeline assigns. Default sizing yields ~4 lazy chunks with images in every
 * chunk, and the marker lands in a chunk with image-bearing chunks above it —
 * the geometry that exercises restore-time chunk loads + late image decode.
 *
 * @returns {{ markdown: string, imageNames: string[], markerText: string }}
 */
export function generateImageBookMarkdown({
  title = 'Image Scroll Book',
  chapters = 24,
  paragraphsPerChapter = 10,
  imageEvery = 3,
  markerChapter = 18,
  wordsPerParagraph = 30,
  // 'media'  → refs are bare filenames; the import rewriter turns them into
  //            `/{bookId}/media/<name>` (dims may be stamped server-side).
  // 'remote' → refs point at the fake `https://img.test/` host; the rewriter
  //            leaves them and no width/height is ever stamped (the unsized
  //            maximal-shift case). Bytes come from the throttle's `serve`.
  imageMode = 'remote',
} = {}) {
  const lines = [`# ${title}`, ''];
  const imageNames = [];
  const markerText = `SCROLLTARGETMARKER c${markerChapter}`;

  for (let c = 1; c <= chapters; c++) {
    const chapTitle = CHAPTER_TITLES[(c - 1) % CHAPTER_TITLES.length];
    lines.push(`# Chapter ${c}: ${chapTitle}`);
    lines.push('');
    for (let p = 1; p <= paragraphsPerChapter; p++) {
      if (c === markerChapter && p === Math.floor(paragraphsPerChapter / 2)) {
        lines.push(`${markerText} ${generateWords(wordsPerParagraph)}.`);
        lines.push('');
      }
      lines.push(`ANCHORc${c}p${p} ${generateWords(wordsPerParagraph)}.`);
      lines.push('');
      if (p % imageEvery === 0) {
        const imgName = `fig-c${c}p${p}.png`;
        imageNames.push(imgName);
        const src = imageMode === 'remote' ? `https://img.test/${imgName}` : imgName;
        lines.push(`![fig ${c}-${p}](${src})`);
        lines.push('');
      }
    }
  }

  return { markdown: lines.join('\n'), imageNames, markerText };
}

/** Shared reader-landing wait for the import paths (see importMarkdownBook). */
async function waitForReaderLanding(page) {
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
    throw new Error(`reader landing failed. Diagnostics: ${JSON.stringify(lastDiag)}`);
  }
  const bookId = await page.evaluate(() => {
    const urlMatch = location.pathname.match(/\/(book_\d+[\w-]*)/);
    return urlMatch ? urlMatch[1] : (document.querySelector('.main-content')?.id || null);
  });
  if (!/^book_\d+/.test(String(bookId))) {
    throw new Error(`expected book_<digits>, got "${bookId}"`);
  }
  return bookId;
}

/**
 * Import a markdown book WITH IMAGES: drops the md + pngs as loose files,
 * which routes to the one-book-folder (classic md+images) import path, then
 * fills the cite-form like importMarkdownBook.
 *
 * `images` maps name → PNG Buffer (see helpers/pngGen.js). Binary payloads
 * cross the evaluate boundary as base64 (dropFilesOnWindow handles that).
 *
 * The dropzone copy differs from the single-file flow (it lists N files), so
 * the readiness probe here keys off the input's FileList length instead of
 * the "File ready" text.
 *
 * @returns {Promise<{bookId: string}>}
 */
export async function importImageBook(page, spa, { name, markdown, images }) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const files = [
    { name, type: 'text/markdown', content: markdown },
    ...[...images.entries()].map(([imgName, buf]) => ({
      name: imgName,
      type: 'image/png',
      contentBase64: buf.toString('base64'),
    })),
  ];
  await dropFilesOnWindow(page, files);

  await page.waitForSelector('#cite-form', { timeout: 15000 });
  await page.waitForFunction((expected) => {
    const input = document.getElementById('markdown_file');
    return !!input && input.files && input.files.length === expected;
  }, files.length, { timeout: 15000 });

  await page.waitForTimeout(500);
  const pinnedBookId = 'book_' + Date.now();
  await page.fill('#book', pinnedBookId);

  await page.click('#createButton');
  await spa.waitForTransition(page);

  const bookId = await waitForReaderLanding(page);
  await dismissConversionFeedbackToast(page);
  return { bookId };
}

/** The DOM id of the node whose text contains `text` (deep-anchor lookup). */
export function findNodeIdByText(page, text) {
  return page.evaluate((needle) => {
    const nodes = [...document.querySelectorAll('.main-content p[id], .main-content h1[id], .main-content h2[id]')];
    const hit = nodes.find((n) => (n.textContent || '').includes(needle));
    return hit ? hit.id : null;
  }, text);
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
    await page.click('#newBookButton');
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

  // Pin an explicit book_<digits> id. The cite-form's metadata extraction
  // (handleFileMetadataExtraction) auto-fills #book with a slug derived from
  // the file's title/author, which lands the reader on /<slug>/edit and breaks
  // every downstream assumption that ids look like book_<digits>. Let the
  // async autofill settle, then overwrite it with our own id.
  await page.waitForTimeout(500);
  const pinnedBookId = 'book_' + Date.now();
  await page.fill('#book', pinnedBookId);

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

  // Dismiss the post-import conversion-feedback toast (full-width top bar over #logoContainer)
  // by clicking a real button and waiting for it to leave — see dismissConversionFeedbackToast.
  // The previous inline "click Looks good if present right now" was a one-shot with no wait, so
  // it raced the async toast render and missed, leaving the bar to hang the next navigateToHome.
  await dismissConversionFeedbackToast(page);
  return { bookId };
}
