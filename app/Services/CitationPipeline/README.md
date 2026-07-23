# Citation Pipeline — observability ("review the review")

The citation review pipeline now instruments itself, the same philosophy as
the conversion pipeline's `pipeline_map.json` / node_help notes — but **live
and user-visible**: while a review runs, the book page shows a horizontal
stage chain driven by real emissions from the code that is executing.

## The pieces

- **`PipelineMap`** (`PipelineMap.php`) — THE stage registry: 5 top-level stages (bibliography → content → vacuum → ocr → review) + 8 review sub-stages. Each carries a `plain` note (user-facing), a `dev` note, a `code_ref`, and expected `signals`.
- **`PipelineTelemetry`** (`PipelineTelemetry.php`) — append-only event stream on `citation_pipelines.telemetry` (JSONB): `{stage, substage, status, detail, signals, at}`. Statuses: started / progress / completed / failed / skipped. Capped at 400 events; **never throws into the pipeline** (best-effort by design); null pipeline-id = no-op.
- **Emitters** — `CitationPipelineCommand` (step transitions, per-source progress, failures, skips), `CitationReviewCommand` ($onProgress → review sub-stage events). The code gives off the signals as it works.
- **API** — `GET /api/citation-pipeline/map` (static map), `GET /api/citation-pipeline/status/{id}` (now includes `telemetry` + `step_timings`). What the frontend polls.
- **Viz** — `resources/js/components/sourceButton.js` (`ensureAiReviewLivePanel` / `renderPipelineViz`). Under the "Reviewing…" button: *results-by-email* note + "See live processing pipeline". Opens a horizontal chip chain (done ✓ aqua / running ● pulsing orange / failed ✗ red / skipped –), latest detail line, and click-a-stage to expand its plain note, latest signals, sub-stages, and `code_ref`. Polling tightens to 5s while open.
- **`PipelineFailureNotifier`** (`PipelineFailureNotifier.php`) — terminal-failure emails (user apology + maintainer bug report); see the section below.

## Anti-drift (the contract)

`tests/Feature/CitationPipeline/PipelineMapDriftTest.php` fails when:
- a stage id in the map stops matching the `updatePipelineStep('…')` literals
  in `CitationPipelineCommand`;
- a review sub-stage stops matching the `$progress('…')` phase keys in
  `CitationReviewService`;
- a `code_ref` stops resolving to a real file/method;
- a stage loses its `plain` note.

So: **add a stage to the pipeline = add it to the map**, or the suite goes red.
The viz and the dev code-ref panel then pick it up with zero frontend changes.

## Failure modes (tested)

`tests/Feature/Api/CitationPipelineLifecycleTest.php` +
`tests/Feature/CitationPipeline/PipelineTelemetryTest.php` lock:
- stale auto-fail: pending > 5 min or running with no progress > 3 h → the
  status poll flips the run to `failed` (a wedged pipeline can't block a book);
- resume only from `failed` (422 otherwise), re-queues the job and resets state;
- trigger returns 409 while a run is active (and pushes nothing);
- telemetry: ordered append across emitter instances (each command in the
  chain appends to the same stream), cap + trim marker, no-op without a
  pipeline id, missing row never throws.

Run them: `php artisan test tests/Feature/CitationPipeline tests/Feature/Api/CitationPipelineLifecycleTest.php`

## Terminal-failure notification (never leave the user in the breach)

`PipelineFailureNotifier` fires at every terminal seam — `CitationPipelineJob::failed()` (retries exhausted), the stale auto-fail in the status poll, and `citation:review`'s empty-result paths (no resolved sources / 0 claims, which now settle the run as **failed** instead of a silent "completed" with no report and no email — the 2026-07-23 incident). It sends the user an apology email (`CitationReviewFailedMail`: what happened, not charged, we've been notified) and the maintainer a bug report (`CitationPipelineBugReportMail` → `config('mail.maintainer_alert')`: pipeline row, step timings, telemetry tail inline + full stream attached). At-most-once via the `failure_notified_at` latch (claimed atomically); best-effort like `PipelineTelemetry` — never throws into the caller. Both mails send synchronously on purpose: the apology must not depend on the queue machinery whose failure it may be reporting. Empty-result runs exit 0 (a non-zero exit would make the job retry and re-burn the vacuum/OCR spend on a deterministic result); the job's completed-update is status-guarded so it can't overwrite the settled failure, and `finalizeStepTimings` skips its `review completed` emit when the run is already failed (else the viz repaints the failed stage green). Tested: `tests/Feature/CitationPipeline/PipelineFailureNotifierTest.php`.

## Why per-stage failure isn't always pipeline failure

vacuum/OCR failures are **per-source** (emitted as progress events with a
"failed: …" detail; the run continues). bibliography/content/review failures
abort the run (emitted as stage `failed`, pipeline status → failed, the viz
paints that stage red with the error). This mirrors the conversion pipeline's
"assessment = flag, not verdict" stance: the trace tells you where to look,
the human judges.

## Related

- Canonical versions authority layer: `app/Services/CanonicalVersions/README.md`
  (the review's provenance tiers read through it).
- Conversion pipeline's map machinery (the pattern this follows):
  `tests/conversion/PIPELINE_MAP.md`, `gen_pipeline_tree.py`.
