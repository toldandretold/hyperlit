# Case drop-folder — broken books pulled from prod

Tarballs (`<book>.tar.gz`) in this folder are **case bundles** exported from production by the `/maintainer/conversion` triage page's download buttons (or `php artisan book:export`). Everything here except this README is git-ignored — bundles are local working material.

## Two case kinds — check `case_kind` in the manifest FIRST

A bad book has two unrelated possible causes, and they have two different fix sites. The manifest's `case_kind` says which (auto-detected at export; `book:export --kind=` overrides), and `book:import-cases` prints it as `── <book> [kind]`.

- **`conversion`** — the user's own upload converted badly. The input was fine; `app/Python` mangled it. Carries all DB rows plus the artifact dir (`original.pdf|epub|md`, `ocr_response.json` OCR cache, `assessment.json` decision trace, `audit.json`, debug files, user feedback). This is the loop the checklist below describes.
- **`harvest`** — the Source Network Harvester auto-imported a work from OpenAlex and **what it acquired was already wrong**: a paywalled publisher landing page, a captcha interstitial, the wrong edition. The converter did its job faithfully on junk input, so `run_regression.py` would only prove that the junk converts to junk. These bundles additionally carry `db/canonical_source.json` (what OpenAlex claimed — `is_oa`, `oa_status`, `oa_locations`, `pdf_url`, `oa_url`) and `artifacts/fetch_trace.json` (which OA copy won, and the acquisition-gate verdict). **Fix `app/Services/ContentFetchService.php` and its gates (`SourceImport/Content/{AccessWallDetector,BodyPresenceAssessor}.php`), not `app/Python`.** Tests: `php artisan test tests/Canonical/AcquisitionGateTest.php`. After a fix, re-check every already-imported source with `php artisan harvest:audit-imports --flag` — the gate only protects future fetches, and there are older bad imports sitting in the library that no one has opened yet.

## If you are Claude (or any LLM asked to "look at the new broken conversions")

Run `php artisan book:import-cases --downloads` first; it tells you each case's kind. For a `harvest` case, follow the paragraph above — the checklist below is the `conversion` loop and does not apply. For a `conversion` case, work through this checklist:

1. **Ingest whatever is sitting here**: run `php artisan book:import-cases --downloads` (the `--downloads` flag also sweeps `~/Downloads` for bundles the maintainer page saved there). For each bundle this imports the book into the local DB + `resources/markdown/<book>/`, captures a conversion-regression fixture named after the book id, and parks the tarball in `ingested/`.
2. **See what the user saw**: the book renders at `https://hyperlit.test/<book>` in the local reader; the original file is at `resources/markdown/<book>/original.*`. Compare them — that gap IS the bug.
3. **Read the complaint + the pipeline's own account**: the flag (reason, issueTypes, signals) is in the bundle's `db/conversion_flags.json` (also imported into the local `conversion_flags` table); `resources/markdown/<book>/assessment.json` is the converter's fork-by-fork decision trace — it usually names the module that went wrong; `audit.json` has unmatched-footnote/reference counts.
4. **Reproduce deterministically**: `python3 tests/conversion/run_regression.py --fixture <book>` — the fixture replays the cached OCR/input through the CURRENT pipeline (no API cost). Expect red or visibly-wrong output.
5. **Fix the conversion code** (`app/Python/` — see `tests/conversion/README` for pathway conventions and `docs/maintainer-loop.md` for the whole loop). Honour the house rule: correct where determinable, NO link where ambiguous — a wrong footnote/citation link is worse than a missing one.
6. **Lock it in**: `python3 tests/conversion/run_regression.py --fixture <book> --update-golden`, then a full `run_regression.py` to prove nothing else broke.
7. **Verify end-to-end locally**: `php artisan library:reconvert-system-version <book>` (replays cached OCR through the fixed code, free) and eyeball the book in the reader — including that hyperlights/hypercites survived (`resources/markdown/<book>/reattach_report.json`).
8. **Hand back to the human**: they deploy, press ↻ reconvert on `/maintainer/conversion`, and resolve the flag (`php artisan library:reconvert-queue --resolve=<book> --resolution=reconverted` on prod).

Notes: fixture auto-capture needs `ocr_response.json` or `debug_converted.html` in the artifacts — EPUB/MD-input cases print a warning; capture those manually per `tests/conversion/README` (place the input + manifest under `fixtures-local/`). For LLM-assisted diagnosis at corpus scale, `tests/conversion/vibe_eval.py` + `corpus/` is the co-evolution harness — a case can be seeded there too (`pull_case.sh <book> --corpus` does it automatically, with the user complaint as `note.txt`).

## If you are a human

Drag the downloaded `<book>.tar.gz` here (or leave it in Downloads), then either run `php artisan book:import-cases --downloads` yourself — or open Claude and say: `@tests/conversion/cases/ new broken conversions to fix`.

Which button to press on `/maintainer/conversion`: if the book's TEXT is the right text but mangled (garbled footnotes, lost headings, scrambled order) that's **⤓ dev bundle**. If the text isn't the work at all — a journal landing page, a "prove you're not a robot" page, an abstract with nothing after it — that's **⤓ harvest bundle**. Export auto-detects the kind either way, so the buttons only matter when you want to override the guess.
