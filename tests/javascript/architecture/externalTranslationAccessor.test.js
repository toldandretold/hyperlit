/**
 * GUARDRAIL: "has a browser translator rewritten this page?" is asked ONLY
 * through utilities/externalTranslation.ts, and every DOM→IndexedDB content
 * write consults it.
 *
 * THE BUG THIS PREVENTS. Content-bearing writes in batch.ts are reachable in
 * plain READ mode with no auth gate — footnoteSelfHeal's render heal calls them
 * on every chunk render — and they flow on to IndexedDB and queueForSync. So a
 * reader with Chrome's translator on could have Google's output saved as the
 * book's real content. It would not even be detectable afterwards:
 * contentProcessor unwraps `<font>` tags on save ("browser artifacts from
 * execCommand") and Chrome's whole footprint inside a paragraph is
 * `<font style="vertical-align: inherit;">`, so the write LAUNDERS the
 * translation into clean, indistinguishable prose — after which the integrity
 * verifier reports DOM↔IDB agreement, because by then both sides are translated.
 *
 * TWO LAYERS, AND THE TEST GUARDS BOTH:
 *   - the PRECISE layer (this accessor) knows the vendor markers and is allowed
 *     to drive user-visible decisions — refuse edit mode, refuse an annotation.
 *     Marker knowledge is confined to one file so that widening it later (a new
 *     browser, a changed class name) is a one-file change rather than a hunt.
 *   - the BROAD layer (integrity/canonicalText's domMatchesStored) refuses any
 *     read-mode write whose text drifted from what is stored. It catches
 *     translators that leave no marker at all — Safari — and must NOT feed the
 *     accessor's latch, because render passes legitimately rewrite text (a chart
 *     node's <table> becomes an <svg>), so divergence is normal on a healthy
 *     book and latching on it would disable editing for every book with a chart.
 *
 * Runs in `npm run test:run` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.resolve(HERE, '../../..', 'resources/js');

const ACCESSOR = 'utilities/externalTranslation.ts';

/**
 * Vendor-specific markers. Confined to the accessor so there is exactly one
 * place to update when a browser changes its footprint.
 */
const VENDOR_MARKERS = ['translated-ltr', 'translated-rtl', '_msttexthash', '_msthash', 'goog-gt'];

/**
 * Every site that can derive node content from the live DOM, or that acts on a
 * DOM↔IDB comparison, must consult the accessor. A new write-back that forgets
 * the gate is then one failing test away.
 */
const REQUIRED_CONSUMERS = [
  // the write path itself (and its last-line-of-defence refusal)
  'indexedDB/nodes/batch.ts',
  // read-mode heals that feed it
  'lazyLoader/footnoteSelfHeal.ts',
  'footnotes/FootnoteNumberingService.ts',
  // offset-based annotation reprocessing (offsets don't survive translation)
  'hyperlights/deletion.ts',
  // write ENTRY points that must refuse up front rather than fail at the write
  'components/editButton/index.ts',
  'hyperlights/createHighlight.ts',
  'hyperlights/deleteHighlight.ts',
  // the DOM↔IDB comparison, and the operator action that re-saves every node
  'integrity/verifier.ts',
  'integrity/reporter.ts',
];

function walkSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'archive') continue;
      out.push(...walkSourceFiles(full));
    } else if (/\.(js|ts)$/.test(entry.name) && !/\.bak$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Lines that USE a token, ignoring prose mentions in comments. */
function codeLinesMentioning(source, token) {
  return source.split('\n').filter((line) => {
    if (!line.includes(token)) return false;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
    return true;
  });
}

describe('external-translation detection lives in one accessor', () => {
  it('no file outside the accessor hand-checks a vendor translation marker', () => {
    const offenders = [];
    for (const file of walkSourceFiles(JS_ROOT)) {
      const rel = path.relative(JS_ROOT, file).split(path.sep).join('/');
      if (rel === ACCESSOR) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const marker of VENDOR_MARKERS) {
        if (codeLinesMentioning(source, marker).length) offenders.push(`${rel} → ${marker}`);
      }
    }
    expect(
      offenders,
      'These files sniff for a browser translator themselves. Ask '
      + 'isExternallyTranslated() from resources/js/utilities/externalTranslation.ts instead — '
      + 'marker knowledge is deliberately confined to that one file so a browser changing '
      + 'its footprint is a one-file fix.\nOffenders:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('the accessor exists and is a ZERO-IMPORT leaf', () => {
    const full = path.join(JS_ROOT, ACCESSOR);
    expect(fs.existsSync(full), `${ACCESSOR} is missing`).toBe(true);

    const imports = codeLinesMentioning(fs.readFileSync(full, 'utf8'), 'import ');
    expect(
      imports,
      `${ACCESSOR} must not import anything. It is consulted from indexedDB/, lazyLoader/, `
      + 'divEditor/ and hyperlights/ — batch.ts ← footnoteSelfHeal ← chunkRender is already a '
      + 'dynamic-import dance to dodge a cycle, and an import here risks the circular-import '
      + `TDZ class.\nFound:\n  ${imports.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every DOM→IndexedDB write path consults the accessor', () => {
    const missing = [];
    for (const rel of REQUIRED_CONSUMERS) {
      const full = path.join(JS_ROOT, rel);
      if (!fs.existsSync(full)) {
        missing.push(`${rel} (file not found — stale list?)`);
        continue;
      }
      if (!/isExternallyTranslated/.test(fs.readFileSync(full, 'utf8'))) missing.push(rel);
    }
    expect(
      missing,
      'These files can derive book content from the live DOM (or act on a DOM↔IDB comparison) '
      + 'but never ask whether the DOM was rewritten by a browser translator. Add an '
      + 'isExternallyTranslated() guard.\nMissing:\n  ' + missing.join('\n  '),
    ).toEqual([]);
  });

  it('the canonical-text comparison is shared, not reimplemented per side', () => {
    // Both sides of the DOM↔IDB comparison must canonicalise identically, or the
    // comparison reports differences that are artifacts of which side you looked
    // at. The verifier and the heal gate therefore import the same leaf.
    const leaf = path.join(JS_ROOT, 'integrity/canonicalText.ts');
    expect(fs.existsSync(leaf), 'integrity/canonicalText.ts is missing').toBe(true);

    for (const rel of ['integrity/verifier.ts', 'indexedDB/nodes/batch.ts']) {
      const source = fs.readFileSync(path.join(JS_ROOT, rel), 'utf8');
      expect(source, `${rel} should use the shared canonicalText leaf`).toMatch(/canonicalText/);
    }

    // It is reached from indexedDB/ too, so it carries the same leaf constraint.
    const imports = codeLinesMentioning(fs.readFileSync(leaf, 'utf8'), 'import ');
    expect(imports, 'integrity/canonicalText.ts must stay a zero-import leaf').toEqual([]);
  });
});
