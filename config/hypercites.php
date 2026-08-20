<?php

/*
 * Tunables for the journal citation-graph → hypercite candidate pipeline
 * (app/Services/Hypercites/*). Thresholds live here rather than as class
 * constants because the right values are properties of the CORPUS — a journal
 * whose style quotes in fragments wants a lower minimum quote length — and can
 * only be found by reviewing real candidates on /maintainer/hypercites.
 */
return [
    // QuoteDetector: an inline quoted span counts as a quote when its
    // normalized length is at least this many characters…
    'min_quote_chars' => env('HYPERCITE_MIN_QUOTE_CHARS', 20),

    // …and its closing quote mark sits within this many characters of the
    // citation marker (same node).
    'max_quote_marker_gap' => env('HYPERCITE_MAX_QUOTE_MARKER_GAP', 300),

    // Blockquote text is capped to this many characters for the cited-side
    // search (the full text is still stored on the candidate).
    'blockquote_search_cap' => env('HYPERCITE_BLOCKQUOTE_SEARCH_CAP', 600),

    // QuoteLocator stage B: minimum normalized similarity ratio for a fuzzy
    // (FTS-shortlisted) match to be accepted.
    'fuzzy_accept' => env('HYPERCITE_FUZZY_ACCEPT', 0.85),

    // AutoApprovePolicy: minimum normalized quote length for auto-approval.
    'auto_approve_min_quote_chars' => env('HYPERCITE_AUTO_APPROVE_MIN_QUOTE_CHARS', 40),

    // Batch-approve endpoint cap: kept synchronous, so bounded.
    'batch_approve_max' => env('HYPERCITE_BATCH_APPROVE_MAX', 25),
];
