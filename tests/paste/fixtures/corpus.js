/**
 * THE PASTE CORPUS — one list, read by every paste suite.
 *
 * Each real clipboard payload in fixtures/clipboard/ gets exactly one entry
 * here, and both regression regimes consume it:
 *
 *   - tests/paste/handlers/fixtures-smoke.test.js (vitest, runs in `npm test`)
 *     asserts these counts EXACTLY, in-process, through the real paste lane.
 *   - tests/e2e/specs/workflows/paste-publisher-fixtures.spec.js (playwright,
 *     manual) fires a real paste event into the running app and asserts the
 *     RENDERED DOM carries at least this many markers.
 *   - tests/paste/handlers/backend-entry.test.js enumerates the directory
 *     directly and proves the Node backend reproduces the front-end.
 *
 * It is one list because it used to be two, and the second one rotted. The e2e
 * spec kept its own hand-maintained array: `sciencedirect.html` was recorded
 * there as having 0 footnotes (it has 2), and when the SD footnote fixture was
 * added to the smoke baselines nobody added it to the browser list — so the one
 * suite that fires an actual paste never ran the payload that was broken in
 * production. Add a fixture here and both suites pick it up; the smoke file
 * fails if a fixture on disk has no entry at all.
 *
 * FIELDS
 * - `file` / `format` — the payload and the format-detector's verdict.
 * - `footnotes` / `references` — exact extraction counts.
 * - `inTextCitations` / `footnoteMarkers` — app-native LINKED output:
 *   `<a class="in-text-citation">` and `<sup fn-count-id>` in the produced HTML.
 *   Extracting a reference is not enough; the in-text link has to actually form.
 * - `skipE2e` — a REASON string, never a bare true. A synthetic fixture whose
 *   whole point is a processor-level heuristic may not earn a 3-minute browser
 *   run; anything real should.
 *
 * Entries marked KNOWN BUG document current broken behaviour — fix the bug and
 * bump the number, so the fix and the assertion move together.
 */
export const PASTE_CORPUS = [
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
    // 2, not 0: this author-date article also carries two <dl class="footnote">
    // notes, and they were being left in the body as loose prose with their
    // markers dissolved into bare digits — the same defect the
    // sciencedirect-footnotes.html fixture below shows at 109× scale.
    footnotes: 2,
    references: 88, // matches the 88 span.reference[id] elements exactly
    // Still 136 after footnote extraction: note 2 cites "(Lenin, 1920)", and a
    // citation lifted out of the DOM with its note has to be converted inside
    // the extracted content or it ships as a live sciencedirect.com anchor.
    inTextCitations: 136,
    footnoteMarkers: 2,
  },
  {
    // Real capture (J. Historical Geography, doi 10.1016/j.jhg.2025.07.004): the
    // OTHER ScienceDirect citation style. Notes live in <dl class="footnote">
    // blocks and the in-text markers are `data-xocs-content-id="fn1"` anchors —
    // the same `data-xocs-content-type="reference"` the author-date lane uses,
    // separated only by the id prefix. Every SD capture until 2026-09 was
    // author-date, so the processor hard-returned [] from extractFootnotes and
    // convertCitationLinks ate all 109 markers as failed bibliography lookups,
    // leaving bare digits glued to the prose ("…communist government.1 Five…").
    // 0 references is correct: a footnote-only article has no bibliography.
    file: 'sciencedirect-footnotes.html',
    format: 'science-direct',
    footnotes: 109,
    references: 0,
    inTextCitations: 0,
    footnoteMarkers: 109,
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
    // Real capture, prod paste (EJIS, doi 10.1080/0960085X.2026.2642660): the
    // 2026 tandfonline markup lowercased the CIT ids (`data-rid="cit0087"`),
    // and every `[data-rid^="CIT"]` in the engine compared the value
    // case-sensitively. A MID-PARAGRAPH selection, so there is no bibliography
    // to link against — the contract here is that the leftover anchors are
    // unwrapped to clean prose ("(Ma, 2023)") instead of being shipped as live
    // tandfonline links reading "Citation2023". The linked-output contract for
    // the same markup WITH a bibliography lives in
    // format-processors/taylorFrancis.lowercaseCit.test.js.
    file: 'tandf-2026-lowercase-cit-fragment.html',
    format: 'taylor-francis',
    footnotes: 0,
    references: 0, // partial selection: the References section was not copied
    inTextCitations: 0,
    footnoteMarkers: 0,
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
    // Below the paste handler's SMALL_NODE_LIMIT (9 block elements vs a limit of
    // 10), so a REAL paste of this payload takes processLite — normalize +
    // cleanup, no extraction at all, by design. The counts below are the
    // full-processing contract this fixture exists to pin; asserting them
    // against a browser paste asserts the wrong path. Found by running the e2e
    // corpus: "expected >= 5 stored footnote markers, got 0".
    skipE2e: 'under SMALL_NODE_LIMIT — a real paste takes the lite path and extracts nothing',
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
    //
    // inTextCitations was 0 here until 2026-09-18 and that zero was the BUG, not the
    // spec: `<a href="#ref-1">[1]</a>` aimed at `<p id="ref-1">` is a citation the
    // publisher already wired, and Strategy 2 was discarding each entry's id so
    // nothing could map the two together. Same defect, differently dressed, lost every
    // citation in barnett-2020 (eLife) and failed its review outright.
    file: 'generic-anchor-numeric-citations.html',
    format: 'general',
    footnotes: 0,
    references: 4,
    inTextCitations: 4,
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
    // Real capture, prod case book_1788218867015 (cs.brown.edu memex, 1999 ACM
    // article). The page layout is ONE <table width="500"> — a spacer cell plus
    // a cell holding the entire document — so the whole ~100KB article used to
    // land as a single unsplittable table node. Locks the layout-table escape:
    // GeneralProcessor.normalize() dissolves layout tables (data tables are
    // kept — see generalProcessor.layoutTable.test.js for the discrimination).
    file: 'web-xanadu-layout-table.html',
    format: 'general',
    footnotes: 0,
    references: 2, // the ACM copyright/permission block parses as 2 entries
    inTextCitations: 0,
    footnoteMarkers: 0,
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
