# The maintainer loop — triaging and fixing bad conversions

How a badly-converted book goes from "reader complains" to "fixed forever": flag → triage on /maintainer/conversion → pull the case to dev → capture a regression fixture → fix the conversion code → reconvert on prod with annotations preserved → resolve the flag. Each fixed book permanently hardens `tests/conversion/`, so the same failure class cannot come back.

## How books get flagged

- A reader presses "report an issue" on a book (source panel) with a bad rating → an open `conversion_flags` row + a `[flagged]` email to `config('mail.maintainer_alert')` (default fml@hyperlit.io) with a link to `/maintainer/conversion?book=<id>`.
- `php artisan library:flag-sweep` (run it on prod after big harvests; `--dry-run` first) detects garbage signatures — CAPTCHA/block pages saved as books, near-empty conversions, OCR noise — and raises `auto_sweep` flags. One summary email per run, only for NEW flags.
- Manually: `App\Models\ConversionFlag::raise($book, 'manual', 'reason')` in tinker.

## Triage on /maintainer/conversion (admin-only)

Open `/maintainer/conversion` (admins = `users.is_admin`; everyone else gets a 404). Left: the flag queue with suggested actions. Middle: the flagged book in the real reader. Right: the original source file (PDF/MD/HTML render inline). Bottom bar actions:

- **✓ resolve / ✕ dismiss** — the conversion is actually fine, or the flag is noise. Done. For a HARVESTED version this also promotes the book to `listed = true` (homepage / public search / sitemap): the harvester mints auto-versions `public + unlisted` because no human has looked at them, and closing the flag is precisely a human having looked — the same seam applies from the terminal (`library:reconvert-queue --resolve/--dismiss`). Scope guards in `ReconvertQueue::promoteApprovedHarvest`: system-acquired books only (a user's upload is theirs to list), already-public only, never encrypted. Retraction never lists.
- **↻ reconvert** — the conversion code was already fixed (or the book just needs a re-run through current code). Runs with live progress; hyperlights/hypercites re-attach to the new nodes automatically (orphans are kept and stamped, never deleted — see `reattach_report.json` in the book's markdown dir). Then resolve.
- **⤓ dev bundle** — the conversion CODE needs fixing: downloads `<book>.tar.gz`, the complete case (all DB rows incl. annotations + the whole `resources/markdown/<book>/` artifact dir: `original.*`, `ocr_response.json`, `assessment.json` decision trace, debug files, the user complaint).
- **⤓ harvest bundle** — the ACQUISITION needs fixing: the text isn't a mangled version of the work, it isn't the work at all. Use this when the book is a journal landing page, a "prove you're not a robot" interstitial, an abstract with nothing after it, or the wrong edition. See the section below.
- **🗑 retract** — the harvest-case closer: this version should never have been approved, so it is un-approved. Deletes the version book, clears + re-resolves the canonical's version pointer (BookDeletionService → CanonicalVersionSync), and closes the flags as `retracted`. The canonical becomes harvest-eligible again — safe, because the body gate now rejects the junk that got it in. Two guards (`App\Services\Conversion\HarvestRetraction`): only SYSTEM-acquired books are ever retractable (a user's upload never is, no override), and a body-PRESENT verdict on the stored nodes makes you confirm a second time — a flagged book can be real (a short Nature piece sat in a batch of 56 with 55 genuine junk pages).

## Conversion case vs harvest case — pick the right loop

These are two unrelated failures with two different fix sites, and running one through the other's loop wastes a day. The bundle manifest carries `case_kind` (auto-detected by `book:export` from the book itself; `--kind=` overrides), and `book:import-cases` prints it as `── <book> [kind]`.

- **`conversion`** — a user's own upload converted badly. Fix `app/Python`, lock it with a regression fixture. That's the loop in the next section.
- **`harvest`** — the Source Network Harvester auto-imported a work from OpenAlex and what it FETCHED was already wrong. An OpenAlex `is_oa` flag is a claim about the work, not a promise about the URL: following one can land on a paywalled publisher landing page or a bot wall. The converter then faithfully converted that, so replaying it through `run_regression.py` proves nothing — it just reconverts the junk. These bundles carry two things a conversion bundle never did: `db/canonical_source.json` (what OpenAlex actually claimed — `is_oa`, `oa_status`, every `oa_locations` copy, `pdf_url`, `oa_url`) and `artifacts/fetch_trace.json` (how many OA copies were tried, which host won, and the acquisition-gate verdict). `book:import-cases` skips fixture capture for these and prints the diagnosis instead.

The fix site is `app/Services/ContentFetchService.php` and its two deterministic gates in `app/Services/SourceImport/Content/`: `AccessWallDetector` (captcha/bot interstitials, raw HTML, runs before the paste engine) and `BodyPresenceAssessor` (is the article BODY here at all — the check that catches a paywalled landing page, which passes every identity and completeness signal because publishers paywall the body but never the reference list). A body-absent verdict rejects outright: no book is created. Tests: `php artisan test tests/Canonical/AcquisitionGateTest.php`, with the two real production failures kept as fixtures in `tests/paste/fixtures/walled/`.

After fixing acquisition, sweep what's already in the library — the gate only protects future fetches:

```bash
php artisan harvest:audit-imports --stats   # FIRST: prose distribution over the real corpus
php artisan harvest:audit-imports           # report suspects (free: measures stored nodes, no re-fetch)
php artisan harvest:audit-imports --flag    # queue them into /maintainer/conversion
php artisan harvest:audit-imports --unflag  # UNDO: delete exactly those flags again
```

Always run `--stats` before `--flag`. The audit scores a book by how many genuine prose paragraphs it holds, and that measure is only meaningful for whole harvested works — sub-books (annotations, footnotes) are excluded because a footnote is one paragraph, and user uploads are out of scope entirely. If more than 25% of the audited set comes back body-absent the command refuses to flag without `--force`: at that rate the threshold is wrong, not the library. `--unflag` targets only this audit's flags, so `library:flag-sweep` flags and user reports survive.

Then close the confirmed junk in bulk — retraction deletes each version book, frees its canonical for a legitimate re-fetch, and closes its flags as `retracted`:

```bash
php artisan harvest:retract --flagged --dry-run   # guards + report, deletes nothing
php artisan harvest:retract --flagged             # confirm, then retract
php artisan harvest:retract <book> [<book>…]      # explicit ids (e.g. flags without the body_absent marker)
```

`--flagged` targets every open flag carrying the audit's `body_absent` issue type. A book whose stored text looks body-PRESENT is skipped with a warning (it may be real — resolve its flag instead, or `--force` after eyeballing it on `/maintainer/conversion`); a book that isn't system-acquired is always skipped. `--yes` skips the prompt for scripted runs.

## From bundle to fixed code (on your dev machine)

The drop-folder is `tests/conversion/cases/` (git-ignored except its README). Leave the downloaded tarball in `~/Downloads` or drag it into the drop-folder — then ONE command ingests everything:

```bash
php artisan book:import-cases --downloads
```

That sweeps `~/Downloads` for valid case bundles (it verifies each tarball's manifest, so random tar.gz files are ignored), moves them into the drop-folder, imports each book (opens in your local reader at `/<book>`, artifacts in `resources/markdown/<book>/`), captures a regression fixture named after the book id, and archives the tarball to `cases/ingested/`.

Or skip the commands entirely: tell Claude `@tests/conversion/cases/ new broken conversions to fix`. The folder's README.md is a full contract for the LLM — ingest, compare book vs original, read the complaint + `assessment.json` decision trace, reproduce with `run_regression.py --fixture <book>` (red), fix `app/Python/…`, `--update-golden` (green forever), verify with a local reconvert.

The manual steps, when you want them:

```bash
python3 tests/conversion/run_regression.py --fixture <book>          # reproduce: expect RED
# … fix the conversion code (app/Python/…) …
python3 tests/conversion/run_regression.py --fixture <book> --update-golden
python3 tests/conversion/run_regression.py                            # everything else still green
php artisan library:reconvert-system-version <book>                   # free local dress rehearsal (OCR replay)
```

ssh alternative (no browser download at all): `tests/conversion/pull_case.sh <book> --corpus` does export-over-ssh + import + fixture capture (+ a vibe-eval corpus case with the complaint as `note.txt`) in one command — configure `tests/conversion/.env.pull` with `HYPERLIT_PROD_SSH` and `HYPERLIT_PROD_APP` first.

Fixture auto-capture needs `ocr_response.json` or `debug_converted.html` in the artifacts; EPUB/MD-input cases get a warning and are captured manually per `tests/conversion/README`.

## Close the loop (on prod)

Deploy the fix (`migrate` if needed, `queue:restart` always), then back on `/maintainer/conversion`: press **↻ reconvert** on the book, watch it complete, check the annotations survived, press **✓ resolve**. Or from the terminal: `php artisan library:reconvert-system-version <book>` and `php artisan library:reconvert-queue --resolve=<book> --resolution=reconverted`.

## The sibling loop: `/maintainer/jobs`

`/maintainer` is a namespace, not a page — it is prefixed so no book can ever be shadowed by it (see `config/reserved-routes.php` and its gate, `tests/Feature/Routing/ReservedRoutesTest.php`). `/maintainer/conversion` is this loop; `/maintainer/jobs` is the same shape applied to **failed queue jobs**: failures grouped by job class + normalised exception (87 rows are usually ~5 bugs), with per-group retry, forget, and a downloadable case bundle whose README is the prompt. Its drop-folder is `tests/failures/cases/` and its dev command is `php artisan failure:import-cases --downloads` — deliberately the same muscle memory as `book:import-cases`. A data-shaped job failure (one book's content breaks an assumption) hands off to THIS loop via `book:export`.

## Where things live

- Queue + flags: `conversion_flags` table, `App\Models\ConversionFlag`, `App\Services\Conversion\ReconvertQueue`, `library:reconvert-queue` / `library:flag-sweep` commands.
- Page: `resources/views/maintainer.blade.php` + `resources/js/maintainer/main.ts` + `resources/css/pages/maintainer.css`; API in `MaintainerController`.
- Bundle: `book:export` / `book:import` commands (`app/Console/Commands/Book{Export,Import}.php`).
- Annotation preservation: `App\Services\Annotations\{AnnotationSnapshotService,AnnotationReattachmentService}` + `App\Services\Import\BookContentClearer`; hooks in `ProcessDocumentImportJob` and `ContentFetchService::processLocalPdf`.
- Regression suite: `tests/conversion/` (see its README for fixture conventions).
