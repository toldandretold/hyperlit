/**
 * Per-fixture baselines for the paste format-detection + processor pipeline.
 *
 * Each real clipboard payload in tests/paste/fixtures/clipboard/ has an
 * expected (format, footnotes, references, inTextCitations, footnoteMarkers)
 * tuple captured from the current implementation. The test fails if:
 *
 *   - The detected format changes (regression in format-detector)
 *   - Footnote or reference extraction counts drift (regression in a processor)
 *   - The APP-NATIVE LINKED OUTPUT drifts: inTextCitations counts
 *     <a class="in-text-citation"> anchors and footnoteMarkers counts
 *     <sup fn-count-id> markers in the produced HTML. This is the contract the
 *     backend citation-vacuum must reproduce once the engine is shared — it is
 *     not enough to extract references; the in-text links have to actually form.
 *
 * Entries marked KNOWN BUG document current broken behaviour — once the
 * underlying processor bug is fixed, update the entry to the new healthy
 * count. The test will then fail until the number is bumped, which forces
 * the fix and the assertion to be updated together.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
// These suites parse REAL ~100KB clipboard documents through the whole processor chain: ~0.5-1.3s
// per test on an idle machine. The suite runs 15 workers in parallel, and under that contention
// the 5s default left no headroom — the failures were "test timed out", never a wrong assertion.
// The work is genuinely this expensive, so state a budget that matches it rather than assume an
// idle box. Kept file-scoped: a global bump would hide a genuinely hung test elsewhere.
vi.setConfig({ testTimeout: 30_000 });

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFormat, getProcessorForContent } from '../../../resources/js/paste/format-detection/format-detector';
import { prepareClipboardHtml, convertDefinitionListTags } from '../../../resources/js/paste/utils/normalizer';
import { PASTE_CORPUS } from '../fixtures/corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'clipboard');

/**
 * Run a fixture the way handlePaste runs a real clipboard payload: the
 * structural preparation FIRST, the processor on the prepared payload, then the
 * post-processing conversions on its output.
 *
 * This wrapper is the whole point of the file. Calling `processor.process(html)`
 * directly is a PROCESSOR test wearing a paste test's clothes, and the gap was
 * not theoretical: `convertDefinitionListTags` ran before detection in the real
 * handler, so a ScienceDirect footnote article reached the processor with every
 * `<dl class="footnote">` already flattened to bare `<p>`s. The fixture suite
 * was green at 109 footnotes while the browser extracted 0 — the fixture never
 * went through the step that destroyed them.
 */
async function pasteFixture(rawHtml, bookId = 'fixtureBook') {
  const prepared = prepareClipboardHtml(rawHtml);
  const { processor } = getProcessorForContent(prepared);
  const result = await processor.process(prepared, bookId);
  return { ...result, html: convertDefinitionListTags(result.html) };
}


/** Count app-native interactive markers in produced HTML. */
function countMarkers(html) {
  return {
    inTextCitations: (html.match(/class="[^"]*\bin-text-citation\b/g) || []).length,
    footnoteMarkers: (html.match(/fn-count-id=/g) || []).length,
  };
}

describe('clipboard fixtures — baselines', () => {
  for (const baseline of PASTE_CORPUS) {
    describe(baseline.file, () => {
      const html = readFileSync(join(FIXTURE_DIR, baseline.file), 'utf8');

      it(`detects format as "${baseline.format}"`, () => {
        expect(detectFormat(prepareClipboardHtml(html))).toBe(baseline.format);
      });

      // ONE processor run per fixture, shared by both assertions below.
      // They interrogate different facets of the SAME run, and running the
      // full pipeline twice doubled both the work and the garbage: every
      // fixture left ~130MB behind in the file-scoped happy-dom Window, so by
      // ~26 fixtures the worker hit Node's default 4144MB heap ceiling and
      // died mid-file ("Ineffective mark-compacts near heap limit"). The crash
      // surfaced on oxford.html, which passes in 1.5s on its own — it was
      // simply where the accumulated heap ran out.
      let shared;
      const runOnce = async () => {
        // Use the same routing AND the same pre/post-processing production uses,
        // so smoke results reflect what a real paste of this fixture would
        // produce — not what a processor does to markup no paste ever hands it.
        if (!shared) {
          shared = await pasteFixture(html);
        }
        return shared;
      };
      afterAll(() => { shared = undefined; });

      it(`extracts ${baseline.footnotes ?? '?'} footnote(s) and ${baseline.references ?? '?'} reference(s)`, async () => {
        const result = await runOnce();

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
        // 20s not the 5s default: the biggest fixtures (MITpress, 133 refs) run
        // >5s when the suite shares the CPU with other work — a load flake.
      }, 20_000);

      it(`links ${baseline.inTextCitations ?? '?'} in-text citation(s) and ${baseline.footnoteMarkers ?? '?'} footnote marker(s) — app-native output`, async () => {
        const result = await runOnce();
        const markers = countMarkers(result.html);

        // eslint-disable-next-line no-console
        console.log(
          `LINKED    ${baseline.file.padEnd(60)} ` +
          `inTextCitations=${String(markers.inTextCitations).padStart(3)} ` +
          `footnoteMarkers=${String(markers.footnoteMarkers).padStart(3)}`,
        );

        if (baseline.inTextCitations != null) {
          expect(markers.inTextCitations).toBe(baseline.inTextCitations);
        }
        if (baseline.footnoteMarkers != null) {
          expect(markers.footnoteMarkers).toBe(baseline.footnoteMarkers);
        }
        // Same 20s as the extract test above: the big fixtures re-run the full
        // processor here and blow the 5s default under CPU load — a load flake.
      }, 20_000);
    });
  }
});

/**
 * Coverage guard: a fixture on disk with no corpus entry is invisible to BOTH
 * suites. This runs in `npm test`, which is where it has to live — the e2e spec
 * that would otherwise notice is manual, and a missing entry is exactly how the
 * browser suite ended up never pasting the one payload that was broken in prod.
 */
describe('the corpus covers the fixture directory', () => {
  it('every fixtures/clipboard/*.html has a PASTE_CORPUS entry', () => {
    const onDisk = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.html')).sort();
    const inCorpus = PASTE_CORPUS.map((entry) => entry.file).sort();

    expect(
      onDisk.filter((f) => !inCorpus.includes(f)),
      'fixture(s) on disk with no baseline — add an entry to tests/paste/fixtures/corpus.js',
    ).toEqual([]);
    expect(
      inCorpus.filter((f) => !onDisk.includes(f)),
      'corpus entr(ies) whose fixture file is gone',
    ).toEqual([]);
  });
});
