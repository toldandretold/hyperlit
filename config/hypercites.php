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
    // search. The text is cleaned first (QuoteDetector::blockquoteText strips
    // the citing author's trailing attribution, enclosing marks and paragraph-
    // join glue), so the cap falls on real quoted words. Consequence: a
    // blockquote longer than the cap mints a hypercite whose cited-side
    // highlight covers the PREFIX, not the whole passage.
    'blockquote_search_cap' => env('HYPERCITE_BLOCKQUOTE_SEARCH_CAP', 600),

    // NOT a tunable — a known, measured gap, recorded so the next person starts
    // from the measurement. Detection is marker-driven (CandidateDetector walks
    // CitationParser's citationPositions), so a blockquote whose introducing
    // sentence carries no LINKED citation is invisible however the thresholds
    // are set: "Harold Borko describes information science as:", "To quote
    // Chatman:". Measured on the local corpus: 2,230 of 11,279 blockquote nodes
    // are introduced by a colon sentence with no marker in it, and 1,697 have
    // no marker in the block or either neighbour at all. Note this needs
    // pgsql_admin to count — under RLS you see a fraction of the corpus and
    // will badly understate it. Reaching them needs a marker-independent pass resolving the
    // intro's author name (+year where present) against the book's
    // bibliography — the matcher already exists as
    // FootnoteCitationMapper::matchFootnoteTextToBibliography.

    // QuoteLocator stage B: minimum normalized similarity ratio for a fuzzy
    // (FTS-shortlisted) match to be accepted.
    'fuzzy_accept' => env('HYPERCITE_FUZZY_ACCEPT', 0.85),

    // How many located occurrences of one quote are kept for the console's
    // occurrence picker (ranked best-first, so the cut falls on the least
    // likely). A corpus property: a phrase that recurs 40 times in its source
    // is not a phrase a reviewer picks a location for by eye — past a dozen the
    // useful signal is "this quote is too generic to anchor", not the 13th
    // span. `match_occurrences` reports the KEPT count so the picker's "3 / 9"
    // and the ambiguity warning can never disagree.
    'max_match_locations' => env('HYPERCITE_MAX_MATCH_LOCATIONS', 12),

    // AutoApprovePolicy: minimum normalized quote length for auto-approval.
    'auto_approve_min_quote_chars' => env('HYPERCITE_AUTO_APPROVE_MIN_QUOTE_CHARS', 40),

    // Batch-approve endpoint cap: kept synchronous, so bounded.
    'batch_approve_max' => env('HYPERCITE_BATCH_APPROVE_MAX', 25),
];
