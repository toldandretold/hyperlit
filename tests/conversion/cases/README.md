# Case drop-folder — broken conversions pulled from prod

Tarballs (`<book>.tar.gz`) in this folder are **case bundles** exported from production by the `/maintainer/conversion` triage page's "⤓ dev bundle" button (or `php artisan book:export`). Each contains everything needed to reproduce, debug, and regression-lock a bad conversion: all DB rows (library, nodes, footnotes, bibliography, hyperlights, hypercites, the conversion_flags complaint) plus the book's whole artifact dir (`original.pdf|epub|md`, `ocr_response.json` OCR cache, `assessment.json` decision trace, `audit.json`, debug files, user feedback).

Everything here except this README is git-ignored — bundles are local working material.

## If you are Claude (or any LLM asked to "look at the new broken conversions")

Work through this checklist:

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
