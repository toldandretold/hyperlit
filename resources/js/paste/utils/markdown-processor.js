/**
 * Markdown Processing Utility
 * Processes large markdown content in chunks to prevent UI blocking
 *
 * Features:
 * - Pre-processes [^N] footnotes before marked conversion (marked v15 doesn't support them)
 * - Splits markdown on paragraph boundaries
 * - Processes in configurable chunk sizes (default 50KB)
 * - Progress callbacks for UI updates
 * - Async processing with browser breathing room
 */

import { marked } from 'marked';

/**
 * Pre-process markdown footnotes before passing to marked.
 * marked v15 doesn't support [^N] footnote syntax - it treats [^N]: as link reference
 * definitions, which causes footnote definitions to disappear and [^N] refs to become
 * broken <a> links instead of <sup> tags.
 *
 * This function:
 * 1. Extracts [^N]: definition blocks from the source text
 * 2. Replaces [^N] inline references with <sup>N</sup> (preserved by marked as inline HTML)
 * 3. Returns the cleaned text + extracted definitions to be appended after conversion
 *
 * @param {string} text - Raw markdown text
 * @returns {{text: string, footnoteDefinitions: Array<{identifier: string, content: string}>}}
 */
export function preprocessMarkdownFootnotes(text) {
  const footnoteDefinitions = [];
  const definitionPattern = /^\[\^(\d+)\]:\s*(.+)$/gm;

  // First pass: find all footnote definitions and their positions
  let match;
  const defRanges = [];

  while ((match = definitionPattern.exec(text)) !== null) {
    const identifier = match[1];
    let content = match[2].trim();
    const startIndex = match.index;
    let endIndex = match.index + match[0].length;

    // Check for continuation lines (indented with 4+ spaces or tab)
    const remainingText = text.substring(endIndex);
    const continuationMatch = remainingText.match(/^(\n(?:[ \t]{4,}|\t).+)+/);
    if (continuationMatch) {
      content += ' ' + continuationMatch[0].trim().replace(/\n\s+/g, ' ');
      endIndex += continuationMatch[0].length;
    }

    footnoteDefinitions.push({ identifier, content });
    defRanges.push({ start: startIndex, end: endIndex });
  }

  if (footnoteDefinitions.length === 0) {
    return { text, footnoteDefinitions: [] };
  }

  // Build a set of defined footnote identifiers for reference replacement
  const definedIds = new Set(footnoteDefinitions.map(d => d.identifier));

  // Remove definitions from text (process in reverse to maintain indices)
  let processedText = text;
  for (let i = defRanges.length - 1; i >= 0; i--) {
    const range = defRanges[i];
    processedText = processedText.substring(0, range.start) + processedText.substring(range.end);
  }

  // Replace [^N] references with <sup>N</sup> (inline HTML that marked preserves)
  processedText = processedText.replace(/\[\^(\d+)\]/g, (fullMatch, num) => {
    if (definedIds.has(num)) {
      return `<sup>${num}</sup>`;
    }
    return fullMatch; // Leave as-is if no definition exists
  });

  // Clean up extra blank lines from removed definitions
  processedText = processedText.replace(/\n{3,}/g, '\n\n');

  console.log(`  - Pre-processed ${footnoteDefinitions.length} markdown footnotes`);

  return { text: processedText, footnoteDefinitions };
}

/**
 * Convert extracted footnote definitions to HTML paragraphs.
 * These are appended after the marked-converted HTML so the general processor
 * can find them via the [^N]: regex pattern in extractFootnotes().
 *
 * @param {Array<{identifier: string, content: string}>} definitions
 * @returns {string} HTML string with footnote definition paragraphs
 */
export function footnoteDefinitionsToHtml(definitions) {
  if (!definitions || definitions.length === 0) return '';

  return definitions.map(def =>
    `<p>[^${def.identifier}]: ${def.content}</p>`
  ).join('\n');
}

/**
 * Process large markdown content in chunks
 * Prevents UI blocking on large pastes by processing incrementally
 *
 * @param {string} text - Markdown text to process
 * @param {Function} onProgress - Progress callback (percent, current, total)
 * @returns {Promise<string>} - HTML result
 */
export async function processMarkdownInChunks(text, onProgress) {
  const chunkSize = 50000; // 50KB chunks - adjust as needed
  const chunks = [];

  // Split on paragraph boundaries to avoid breaking markdown structure
  const paragraphs = text.split(/\n\s*\n/);
  let currentChunk = '';

  for (const para of paragraphs) {
    if (currentChunk.length + para.length > chunkSize && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  console.log(`Processing ${chunks.length} chunks, average size: ${Math.round(text.length / chunks.length)} chars`);

  let result = '';
  for (let i = 0; i < chunks.length; i++) {
    const progress = ((i + 1) / chunks.length) * 100;
    onProgress(progress, i + 1, chunks.length);

    // Process chunk (smart quotes already normalized at paste entry)
    const chunkHtml = marked(chunks[i]);
    result += chunkHtml;

    // Let browser breathe between chunks
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  return result;
}
