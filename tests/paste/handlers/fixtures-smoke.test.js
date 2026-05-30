/**
 * Per-fixture baselines for the paste format-detection + processor pipeline.
 *
 * Each real clipboard payload in tests/paste/fixtures/clipboard/ has an
 * expected (format, footnotes, references) tuple captured from the current
 * implementation. The test fails if:
 *
 *   - The detected format changes (regression in format-detector)
 *   - Footnote or reference extraction counts drift (regression in a processor)
 *
 * Entries marked KNOWN BUG document current broken behaviour — once the
 * underlying processor bug is fixed, update the entry to the new healthy
 * count. The test will then fail until the number is bumped, which forces
 * the fix and the assertion to be updated together.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFormat, getProcessorForContent } from '../../../resources/js/paste/format-detection/format-detector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'clipboard');

/**
 * Baseline expectations per fixture. `footnotes` / `references` are exact
 * counts the current pipeline produces. Update them deliberately when a
 * processor improves.
 */
const BASELINES = [
  {
    // NOTE: filename has typo on disk ("cambrdidge"). Kept as-is to match the
    // checked-in fixture; rename in a focused commit if you want to fix it.
    file: 'cambrdidge-authordate.html',
    format: 'cambridge',
    footnotes: 0, // Author-date articles have no footnotes by definition.
    references: 32, // CSL-spans inside reference-N-content divs.
  },
  {
    file: 'cambridge-footnotes.html',
    format: 'cambridge',
    footnotes: 147,
    references: 0, // This article uses footnote-style citations only; no separate bibliography section. 0 is correct.
  },
  {
    file: 'oxford.html',
    format: 'oup',
    footnotes: 4,
    references: 126,
  },
  {
    file: 'sage1.html',
    format: 'sage',
    footnotes: 144, // role="paragraph" footnote definitions
    references: 0, // this article has no separate bibliography (footnote-only article)
  },
  {
    file: 'sage2.html',
    format: 'sage',
    footnotes: 5,
    references: 65,
  },
  {
    file: 'sciencedirect.html',
    format: 'science-direct',
    footnotes: 0, // ScienceDirect uses inline references, no footnotes
    references: 88, // matches the 88 span.reference[id] elements exactly
  },
  {
    file: 'springer-authoerdate.html',
    format: 'springer',
    footnotes: 0,
    references: 78, // matches the 78 id="ref-CR..." IDs (ref-CR1..ref-CR78) exactly
  },
  {
    file: 'springer-footnotes.html',
    format: 'springer',
    footnotes: 142, // matches the 142 id="Fn..." anchors exactly
    references: 69,
  },
  {
    file: 'taylorandfrancis.html',
    format: 'taylor-francis',
    footnotes: 1, // article legitimately has only one EN0001 endnote
    references: 66, // matches the 66 li[id^="CIT"] items exactly
  },
];

describe('clipboard fixtures — baselines', () => {
  for (const baseline of BASELINES) {
    describe(baseline.file, () => {
      const html = readFileSync(join(FIXTURE_DIR, baseline.file), 'utf8');

      it(`detects format as "${baseline.format}"`, () => {
        expect(detectFormat(html)).toBe(baseline.format);
      });

      it(`extracts ${baseline.footnotes ?? '?'} footnote(s) and ${baseline.references ?? '?'} reference(s)`, async () => {
        // Use the same routing production uses, so smoke results reflect what
        // a real paste of this fixture would produce — not what GeneralProcessor
        // happens to extract from format-specific markup.
        const { processor } = getProcessorForContent(html);
        const result = await processor.process(html, 'fixtureBook');

        // Always print the observed counts so unbaselined fixtures (null) can be
        // backfilled by reading the output.
        // eslint-disable-next-line no-console
        console.log(
          `OBSERVED  ${baseline.file.padEnd(60)} ` +
          `footnotes=${String(result.footnotes.length).padStart(3)} ` +
          `references=${String(result.references.length).padStart(3)}`,
        );

        if (baseline.footnotes !== null) {
          expect(result.footnotes.length).toBe(baseline.footnotes);
        }
        if (baseline.references !== null) {
          expect(result.references.length).toBe(baseline.references);
        }
        expect(result.html.length).toBeGreaterThan(0);
      });
    });
  }
});
