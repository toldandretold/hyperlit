# Citation Review evaluation study

This directory holds the corpora and results for the scientific evaluation of the CitationReview system (`app/Services/CitationReview`), run by the `citation:study:*` artisan commands (`app/Console/Commands/CitationStudy`, services in `app/Services/CitationStudy`). The study measures how well the tool detects fabricated and unsupported citations versus correct ones, per citation.

## Layout

- `corpora/{corpus}/manifest.json` — the corpus definition: books with slug, arm (`synthetic` | `retracted` | `control`), source files, provenance, and ground-truth paths. Corpora are COMMITTED — they are part of the paper's reproducibility story.
- `corpora/{corpus}/sources/{slug}/` — `original.md` (the clean article), `corruption.json` (the seeded corruption spec, synthetic arm only), and the generated `corrupted.md` + `ground_truth.json`.
- `corpora/{corpus}/corpus.lock.json` — sha256 of every corpus file, written by `citation:study:freeze`. A manifest with `"frozen": true` refuses to run when files no longer match the lock.
- `results/{corpus}/` — GITIGNORED run artifacts: `state.json` (resumable runner state), `runs/{run_id}/` (per-book claims JSONs, logs, `provenance.json`), and `report/` (`dataset.csv`, `summary.json`, `summary.md`).

## Step by step: creating and running a corpus

Everything lives inside ONE folder per corpus: `study/corpora/{corpus}/`. You never create anything directly under `study/` or `study/corpora/` except that corpus folder. The example below builds a corpus called `dev` with one synthetic-arm article slugged `smith-2021`.

### 0. One-time setup

- Create a user account for the study runs (register normally in the app), give it billing balance, and set `STUDY_USER_NAME=thatname` in `.env` (default is `study`, see `config/study.php`).
- Mail: every review emails the book creator on completion. A local catcher (`MAIL_MAILER=smtp` to Mailpit on `127.0.0.1:1025`, Herd's default) is fine as long as Mailpit is actually running — the send is NOT try/caught, so a dead catcher throws after the review already succeeded and billed, and the runner then books it as failed. `MAIL_MAILER=log` is the can't-fail option.

### 1. Get articles into the corpus

The easy path — import each article through the app like any other book (PDF, markdown, whatever), then adopt it by bookId:

```
php artisan citation:study:adopt dev <bookId> --arm=synthetic
php artisan citation:study:adopt dev <otherBookId> --arm=control
```

Adopt snapshots the book's converted markdown (`original.md` or `main-text.md` from `resources/markdown/{bookId}/`) into the corpus, creates the corpus folder + manifest if needed, fills provenance from the library row, and writes a default `corruption.json` for synthetic books (edit its seed/counts if you want). The study still runs on a fresh `study_dev_{slug}` copy, never on your live book — that keeps the corpus hashable, the runs billed to the study user, and canonicalized live books out of the ground truth. Web/HTML imports have no markdown and must be added by hand (below).

The manual path (for hand-curated markdown) — make these files yourself; the easiest start is copying `study/corpora/toy/manifest.json` and editing it:

```
study/corpora/dev/manifest.json
study/corpora/dev/sources/smith-2021/original.md
study/corpora/dev/sources/smith-2021/corruption.json   (synthetic arm only)
```

- `original.md` — the article's markdown (clean, uncorrupted). Reference list under a `## References` heading, one blank-line-separated paragraph per entry, author-date in-text citations like `(Smith, 2019)`.
- `corruption.json` — just `{"seed": 424242, "counts": {"fabrication": 2, "source_swap": 1, "claim_distortion": 1}}`.
- In `manifest.json`, each book entry needs: `slug`, `arm` (`synthetic` | `retracted` | `control`), `source_file` (`sources/smith-2021/original.md` — all paths are relative to `study/corpora/dev/`), and for synthetic books also `study_file` (`sources/smith-2021/corrupted.md`) and `corruption_spec`. Record DOI, license, and retrieval date in `provenance`.

### 2. Generate corruptions and ground truth

```
php artisan citation:study:corrupt dev
```

This CREATES `sources/smith-2021/corrupted.md` + `ground_truth.json` for synthetic books (deterministic from the seed; `--check` proves regeneration is byte-identical). Control/retracted books get a skeleton `ground_truth.json` instead — open it and verify/edit the labels BY HAND.

### 3. Import into the local library

```
php artisan citation:study:import dev
```

Imports each book as `study_dev_{slug}` under the study user and binds the ground truth to the referenceIds the import actually produced. Fails loudly on unmatched or ambiguous entries — fix the source/ground truth before going further.

### 4. Run the pipeline (costs money)

```
php artisan citation:study:run dev
```

Runs the full citation pipeline per book with a minted pipeline row (so step timings and telemetry are recorded), captures the exact claims JSON, snapshots provenance (git rev, model config, pricing), and audits for contamination. Crash-resumable; completed books are skipped unless `--force-rerun`.

### 5. Build the dataset and summary

```
php artisan citation:study:report dev
```

Writes `study/results/dev/report/dataset.csv` (one row per citation occurrence), `summary.json`, and `summary.md`: confusion matrices at every verdict cutoff with Wilson 95% CIs, detection-channel split (source-not-found vs verdict), pre/post rejection-upgrade comparison, per-arm/evidence-type/match-method breakdowns, and timing/cost stats.

## Study protocol (dev vs test corpus)

Tune the tool freely against the `dev` corpus. BEFORE any reported run: build the `test` corpus, hand-verify its labels, set `"frozen": true` in its manifest, and run `citation:study:freeze test`. The `test` corpus is then run once per reported configuration; `runs/{run_id}/provenance.json` (git sha + dirty flag + model config) is the audit trail for every number in the paper.

## Things that invalidate results (the harness guards these, but know them)

- Study books must never carry `openalex_id` / `open_library_key` / `canonical_source_id` — Wave 3 local matching only considers rows that have them, which is what stops a fabricated reference resolving against another study book. The importer leaves them NULL and the runner's preflight asserts it.
- Re-runs must pass `--force` to the pipeline (the runner always does) or the 24h no-match cooldown silently reuses cached resolution verdicts.
- referenceIds are NOT stable across imports (Python set iteration order), which is why ground truth is text-keyed and bound after import; never hand-write `bound_reference_id`.
- The completion email is sent without a try/catch — if your mailer is unreachable mid-run, the review succeeds and bills but the runner records the book as failed. Local Mailpit running, or `MAIL_MAILER=log`.
- The study user must have billing balance; a broke user runs fine but silently loses the per-run cost data (`billReview` is try/caught).
