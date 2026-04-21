/**
 * Emergency Backup — shared functions for generating backup markdown files.
 *
 * Used by:
 *  - integrity/reporter.js (modal "Download emergency backup" button)
 *  - components/sourceButton.js (blackBox folder in raw zip download)
 */

import { isIDBBroken } from '../indexedDB/core/healthMonitor.js';

// ================================================================
// HTML → Markdown converter
// ================================================================

/**
 * Zero-dependency HTML-to-Markdown converter using DOMParser.
 * Handles common elements; not a full spec implementation.
 */
export function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return mdWalk(doc.body).replace(/\n{3,}/g, '\n\n').trim();
}

export function mdWalk(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();
  const kids = Array.from(node.childNodes).map(mdWalk).join('');

  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = parseInt(tag[1]);
      return `\n\n${'#'.repeat(level)} ${kids.trim()}\n\n`;
    }
    case 'blockquote':
      return '\n\n' + kids.trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    case 'pre': {
      const codeEl = node.querySelector('code');
      const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
      return `\n\n\`\`\`${lang}\n${(codeEl || node).textContent}\n\`\`\`\n\n`;
    }
    case 'code':
      return node.parentElement?.tagName.toLowerCase() === 'pre' ? kids : `\`${kids}\``;
    case 'ul': case 'ol':
      return '\n\n' + kids + '\n';
    case 'li': {
      const parent = node.parentElement?.tagName.toLowerCase();
      const prefix = parent === 'ol'
        ? `${Array.from(node.parentElement.children).indexOf(node) + 1}. `
        : '- ';
      return `${prefix}${kids.trim()}\n`;
    }
    case 'strong': case 'b': return `**${kids}**`;
    case 'em': case 'i': return `*${kids}*`;
    case 'a': return `[${kids}](${node.getAttribute('href') || ''})`;
    case 'img': return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
    case 'br': return '\n';
    case 'hr': return '\n\n---\n\n';
    case 'p': case 'div': return `\n\n${kids.trim()}\n\n`;
    default: return kids;
  }
}

// ================================================================
// Backup builders
// ================================================================

/**
 * Scrape visible DOM content for a book.
 * Returns { markdown, nodeMap } where nodeMap is Map<id, md> for stitching.
 */
export function buildBrowserMd(bookId) {
  const container = document.querySelector(`[data-book-id="${bookId}"]`)
    || document.getElementById(bookId);
  if (!container) return null;

  const nodeEls = [];
  container.querySelectorAll('[id]').forEach(el => {
    if (/^\d+(\.\d+)?$/.test(el.id)) nodeEls.push(el);
  });
  if (nodeEls.length === 0) return null;

  const nodeMap = new Map();
  const parts = [];
  for (const el of nodeEls) {
    const md = htmlToMarkdown(el.outerHTML);
    nodeMap.set(el.id, md);
    parts.push(md);
  }

  return { markdown: parts.join('\n\n'), nodeMap };
}

/**
 * Read full book from IndexedDB.
 * Returns { markdown, nodeMap } or null if IDB broken/timeout.
 */
export async function buildBrowserDatabaseMd(bookId) {
  if (isIDBBroken()) return null;
  try {
    return await Promise.race([
      (async () => {
        const { getNodeChunksFromIndexedDB } = await import('../indexedDB/nodes/read.js');
        const chunks = await getNodeChunksFromIndexedDB(bookId);
        chunks.sort((a, b) => a.chunk_id - b.chunk_id || a.startLine - b.startLine);

        const nodeMap = new Map();
        const parts = [];
        for (const chunk of chunks) {
          if (!chunk.content) continue;
          const md = htmlToMarkdown(chunk.content);
          nodeMap.set(String(chunk.startLine), md);
          parts.push(md);
        }
        return { markdown: parts.join('\n\n'), nodeMap };
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('IDB timeout')), 5000)),
    ]);
  } catch (e) {
    console.warn('[integrity] Failed to read IDB for backup:', e);
    return null;
  }
}

/**
 * Fetch full book from server API.
 * Returns markdown string or null on failure/timeout.
 */
export async function buildServerDatabaseMd(bookId) {
  try {
    return await Promise.race([
      (async () => {
        const slashIdx = bookId.indexOf('/');
        const url = slashIdx !== -1
          ? `/api/database-to-indexeddb/books/${bookId.substring(0, slashIdx)}/${bookId.substring(slashIdx + 1)}/data`
          : `/api/database-to-indexeddb/books/${bookId}/data`;

        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) return null;
        const data = await resp.json();

        const nodes = data.nodes || [];
        nodes.sort((a, b) => a.chunk_id - b.chunk_id || a.startLine - b.startLine);

        const parts = [];
        for (const node of nodes) {
          if (!node.content) continue;
          parts.push(htmlToMarkdown(node.content));
        }
        return parts.join('\n\n');
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Server timeout')), 8000)),
    ]);
  } catch (e) {
    console.warn('[integrity] Failed to fetch server data for backup:', e);
    return null;
  }
}

/**
 * Merge IDB (complete) with DOM (freshest visible).
 * For every node in IDB, if the DOM has it too, use the DOM version.
 */
export function buildStitchedUpMd(idbNodeMap, domNodeMap) {
  if (!idbNodeMap) return null;

  const merged = new Map(idbNodeMap);
  if (domNodeMap) {
    for (const [id, md] of domNodeMap) {
      if (merged.has(id)) {
        merged.set(id, md);
      }
    }
  }

  const sorted = [...merged.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
  return sorted.map(([, md]) => md).join('\n\n');
}

/**
 * Generate a README explaining each file in the backup.
 */
export function buildReadme(bookId, available) {
  const timestamp = new Date().toISOString();
  const lines = [
    `# Emergency Backup — ${bookId}`,
    `Exported: ${timestamp}`,
    '',
    '## Files',
    '',
  ];

  const descriptions = {
    'browser.md': [
      '### browser.md',
      'Content scraped directly from your editor (DOM). This reflects your most',
      'recent edits but may be incomplete due to lazy loading — only the chunks',
      'you scrolled to are included.',
    ],
    'browserDatabase.md': [
      '### browserDatabase.md',
      "Content from your browser's local database (IndexedDB). This is the full",
      "book as your browser last saved it. If some edits weren't saved, they",
      "won't appear here.",
    ],
    'serverDatabase.md': [
      '### serverDatabase.md',
      'Content from the server database (PostgreSQL). This is the last version that was',
      'successfully synced to the cloud.',
    ],
    'stitchedUp.md': [
      '### stitchedUp.md',
      'A "best of both worlds" merge: the full book from your browser database,',
      'but updated with anything from the browser that might not have synced.',
      'This is likely the most complete and up-to-date copy.',
    ],
  };

  for (const [file, desc] of Object.entries(descriptions)) {
    if (available[file]) {
      lines.push(...desc);
    } else {
      lines.push(`### ${file}`);
      lines.push('Could not be generated.');
    }
    lines.push('');
  }

  lines.push(
    '## Which file should I use?',
    'Start with stitchedUp.md — it has the most complete, freshest content.',
    'If it seems wrong, compare browser.md (your latest visible edits) with',
    'browserDatabase.md (full saved copy) to find what you need.',
  );

  return lines.join('\n');
}

/**
 * Generate a top-level README for the download-all zip.
 * Inspects the JSZip instance to determine which folders are present.
 */
export function buildTopLevelReadme(bookId, zip) {
  const timestamp = new Date().toISOString();
  const prefix = bookId + '/';

  // Detect what's in the zip
  const hasPostgresql = !!zip.file(new RegExp('^' + escapeRegExp(prefix) + 'postgresql_data/'));
  const hasOriginalFiles = !!zip.file(new RegExp('^' + escapeRegExp(prefix) + 'original_files/'));
  const hasBlackBox = !!zip.file(new RegExp('^' + escapeRegExp(prefix) + 'blackBox/'));

  // Detect source file type
  let sourceType = null;
  if (hasOriginalFiles) {
    if (zip.file(new RegExp('^' + escapeRegExp(prefix) + 'original_files/.*\\.pdf$', 'i'))) {
      sourceType = 'PDF';
    } else if (zip.file(new RegExp('^' + escapeRegExp(prefix) + 'original_files/.*\\.epub$', 'i'))) {
      sourceType = 'EPUB';
    }
  }

  const lines = [
    `# ${bookId} — Complete Export`,
    `Exported: ${timestamp}`,
    '',
    '## Overview',
    'This folder contains the complete data for this book in markdown and JSON.',
    '',
  ];

  if (hasPostgresql) {
    lines.push(
      '## `postgresql_data/`',
      'Server-side data exported as JSON. Contains:',
      '- **nodes** — the book\'s content (HTML nodes)',
      '- **footnotes** — footnote content linked to nodes',
      '- **hypercites** — cross-references between books',
      '- **hyperlights** — sub-books embedded within the text',
      '- **highlights** — user highlights and annotations',
      '- **bibliography** — bibliographic entries',
      '',
    );
  }

  if (hasOriginalFiles) {
    lines.push(
      '## `original_files/`',
      `Contains the original source file (${sourceType || 'PDF/EPUB'}) and all intermediate`,
      'conversion artifacts. These can be used locally to re-run or modify the conversion.',
      '',
    );
  }

  if (hasBlackBox) {
    lines.push(
      '## `blackBox/`',
      'Browser-side backup snapshots. See `blackBox/README.md` for details on these files.',
      '',
    );
  }

  if (hasOriginalFiles) {
    lines.push(
      '## Conversion scripts',
      'If you want to reconvert or modify the pipeline, these scripts and the original',
      'source file in `original_files/` are everything you need:',
      '',
    );
    if (sourceType === 'PDF') {
      lines.push('- `app/Python/mistral_ocr.py` — PDF → markdown via Mistral OCR');
    } else if (sourceType === 'EPUB') {
      lines.push(
        '- `app/Python/epub_processor.py` / `epub_normalizer.py` — EPUB → HTML',
      );
    } else {
      lines.push(
        '- `app/Python/mistral_ocr.py` — PDF → markdown via Mistral OCR',
        '- `app/Python/epub_processor.py` / `epub_normalizer.py` — EPUB → HTML',
      );
    }
    lines.push(
      '- `app/Python/process_document.py` — HTML post-processing & sanitisation',
      '- `app/Http/Controllers/ConversionController.php` — markdown ↔ HTML + highlight position tracking',
      '',
    );
  }

  return lines.join('\n');
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
