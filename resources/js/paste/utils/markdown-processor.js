/**
 * Markdown Processing Utility
 * Processes large markdown content in chunks to prevent UI blocking
 *
 * Features:
 * - Splits markdown on paragraph boundaries
 * - Processes in configurable chunk sizes (default 50KB)
 * - Progress callbacks for UI updates
 * - Async processing with browser breathing room
 */

import { marked } from 'marked';

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
