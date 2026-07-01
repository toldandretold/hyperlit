# CitationReview

The AI citation-review pipeline, decomposed from the old 2,500-line `App\Services\CitationReviewService` god-class. That class still exists at `app/Services/CitationReviewService.php` but is now a **thin coordinator**: it sequences the phases, owns all `$progress()` emission, and delegates report building + publishing. Every unit of real work lives in a focused collaborator here.

## Mental model

`CitationReviewService::review($bookId)` runs six phases in order, threading the claims array through them:

1. **`Phases\CitationParser`** — find body nodes carrying citations (inline `<a href="#refId">` + footnote `<sup>` markers), mark them, extract reference ids + char positions + claim spans. *(Phase 1 — `parse`)*
2. **`Phases\MetadataEnricher`** — resolve each referenceId to its source metadata + provenance tier (canonical-verified > web-verified > local > unverified), choosing the best version with content. *(Phase 2 — `enrich`)*
3. **`Phases\TruthClaimExtractor`** — LLM extracts the verbatim factual claim each citation supports; non-verbatim claims are discarded, never invented. *(Phase 3 — `extract`)*
4. **`Phases\PassageSearcher`** — Postgres FTS (3-strategy escalation) finds source passages relevant to each claim. *(Phase 4 — `passages`)*
5. **`Phases\ClaimVerifier`** — LLM judges each claim against the evidence; rejected verdicts get a false-negative re-review. *(Phase 5 — `verify`)*
6. **`Phases\VerificationHighlighter`** — writes a highlight + reasoning sub-book per verdict. *(Phase 6 — `highlights`)*

Then `regenerateReport()` (also the `--report-only` entry point) runs highlights → **`Report\ReportBuilder`** (`report`) → **`Import\ReportSubBookImporter`** (`import`).

Supporting cast:

- **`Report\`** — `ReportBuilder` assembles the full markdown; `ClaimMarkdownFormatter` formats each claim block (source line, provenance, match diagnostics); `AppendixBuilder` builds the diagnostics appendix.
- **`Matching\FootnoteCitationMapper`** — maps footnotes → bibliography refIds (used by `CitationParser`).
- **`Support\`** — stateless leaves, each independently unit-tested: `SourceUrlResolver`, `SourceHtmlBuilder`, `TitleSimilarity`, `TextNormaliser`, `ClaimSpanExtractor`, `AuthorName`, `SearchTerms`, `DurationFormatter`.

All collaborators are concrete classes wired by constructor injection — the container autowires them, no `AppServiceProvider` bindings needed. The one exception is `LlmService`, which **must stay a singleton** (bound in `AppServiceProvider`): the LLM phases share it so their usage counters roll up into `getLlm()->getUsageStats()` for the appendix + billing.

## How to add a phase

1. Add a `Phases\YourPhase` class with the work; inject the services/support leaves it needs.
2. Wire it into `CitationReviewService::review()` — call it and emit its `$progress('<key>', …)` line **from the coordinator** (LLM phases take a message-only `callable $emit` and the coordinator binds the key, so no `$progress('<key>')` literal leaks into a collaborator).
3. Add a substage to `app/Services/CitationPipeline/PipelineMap.php` with a `code_ref` pointing at `app/Services/CitationReview/Phases/YourPhase.php::yourMethod` and its `plain` note.
4. The drift gate (`tests/Feature/CitationPipeline/PipelineMapDriftTest.php`) enforces: the `$progress()` phase keys in the coordinator must match the map's substage ids, and every `code_ref` must resolve.

## Safety net

- `tests/Feature/CitationPipeline/ReportGoldenSnapshotTest.php` — byte-for-byte snapshot of the report markdown across a full-branch fixture. Regenerate deliberately with `UPDATE_SNAPSHOTS=1`.
- `tests/Feature/CitationPipeline/LlmUsageStatsSurviveTest.php` — guards the `LlmService` singleton (billing/usage).
- Per-collaborator tests under `tests/Unit/CitationReview/Support/` and `tests/Feature/CitationPipeline/`, plus the canonical-provenance + footnote-span suites under `tests/Canonical/`.
