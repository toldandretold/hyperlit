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

## Evidencing human labels

A label a person assigned is an assertion until it carries the source text that person read — and "we verified this citation by hand" is the first claim a reader of the paper will probe. So every human adjudication recorded in `/maintainer/study` has an **evidence** field: verbatim quotes from the source, plus an optional locator (`p. 412`, `0:01–1:51, auto-captions`). Quotes are capped at 1500 characters with a live counter, because the point is selective quotation — enough to show what was judged, never a copy of a closed-access source.

Evidence saves with a verdict, and can also be added to a verdict recorded earlier without re-making it (the "Add evidence" button on a saved verdict; `POST …/books/{slug}/evidence`). Buttons beside each retrieved passage, and a "use selection" button that reads whatever you have highlighted in the page or the source pane, append quotes for you. On Apply the quotes travel into `ground_truth.json` alongside the label, so the published artifact carries its own evidence; they also land in `dataset.csv` as `human_evidence` / `human_evidence_locator` / `human_evidence_chars`.

**Which labels need evidence.** The SCORED labels do — `intact`, `verified_intact`, `fabricated_reference`, `source_swap`, `claim_distortion`. The non-scored ones (`suspect`, `unverifiable`, `not_a_citation`) are exempt, because there is nothing to quote: you never obtained access, or no citation exists at all (a phantom anchor the linker minted from a year range has no source to quote from). Those carry their reason in the `note` instead, and a coverage run reports any that do not.

**Reading coverage.** `citation:study:report {corpus}` writes an `evidence_coverage` block into `summary.json` and a section into `summary.md`; `citation:study:freeze {corpus}` prints the same line and lists every un-evidenced scored label before freezing (it warns, it does not refuse); `citation:study:adjudications {corpus}` shows a per-book count. Coverage counts ADJUDICATIONS, not ground-truth entries — entries carry the manifest's blanket `default_label`, so an entry-based figure would measure the corpus's size rather than the review work.

Note that `dataset.csv` now contains multi-line quoted fields, which is valid RFC 4180 but means a naive `wc -l` over-counts rows; parse it with a real CSV reader.

## Study protocol (dev vs test corpus)

Tune the tool freely against the `dev` corpus. BEFORE any reported run: build the `test` corpus, hand-verify **and evidence** its labels, set `"frozen": true` in its manifest, and run `citation:study:freeze test` (which warns about any scored human label still lacking a quotation). Complete the evidencing BEFORE freezing: the lock hashes `adjudications/*.json`, so every later evidence edit invalidates it. The `test` corpus is then run once per reported configuration; `runs/{run_id}/provenance.json` (git sha + dirty flag + model config) is the audit trail for every number in the paper.

## Things that invalidate results (the harness guards these, but know them)

- Study books must never carry `openalex_id` / `open_library_key` / `canonical_source_id` — Wave 3 local matching only considers rows that have them, which is what stops a fabricated reference resolving against another study book. The importer leaves them NULL and the runner's preflight asserts it.
- Re-runs must pass `--force` to the pipeline (the runner always does) or the 24h no-match cooldown silently reuses cached resolution verdicts.
- referenceIds are NOT stable across imports (Python set iteration order), which is why ground truth is text-keyed and bound after import; never hand-write `bound_reference_id`.
- Human EVIDENCE in `ground_truth.json` is a mirror, not the original. It survives regeneration via the carry-over in `CorpusManifest::saveGroundTruth` (keyed on `bib_text_hash|claim_snippet`), but that key changes if the source text does — in which case the quotes are dropped silently. The source of truth is `adjudications/{slug}.json`; re-run `citation:study:adjudications {corpus} --apply` to restore them.
- The completion email is sent without a try/catch — if your mailer is unreachable mid-run, the review succeeds and bills but the runner records the book as failed. Local Mailpit running, or `MAIL_MAILER=log`.
- The study user must have billing balance; a broke user runs fine but silently loses the per-run cost data (`billReview` is try/caught).
