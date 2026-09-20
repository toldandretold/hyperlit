# Prompt: fix the year-range / multi-year citation mislink (chacko case)

> **STATUS 2026-09-17: LARGELY DONE — read before using.** A parallel session fixed three defects (year-range phantom links, multi-year list keying, alias key theft) in BOTH implementations (`citation_link_rules.py` + `resources/js/paste/utils/citation-linker.ts`), with unit tests, the synthetic fixture `tests/conversion/fixtures/html/author_year_bracket/year_ranges_and_year_lists/`, and a new `citation_links` regression assertion. See memory `citation-year-traps-ranges-lists-aliases`. Verified end-to-end same day: reimporting the phase1 chacko study copy dropped year-mismatched anchors from **47 → 2**, and both survivors are AUTHOR-side inconsistencies (cited "Savera, 2022"/"Madhav (2025)" against a bibliography that lists only 2024 entries) — judgment-call links, not linker bugs. Remaining loose ends only: the LIVE chacko book (`book_1789025680384`, paste-imported, no cached source) still carries the old phantom anchors and cannot be reconverted — `conversion_flags` row for it stays open; resolve or document. The prompt below is kept for context/reference.

Paste everything below the line into a fresh conversion-pipeline session.

---

Fix a citation-linking bug class in the author-year in-text linker: bare years inside parenthesized YEAR RANGES are being minted into citations, and multi-year citation lists are resolving to the wrong bibliography entries. This was found live while human-adjudicating the citation-review study (`/maintainer/study`, corpus phase1) and it poisons the citation review in both directions — a phantom claim-source pairing gets reviewed and flagged against the author, while the genuine pairing never gets reviewed at all.

## The concrete case (use it as your fixture)

Book `book_1789025680384` (Chacko 2025, "Conspiracy theories and India's transnational authoritarian populism", type author-year; study copy `study_phase1_chacko-2025-conspiracy`). Find the node: `SELECT content FROM nodes WHERE book='book_1789025680384' AND "plainText" ILIKE '%dog whistle%'` on `pgsql_admin`. The paragraph's source text (clean, from the corpus markdown `study/corpora/phase1/sources/chacko-2025-conspiracy/original.md` line 58) reads: `While this rhetoric mostly took 'dog whistle' forms in Modi's first term (2014-2019), it intensified in its second term (2019-2024) … (Modi, 2024a, 2024b; Shah, 2024). Modi fashioned himself … (News18, 2024; Modi, 2019, 2023).`

Two bug shapes in the LIVE book's stored node:

- **Phantom year-range links.** `Modi's first term (2014-2019)` became `(<a href="#modi2014" class="in-text-citation">2014</a>-2019)` and `(2019-2024)` became `(<a href="#modi2019" …>2019</a>-2024)`. These are date ranges, not citations — the author cited nothing there. Suspected mechanism: the antecedent-author walk-back sees the possessive "Modi's" and a parenthesized year and links it. Note the attribute order in the live book is `href` before `class`; the study copy writes `class` first — don't let a regex assumption hide half the evidence (that mistake was made once already during diagnosis).
- **Multi-year list misresolution.** In the study copy, `Modi, 2019, 2023` linked BOTH years to `#modi2024d`, and `News18, 2024` linked to `#agenciesnews2023`. Verify whether the live book has the same or different wrong targets — mislinks are NOT stable across imports (linking re-runs from plain markdown; referenceIds/set-iteration order differ), so treat each copy's anchors independently.

Downstream harm observed: study claim `chacko-2025-conspiracy/c130` paired the "dog whistle" sentence with the Swachh Bharat speech (`modi2019`) purely via the phantom anchor; the AI verdicted "unlikely" on a pairing the author never made, while the genuine `Modi, 2019` use (mislinked to `#modi2024d`) went unreviewed.

## Where the code lives

- `app/Python/digestion/citationLinking/citations.py` — `link_citations(soup, bibliography_map, emit_progress)`.
- `app/Python/digestion/citationLinking/citation_link_rules.py` — the LinkRule registry and the antecedent-author walk-back (stats fields around line 73: `antecedent_links`, `antecedent_sample`, `ambiguous_links`; walk-back guards around lines 109–260, including the prose-parenthetical guard and self-link guard). The walk-back already has FIVE gates plus `citations:audit-antecedent` (artisan) as its audit tool — the year-range case needs to become a sixth gate or extend an existing one: a year that is half of a `(YYYY-YYYY)` or `YYYY–YYYY` range (hyphen or en dash, either side) must never be linked. Decide whether the possessive form ("Modi's") should count as an antecedent author at all.
- The multi-year list bug (`Modi, 2019, 2023` → both `#modi2024d`) is a separate resolution path — multi-year lists after one author. Find where the second and subsequent years inherit the resolved entry and why `2019`/`2023` landed on a `2024` entry.

## House rules and traps (read these memories/docs first if unsure)

- Modus operandi: a WRONG link is worse than a missing link. When in doubt, don't link — unlinked years cost nothing; phantom links poison the citation review and the hypercite graph.
- The walk-back's candidate matching is EXACT, never fuzzy-on-guess (`citation-antecedent-author-walkback` memory; five gates + `citations:audit-antecedent`).
- Ambiguous cases (≥2 fits) must become stored QUESTIONS in the ambiguous-citation ledger (`citations:sync-ambiguous`, `/maintainer/citations`), not guesses — and the ledger hook must stay wired on BOTH import paths.
- Python floor is 3.11 (no PEP 701 f-strings); guardrail `tests/conversion/unit/test_python_version_floor.py`.
- Unit tests for this area: `tests/conversion/unit/test_citation_link_rules.py` and `test_citations.py` (pytest, `python3 -m pytest tests/conversion/unit/`). The regression suite is SEPARATE from pytest: `python3 tests/conversion/run_regression.py` — run BOTH; pytest passing proves nothing about the goldens. If a legit behavior change shifts goldens, regenerate with `--update-golden` and eyeball the diff.

## Definition of done

1. Unit tests pinning: (a) a year inside a parenthesized range is never linked, with and without a possessive author preceding; (b) decade/range punctuation variants (hyphen, en dash); (c) a genuine adjacent citation `(Modi, 2019)` still links; (d) whatever you find is wrong in multi-year list resolution, pinned with the `Modi, 2019, 2023` shape.
2. A regression fixture (synthetic is fine — see `tests/conversion/make_synthetic.py` and the fixtures layout in `tests/conversion/README.md`) carrying the chacko paragraph shape through the html/author-year pathway.
3. Both suites green: `python3 -m pytest tests/conversion/unit/` and `python3 tests/conversion/run_regression.py` (ALL PASS).
4. Live verification: reconvert `book_1789025680384` (BookReconverter path, cached source — see `bulk-reconvert-from-cached-source` memory; reconvert invalidates hypercite detection, see `reconvert-invalidates-hypercite-detection`), then re-query the dog-whistle node: the `(2014-2019)`/`(2019-2024)` anchors must be gone and `Modi, 2019` must link to a modi2019-family entry. Run `php artisan citations:audit-antecedent` on the book and check the walk-back sample.
5. Study follow-through (flag for the operator, don't do it unasked): the phase1 chacko study copy carries the same class of mislinks baked in; after the linker fix it needs `citation:study:import` re-import + re-run for those rows to be meaningful. Adjudications are keyed by gt_id and survive; check `study/corpora/phase1/adjudications/` for rows with cause `citation_mislink` — each one is a test case for this fix.

There may also be an open `conversion_flags` row (source `study_workbench`, book `book_1789025680384`) filed from the workbench — resolve it when done so the reconvert queue stays honest.
