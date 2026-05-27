/**
 * Footnote-heavy source fixtures for the integrity reproduction harness.
 *
 * Generates deterministic markdown with predictable footnote counts and
 * positions, so divergence between stored content / node.footnotes / map
 * shows up cleanly in diffs.
 *
 * Footnote shape: `[^N]` inline reference plus `[^N]: definition` block.
 * This is the standard pandoc-style footnote the importer consumes.
 */

import { importMarkdownBook } from './bookContent.js';

const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
];

function words(n, offset = 0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(LOREM[(i + offset) % LOREM.length]);
  return out.join(' ');
}

/**
 * Build markdown with `chapters` × `paragraphsPerChapter` paragraphs, sprinkling
 * footnote references throughout. Footnote density is controlled by
 * `footnotesPerChapter`. Each footnote ref gets a matching `[^N]: ...` definition
 * at the end of the document.
 *
 * Anchor format `ANCHORcCpPnK` for paragraphs / `FNK` for footnote definitions
 * — text-content stable for selector queries.
 *
 * Returns { markdown, footnoteCount, totalParagraphs }.
 */
export function generateFootnoteHeavyMarkdown({
  title = 'Footnote Stress Test',
  chapters = 5,
  paragraphsPerChapter = 6,
  wordsPerParagraph = 50,
  footnotesPerChapter = 4,          // 4 × 5 = 20 footnotes total by default
  footnotePlacement = 'distributed', // 'distributed' | 'frontloaded' | 'backloaded'
} = {}) {
  const lines = [`# ${title}`, ''];
  let fnCounter = 1;
  const fnIds = [];

  for (let c = 1; c <= chapters; c++) {
    lines.push(`# Chapter ${c}`);
    lines.push('');

    // Decide which paragraphs in this chapter get a footnote
    const fnParagraphs = pickParagraphsForFootnotes(
      paragraphsPerChapter,
      footnotesPerChapter,
      footnotePlacement,
    );

    for (let p = 1; p <= paragraphsPerChapter; p++) {
      const anchor = `ANCHORc${c}p${p}`;
      let para = `${anchor} ${words(wordsPerParagraph, c * p)}`;

      // Append footnote refs to flagged paragraphs
      const refsForThisPara = fnParagraphs.filter(x => x === p).length;
      for (let r = 0; r < refsForThisPara; r++) {
        para += `[^${fnCounter}]`;
        fnIds.push(fnCounter);
        fnCounter++;
      }
      para += '.';
      lines.push(para);
      lines.push('');
    }
  }

  // Footnote definitions at the end (pandoc convention)
  if (fnIds.length) {
    lines.push('');
    for (const id of fnIds) {
      lines.push(`[^${id}]: Footnote ${id} body — ${words(12, id)}.`);
      lines.push('');
    }
  }

  return {
    markdown: lines.join('\n'),
    footnoteCount: fnIds.length,
    totalParagraphs: chapters * paragraphsPerChapter,
  };
}

function pickParagraphsForFootnotes(paragraphsPerChapter, count, placement) {
  if (count <= 0) return [];
  if (placement === 'frontloaded') {
    // Pack into the first few paragraphs
    return Array.from({ length: count }, (_, i) => (i % paragraphsPerChapter) + 1);
  }
  if (placement === 'backloaded') {
    return Array.from({ length: count }, (_, i) =>
      paragraphsPerChapter - (i % paragraphsPerChapter)
    );
  }
  // 'distributed' — evenly space across the chapter
  const step = Math.max(1, Math.floor(paragraphsPerChapter / count));
  return Array.from({ length: count }, (_, i) => Math.min(paragraphsPerChapter, 1 + i * step));
}

/**
 * Drop a generated footnote-heavy markdown into the homepage import flow and
 * wait for the reader to land. Wrapper around `importMarkdownBook`.
 *
 * Returns { bookId, footnoteCount, markdown } so the test can sanity-check
 * that the importer landed all expected footnotes.
 */
export async function importFootnoteHeavyBook(page, spa, opts = {}) {
  const { markdown, footnoteCount } = generateFootnoteHeavyMarkdown(opts);
  const name = opts.name || `footnote_stress_${Date.now()}.md`;
  const { bookId } = await importMarkdownBook(page, spa, {
    name,
    content: markdown,
  });
  return { bookId, footnoteCount, markdown };
}
