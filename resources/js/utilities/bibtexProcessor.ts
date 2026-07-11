import { getCurrentUserId } from "./auth/index";
import { log, verbose } from "./logger";

const CITATION_ARTICLE_TYPES = new Set(['article', 'journal-article', 'journal article', 'proceedings-article', 'conference-paper', 'paper']);
const CITATION_CHAPTER_TYPES = new Set(['incollection', 'book-chapter', 'chapter', 'book chapter']);

/**
 * Format a citation from plain metadata (title/author/year/journal/publisher/doi/type + optional
 * volume/issue/pages/booktitle/chapter/editor/url). The shared core behind formatBibtexToCitation,
 * and used directly to render a canonical_source's citation (from /best-version metadata) — e.g. the
 * clean "Verified by author" reference and the "could this be…" candidate lines in the citation card.
 * Pure + synchronous. `type` accepts BibTeX entry types (article/incollection/book) OR external ones
 * (journal-article/book-chapter). Author must already be resolved (no anonymisation here).
 */
export function formatMetadataToCitation(meta: any): string {
  const author = meta?.author || 'Unknown Author';
  const title = meta?.title || 'Untitled';
  const journal = meta?.journal || null;
  const publisher = meta?.publisher || null;
  const year = meta?.year ?? null;
  const pages = meta?.pages || null;
  const url = meta?.url || null;
  const volume = meta?.volume || null;
  const issue = meta?.issue || meta?.number || null;
  const booktitle = meta?.booktitle || null;
  const editor = meta?.editor || null;

  const entryType = String(meta?.type || 'misc').toLowerCase();
  const isArticle = CITATION_ARTICLE_TYPES.has(entryType);
  const isChapter = CITATION_CHAPTER_TYPES.has(entryType);

  // Title formatting: quotes for articles/chapters, italics for books.
  let formattedTitle = (isArticle || isChapter) ? `"${title}"` : `<i>${title}</i>`;
  const safeUrl = url && /^https?:\/\//i.test(url) ? url : null;
  if (safeUrl) {
    formattedTitle = `<a href="${safeUrl}" target="_blank">${formattedTitle}</a>`;
  }

  let citation = `${author}, ${formattedTitle}`;

  if (isChapter) {
    citation += ` in <i>${booktitle}</i>`;
    if (volume) {
      citation += `, vol. ${volume}`;
      if (issue) citation += `(${issue})`;
    }
    const parenthetical = [];
    if (editor) parenthetical.push(`ed. ${editor}`);
    if (publisher) parenthetical.push(publisher);
    if (year) parenthetical.push(year);
    if (parenthetical.length > 0) citation += ` (${parenthetical.join(', ')})`;
    if (pages) citation += `, ${pages}`;
  } else if (isArticle) {
    if (journal) citation += `, ${journal}`;
    if (volume) {
      citation += `, ${volume}`;
      if (issue) citation += `(${issue})`;
    }
    if (year) citation += ` (${year})`;
    if (pages) citation += `, ${pages}`;
  } else {
    if (publisher) {
      citation += ` (${publisher}`;
      if (year) citation += `, ${year}`;
      citation += `)`;
    } else if (year) {
      citation += ` (${year})`;
    }
    if (pages) citation += `, ${pages}`;
  }

  citation += ".";
  return citation;
}

/**
 * Converts a BibTeX entry into a formatted academic citation.
 * @param {string} bibtex - The BibTeX string.
 * @returns {Promise<string>} - The formatted citation.
 */
export async function formatBibtexToCitation(bibtex: any, preResolvedUserId = null) {
  // Helper to pull out all key = { value } or "value" pairs
  const parseBibtex = (bibtex: any) => {
    const fields: any = {};
    const fieldRegex = /(\w+)\s*=\s*[{"]([^"}]+)[}"]/g;
    let match: any;
    while ((match = fieldRegex.exec(bibtex)) !== null) {
      (fields as any)[match[1]!] = match[2];
    }
    return fields;
  };

  // Pull out all fields
  const fields = parseBibtex(bibtex);
  const rawAuthor = fields.author || "";
  const currentUserId = preResolvedUserId || await getCurrentUserId();

  // Decide what to show for author
  let author: any;
  if (rawAuthor === currentUserId && /^[0-9a-fA-F-]{36}$/.test(rawAuthor)) {
    // Anonymous user viewing their own work
    author = "Anon (me)";
  } else if (/^[0-9a-fA-F-]{36}$/.test(rawAuthor)) {
    // Someone else's anonymous work
    author = "Anon";
  } else {
    // Real username or unknown
    author = rawAuthor || "Unknown Author";
  }

  // Parse the declared entry type from the BibTeX string (e.g. @article, @incollection)
  const typeMatch = bibtex.match(/@(\w+)\s*\{/);
  const entryType = typeMatch ? typeMatch[1].toLowerCase() : 'misc';

  // Delegate the actual formatting to the shared metadata formatter (author already resolved above;
  // BibTeX uses "number" for issue, and keeps the "Unknown Year" fallback for missing years).
  return formatMetadataToCitation({
    author,
    title: fields.title || "Untitled",
    journal: fields.journal || null,
    publisher: fields.publisher || null,
    year: fields.year || "Unknown Year",
    pages: fields.pages || null,
    url: fields.url || null,
    volume: fields.volume || null,
    issue: fields.number || null,
    booktitle: fields.booktitle || null,
    editor: fields.editor || null,
    type: entryType,
  });
}



export function generateBibtexFromForm(data: any) {
  // Use the book ID as the citation key (book is the primary key)
  const citationID = data.book && data.book.trim() !== ''
    ? data.book.trim()
    : 'citation' + Date.now();

  // Use the type or default to misc
  const type = data.type || 'misc';

  // Helper to escape special characters in BibTeX fields
  function escapeBibtex(value: any) {
    if (!value) return '';
    return value.replace(/[{}]/g, '\\$&'); // escape braces
  }

  // Define which fields are relevant for each BibTeX type
  const typeFields = {
    article:       ['author', 'title', 'journal', 'year', 'volume', 'issue', 'pages', 'url', 'note'],
    book:          ['author', 'title', 'publisher', 'year', 'pages', 'url', 'note'],
    incollection:  ['author', 'title', 'booktitle', 'editor', 'publisher', 'year', 'chapter', 'volume', 'issue', 'pages', 'url', 'note'],
    phdthesis:     ['author', 'title', 'school', 'year', 'url', 'note'],
    misc:          ['author', 'title', 'year', 'url', 'note'],
  };
  const allowedFields = (typeFields as any)[type] || typeFields.misc;

  // Map from form field names to BibTeX field names
  const bibtexFieldName = (field: any) => field === 'issue' ? 'number' : field;

  // Build the BibTeX entry lines — only include fields relevant to the type
  let bibtexLines = [`@${type}{${citationID},`];

  for (const field of allowedFields) {
    if (data[field]) {
      bibtexLines.push(`  ${bibtexFieldName(field)} = {${escapeBibtex(data[field])}},`);
    }
  }

  // Remove trailing comma from last field
  if (bibtexLines.length > 1) {
    const lastIndex = bibtexLines.length - 1;
    bibtexLines[lastIndex] = bibtexLines[lastIndex]!.replace(/,$/, '');
  }

  bibtexLines.push('}');
  const generatedBibtex = bibtexLines.join('\n');
  return generatedBibtex;
}

export function buildBibtexEntry({ book, title, author }: any) {
  // Use book ID as citation key (book is the primary key)
  // Here we store the *raw* author ID field in the bibtex.
  return `@book{${book},
  author = {${author}},
  title  = {${title}},
  year   = {${new Date().getFullYear()}},
}`;
}

/**
 * Build a shareable citation for a book: human-readable HTML + plain text,
 * with the Hyperlit URL embedded and appended.
 * Tries IndexedDB first, falls back to server API, then builds a minimal entry.
 * Has no clipboard side effects — call this ahead of time and pass the result
 * to copyCitationToClipboard from inside a synchronous user-gesture handler.
 * @param {string} bookId - The book identifier
 * @returns {Promise<{html: string, text: string, url: string, bibtex: string}>}
 */
export async function prepareCitationShare(bookId: any) {
  const url = window.location.origin + '/' + bookId;
  let record: any = null;

  try {
    const { getLibraryObjectFromIndexedDB } = await import('../indexedDB/core/library');
    record = await getLibraryObjectFromIndexedDB(bookId);
  } catch (_) {}

  if (!record) {
    try {
      const { getLibraryRecordFromServer } = await import('../indexedDB/core/library');
      record = await getLibraryRecordFromServer(bookId);
    } catch (_) {}
  }

  let bibtex: any;
  if (record?.bibtex) {
    bibtex = record.bibtex.replace(/\}\s*$/, `  url    = {${url}}\n}`);
  } else {
    const author = record?.author || 'Unknown';
    const title = record?.title || bookId;
    const year = record?.year || '';
    const type = record?.type || 'misc';

    let fields = `  author = {${author}},\n  title  = {${title}},\n`;
    if (year) fields += `  year   = {${year}},\n`;
    if (record?.publisher) fields += `  publisher = {${record.publisher}},\n`;
    if (record?.journal) fields += `  journal = {${record.journal}},\n`;
    fields += `  url    = {${url}}\n`;

    bibtex = `@${type}{${bookId},\n${fields}}`;
  }

  const citationHtml = await formatBibtexToCitation(bibtex);

  const tmp = document.createElement('div');
  tmp.innerHTML = citationHtml;
  const citationText = (tmp.textContent || tmp.innerText || '').trim();

  const html = `${citationHtml}<br><a href="${url}">${url}</a>`;
  const text = `${citationText}\n${url}`;

  return { html, text, url, bibtex };
}

/**
 * Synchronously copy a prepared citation to the clipboard.
 * Multi-method to survive the strictest user-activation rules (Safari):
 *   1) contentEditable div + execCommand('copy') — preserves HTML formatting
 *   2) navigator.clipboard.write([ClipboardItem(...)]) — fire-and-forget
 *   3) textarea + execCommand('copy') — plain-text fallback
 * Pattern mirrors resources/js/hypercites/copy.js.
 * Must be called from inside a user gesture (no awaits between click and call).
 * @param {{html: string, text: string}} payload
 * @returns {boolean} true if at least one method reported success
 */
export function copyCitationToClipboard({ html, text }: any) {
  const sel: any = window.getSelection();
  const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

  let success = false;

  try {
    const tempDiv = document.createElement('div');
    tempDiv.contentEditable = 'true';
    tempDiv.innerHTML = html;
    tempDiv.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none;';
    document.body.appendChild(tempDiv);
    tempDiv.focus();

    const range = document.createRange();
    range.selectNodeContents(tempDiv);
    sel.removeAllRanges();
    sel.addRange(range);

    success = document.execCommand('copy');
    document.body.removeChild(tempDiv);
  } catch (err) {
    verbose.content('contentEditable copy failed, trying fallback', '/utilities/bibtexProcessor.ts', err);
  }

  if (!success && navigator.clipboard && window.ClipboardItem) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      navigator.clipboard.write([item]).catch(err => log.error('Modern clipboard write failed', '/utilities/bibtexProcessor.ts', err));
      success = true;
    } catch (err) {
      verbose.content('ClipboardItem setup failed, trying fallback', '/utilities/bibtexProcessor.ts', err);
    }
  }

  if (!success) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:absolute;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      success = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (err) {
      log.error('Plain-text fallback failed', '/utilities/bibtexProcessor.ts', err);
    }
  }

  if (savedRange) {
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }

  return success;
}
