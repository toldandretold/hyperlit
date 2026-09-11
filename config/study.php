<?php

/*
|--------------------------------------------------------------------------
| Citation Review evaluation study (citation:study:* commands)
|--------------------------------------------------------------------------
|
| Settings for the scientific evaluation harness that runs the citation
| pipeline over curated corpora and aggregates per-citation results
| against ground-truth labels. See app/Services/CitationStudy/.
|
*/

return [
    // User whose account study runs bill against (by users.name). Must exist
    // and have balance headroom — billReview() is try/caught, so a broke user
    // silently loses the per-run cost data the study needs.
    'user_name' => env('STUDY_USER_NAME', 'study'),

    // Seconds to pause between books in a run (politeness to external APIs).
    'throttle_seconds' => (int) env('STUDY_THROTTLE_SECONDS', 5),

    // Per-book pipeline subprocess limits. Memory covers pdfparser inflating
    // large fetched sources (the default 512M OOMs); the timeout bounds a
    // wedged fetch, not normal long runs.
    'memory_limit' => env('STUDY_MEMORY_LIMIT', '2G'),
    'book_timeout_seconds' => (int) env('STUDY_BOOK_TIMEOUT', 6 * 3600),

    // Root of corpora + results, relative to base_path().
    'root' => 'study',
];
