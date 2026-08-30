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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectFormat, getProcessorForContent } from '../../../resources/js/paste/format-detection/format-detector';

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
    inTextCitations: 0, // KNOWN BUG: 32 references extracted but the in-text
                        // author-date citations are NOT being linked. Bump to the
                        // healthy count when the Cambridge author-date linker is fixed.
    footnoteMarkers: 0,
  },
  {
    file: 'cambridge-footnotes.html',
    format: 'cambridge',
    footnotes: 147,
    references: 0, // This article uses footnote-style citations only; no separate bibliography section. 0 is correct.
    inTextCitations: 0, // footnote-only article — citations are the footnote markers
    footnoteMarkers: 147,
  },
  {
    file: 'oxford.html',
    format: 'oup',
    footnotes: 4,
    references: 126,
    inTextCitations: 166,
    footnoteMarkers: 4,
  },
  {
    file: 'sage1.html',
    format: 'sage',
    footnotes: 144, // role="paragraph" footnote definitions
    references: 0, // this article has no separate bibliography (footnote-only article)
    inTextCitations: 0,
    footnoteMarkers: 144,
  },
  {
    file: 'sage2.html',
    format: 'sage',
    footnotes: 5,
    references: 65,
    inTextCitations: 126,
    footnoteMarkers: 5,
  },
  {
    file: 'sciencedirect.html',
    format: 'science-direct',
    footnotes: 0, // ScienceDirect uses inline references, no footnotes
    references: 88, // matches the 88 span.reference[id] elements exactly
    inTextCitations: 136,
    footnoteMarkers: 0,
  },
  {
    file: 'springer-authoerdate.html',
    format: 'springer',
    footnotes: 0,
    references: 78, // matches the 78 id="ref-CR..." IDs (ref-CR1..ref-CR78) exactly
    inTextCitations: 119,
    footnoteMarkers: 0,
  },
  {
    file: 'springer-footnotes.html',
    format: 'springer',
    footnotes: 142, // matches the 142 id="Fn..." anchors exactly
    references: 69,
    inTextCitations: 94,
    footnoteMarkers: 142,
  },
  {
    file: 'taylorandfrancis.html',
    format: 'taylor-francis',
    footnotes: 1, // article legitimately has only one EN0001 endnote
    references: 66, // matches the 66 li[id^="CIT"] items exactly
    inTextCitations: 171,
    footnoteMarkers: 1,
  },
  {
    file: 'MITpress.html',
    format: 'mit-press',
    footnotes: 11, // .fn[content-id^="fn"] definitions
    references: 133, // [data-content-id^="bib"] entries
    inTextCitations: 209, // a[data-modal-source-id^="bib"] → exact-id links
    footnoteMarkers: 13, // some footnotes referenced more than once
  },
  {
    // Synthetic fixture (shape of prod case book_1786957563012): Word/GDocs-style
    // paste with plain-text [N] body markers and "[N] …" endnote paragraphs —
    // no <sup>, no anchors, no References heading. Locks the GeneralProcessor
    // bracket-endnote heuristic: defs become footnotes (NOT bibliography) and
    // body markers link. Regression: body prose was hoovered into references.
    file: 'generic-bracket-endnotes.html',
    format: 'general',
    footnotes: 5,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 5,
  },
  {
    // Journal-import HTML lane (case 643bd65d…): full fetched page, not a
    // clipboard capture — that IS this lane's real input. First BUP article
    // with notes: lowercase `fn1` ids in a .footnoteGroup (not FN0001).
    file: 'bristol-transdisciplinarity-bluff.html',
    format: 'bristol-up',
    footnotes: 1, // the lone .footnoteGroup note (lowercase id="fn1")
    references: 21, // matches the 21 div.reference[id^="CIT"] entries exactly
    inTextCitations: 28, // matches the 28 href="#CIT…" anchors (some refs cited twice)
    footnoteMarkers: 1,
  },
  {
    // Synthetic fixture (shape of prod case book_1788040795553): news-site
    // clipboard HTML — div-wrapped, no references section anywhere, body prose
    // carrying bare years ("…in 1773 when Parliament…", "February 2025").
    // Locks the GeneralProcessor shape+cohort gate: no bibliography exists, so
    // none is invented. Regression: every year-bearing paragraph was cloned into
    // a fabricated "References" section as an empty tagged <p> plus a duplicate
    // body <p>.
    file: 'generic-news-prose-years.html',
    format: 'general',
    footnotes: 0,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 0,
  },
  // ---------------------------------------------------------------------
  // General lane: internal-link footnote systems, one per generator shape.
  // These exist because the engine used to detect footnotes by guessing
  // anchor NAMES from a five-word list. utils/anchor-footnotes.ts reads the
  // id/fragment structure instead, so each of these resolves without the
  // engine knowing anything about the CMS that produced it.
  // ---------------------------------------------------------------------
  {
    // Word / Google Docs "Save as Web Page": _ftnref1 <-> _ftn1, and the ids
    // live on `a[name]` with no `id` attribute at all — which is why the
    // resolver's target map has to index `a[name]` as well as `[id]`.
    file: 'generic-anchor-footnotes-word.html',
    format: 'general',
    footnotes: 4,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 4,
  },
  {
    // Pandoc: fnref1 <-> fn1, with the <sup> INSIDE the anchor and a trailing
    // "↩︎" back-link. Pins two things: sup-affinity must look inside the anchor
    // as well as outside it, and `[role="doc-noteref"]` (a standard W3C
    // DPUB-ARIA role, not a Sage marking) must not divert this to SageProcessor.
    file: 'generic-anchor-footnotes-pandoc.html',
    format: 'general',
    footnotes: 4,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 4,
  },
  {
    // MkDocs: fnref:1 <-> fn:1. The colon makes `#fn:1` an INVALID CSS
    // selector, so this pins that fragments are resolved through a map and
    // never through querySelector('#' + id), which would throw.
    file: 'generic-anchor-footnotes-mkdocs.html',
    format: 'general',
    footnotes: 4,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 4,
  },
  {
    // Marker -> definition with NO back-link: the tier-2 path, where the
    // round-trip evidence is missing and every other gate has to carry it.
    file: 'generic-anchor-footnotes-oneway.html',
    format: 'general',
    footnotes: 4,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 4,
  },
  {
    // NEGATIVE: an in-page table of contents plus "back to top" links and a
    // numbered <ol>. Internal anchors everywhere, no footnotes anywhere.
    file: 'generic-anchor-toc-links.html',
    format: 'general',
    footnotes: 0,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 0,
  },
  {
    // NEGATIVE: numeric [N] citations linking into a References section. This
    // has exactly the tier-2 shape, and it belongs to the REFERENCE extractor —
    // so footnotes must stay 0 while the four entries land as references.
    file: 'generic-anchor-numeric-citations.html',
    format: 'general',
    footnotes: 0,
    references: 4,
    inTextCitations: 0,
    footnoteMarkers: 0,
  },
  {
    // Real capture: progressive.international, "Thornton: The NIEO as
    // Cautionary Tale". The HARDEST general-lane shape so far — 19 notes with
    // NO back-links, NO <sup>, and markers that are a bare digit superscripted
    // purely by CSS: `<a href="https://…/en/#ref-1" style="top: -4px">1</a>`.
    //
    // Locks two relaxations, both of which had silently dropped all 19:
    //  1. A bare number is an acceptable marker. Rejecting it per-element was
    //     right about a lone link and wrong about a cohort; the dense ascending
    //     run into substantial tail-clustered blocks is the actual evidence.
    //  2. A "References" heading does not by itself mean bibliography. These
    //     are Chicago-style notes ("Bret Benjamin, 'Bookend to Bandung,'
    //     Humanity 6, no. 1 (2015), 44.") under exactly that word. The entries
    //     must corroborate — a bibliography entry leads "Surname, Forename",
    //     these lead with a forename or with "See…".
    file: 'web-progressive-international-bare-markers.html',
    format: 'general',
    footnotes: 19,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 19,
  },
  {
    // Real capture: Wikipedia (MediaWiki/Parsoid), "New International Economic
    // Order". cite_ref-N <-> cite_note-N, absolute hrefs, the identity id on the
    // parent <sup> rather than the anchor, and 31 markers sharing 21 notes
    // because several refs are cited more than once.
    //
    // Locks the COHORT MERGE. MediaWiki emits four naming variants of one
    // system (plain `cite_ref-2`, named `cite_ref-auto4_1-0`, `cite_ref-decl_1-0`,
    // `cite_ref-auto_1-0`). Scoring ordinal density per variant, the named
    // subset reads 1,3,4,10,11,15 — density 0.4 — and was discarded, losing 6
    // notes to the reference extractor. Density is a property of the sequence,
    // so it is computed once over the merged set.
    //
    // The 14 references are the article's separate "Further reading" list, which
    // IS a bibliography and correctly stays one.
    file: 'web-wikipedia-cite-notes.html',
    format: 'general',
    footnotes: 21,
    references: 14,
    inTextCitations: 0,
    footnoteMarkers: 31,
  },
  {
    // Real capture, prod case book_1787965215968 (common-wealth.org, Webflow).
    // A textbook reciprocal anchor system: marker id="pub-footnote-N" -> href
    // "…#footnote-N", definition id="footnote-N" -> back to "…#pub-footnote-N",
    // 54 pairs, hrefs absolute, marker text "[1]".
    //
    // Locks TWO things. (1) Detection: this used to come back as `sage` off the
    // generic `[role="listitem"]` selector — Webflow puts that role on every
    // Collection List item — and SageProcessor then found nothing. (2) The
    // anchor resolver: the five-word fragment vocabulary
    // (/#(?:_?ftn|fn|note|_edn)(\d+)$/) never matched `#footnote-1`, so the
    // definitions were extracted by a blind plain-text scanner and NOTHING
    // linked to them.
    file: 'web-commonwealth-footnotes.html',
    format: 'general',
    footnotes: 54,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 54,
  },
  {
    file: 'substack.html',
    format: 'substack',
    footnotes: 35, // .footnote-content divs (bare footnote-anchor-N id format)
    references: 0, // Substack posts use footnotes, not a bibliography
    inTextCitations: 0,
    footnoteMarkers: 35, // FootnoteAnchorToDOM → <sup fn-count-id>
  },
];

/** Count app-native interactive markers in produced HTML. */
function countMarkers(html) {
  return {
    inTextCitations: (html.match(/class="[^"]*\bin-text-citation\b/g) || []).length,
    footnoteMarkers: (html.match(/fn-count-id=/g) || []).length,
  };
}

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
        // 20s not the 5s default: the biggest fixtures (MITpress, 133 refs) run
        // >5s when the suite shares the CPU with other work — a load flake.
      }, 20_000);

      it(`links ${baseline.inTextCitations ?? '?'} in-text citation(s) and ${baseline.footnoteMarkers ?? '?'} footnote marker(s) — app-native output`, async () => {
        const { processor } = getProcessorForContent(html);
        const result = await processor.process(html, 'fixtureBook');
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
