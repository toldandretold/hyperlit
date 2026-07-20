/**
 * Text Normalization Utilities
 * Handles smart quotes, nbsp, whitespace normalization
 */

/**
 * Normalize smart quotes and backticks to regular quotes
 * @param {string} text - Text to normalize
 * @returns {string} - Normalized text
 */
export function normalizeQuotes(text: any) {
  if (!text) return text;

  // NOTE: these regexes match the actual smart-quote codepoints (U+2018/2019/201C/201D).
  // They were previously mangled to plain ASCII quotes — turning every replace into a
  // no-op and silently breaking quote normalization — so guard them in tests below.
  return text
    .replace(/‘/g, "'")  // Smart single quote (left)
    .replace(/’/g, "'")  // Smart single quote (right)
    .replace(/“/g, '"')  // Smart double quote (left)
    .replace(/”/g, '"')  // Smart double quote (right)
    .replace(/`/g, "'");      // Backticks to regular single quotes
}

/**
 * Normalize non-breaking spaces and Apple-converted spaces
 * @param {string} html - HTML content to normalize
 * @returns {string} - Normalized HTML
 */
export function normalizeSpaces(html: any) {
  if (!html) return html;

  return html
    .replace(/<span class="Apple-converted-space">\s*&nbsp;\s*<\/span>/g, ' ')
    .replace(/<span class="Apple-converted-space">\s*<\/span>/g, ' ')
    // Double-escaped / space-corrupted nbsp that arrives as visible text
    // (source pages with a broken &nbsp; serialize to "&amp; nbsp;" on paste).
    .replace(/&amp;\s*nbsp;/gi, ' ')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Full normalization pipeline for pasted content
 * @param {string} text - Content to normalize
 * @param {boolean} isHtml - Whether content is HTML
 * @returns {string} - Fully normalized content
 */
export function normalizeContent(text: any, isHtml = false) {
  if (!text) return text;

  let normalized = normalizeQuotes(text);

  if (isHtml) {
    normalized = normalizeSpaces(normalized);
  }

  return normalized;
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - HTML-escaped text
 */
export function escapeHtml(text: any) {
  if (!text) return text;

  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Strip <mark> tags from HTML while preserving their text content.
 * Mark tags should NEVER become top-level nodes - they are inline highlights only.
 * When pasting highlighted text, we want to keep the text but remove the highlight styling.
 *
 * @param {string} html - HTML content that may contain mark tags
 * @returns {string} - HTML with mark tags replaced by their text content
 */
export function stripMarkTags(html: any) {
  if (!html) return html;

  // Use regex to replace <mark> tags with their content
  // This handles both <mark>text</mark> and <mark id="...">text</mark> forms
  return html.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '$1');
}

/**
 * Strip <u> hypercite tags from HTML while preserving their inner content.
 *
 * In this app `<u>` is NOT a user underline format — it is exclusively the
 * render-time wrapper for a hypercite (created in lazyLoader/chunkRender.ts,
 * carrying id="hypercite_…" / class="couple|poly|single" / data-overlapping /
 * data-hypercite-listener). It is never part of a node's stored content. So a
 * `<u>` arriving through the clipboard is always orphaned annotation markup from
 * wherever the text was copied — pasting it bakes a dead hypercite underline
 * (and its stale, cross-book data-* attributes) into this book's node. Unwrap it
 * to keep the text and drop the wrapper, exactly as stripMarkTags does for
 * highlights. The deliberate "paste a quote to make a hypercite" flow reads the
 * pristine clipboard copy, so it is unaffected by this strip.
 *
 * @param {string} html - HTML content that may contain hypercite <u> tags
 * @returns {string} - HTML with <u> tags replaced by their inner content
 */
export function stripHyperciteTags(html: string): string {
  if (!html) return html;

  // Non-greedy, matches <u>text</u> and <u id="…" data-overlapping="…">text</u>.
  // Hypercites never nest (overlaps render as one <u data-overlapping="a,b">),
  // so a single pass is sufficient — same idiom as stripMarkTags.
  return html.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, '$1');
}

/**
 * Convert definition list tags (<dl>, <dt>, <dd>) to paragraphs.
 * Definition lists are used by some publishers for author names, metadata, etc.
 * They're not supported in the editor, so convert <dt>/<dd> to <p> and strip <dl> wrappers.
 *
 * @param {string} html - HTML content that may contain definition list tags
 * @returns {string} - HTML with definition list tags converted to paragraphs
 */
export function convertDefinitionListTags(html: any) {
  if (!html) return html;

  return html
    .replace(/<dt[^>]*>([\s\S]*?)<\/dt>/gi, '<p>$1</p>')
    .replace(/<dd[^>]*>([\s\S]*?)<\/dd>/gi, '<p>$1</p>')
    .replace(/<\/?dl[^>]*>/gi, '');
}

/**
 * Strip <p> wrappers from inside <li> elements.
 * marked produces <li><p>text</p></li> but our editor uses <li>text</li>.
 *
 * @param {string} html - HTML content that may contain <p> inside <li>
 * @returns {string} - HTML with <p> unwrapped inside list items
 */
export function normalizeListItems(html: any) {
  if (!html || (!html.includes('<li>') && !html.includes('<li '))) return html;
  const temp = document.createElement('div');
  temp.innerHTML = html;
  temp.querySelectorAll('li > p').forEach((p: any) => {
    const li = p.parentElement;
    while (p.firstChild) {
      li.insertBefore(p.firstChild, p);
    }
    p.remove();
  });
  return temp.innerHTML;
}
