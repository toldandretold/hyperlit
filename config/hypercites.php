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

    /*
     * ───────────── Detection-run slicing: what one slice refuses to start ─────────────
     *
     * A detect run is a chain of budgeted slices (DetectHyperciteCandidatesJob::WORK_BUDGET),
     * and the expensive step inside one is `citation:scan-bibliography` — an LLM call plus
     * external lookups PER REFERENCE. The two values below exist because a slice that starts
     * work it cannot finish does not merely run late: it is killed at the job timeout, which
     * skips the catch block, which means no continuation is dispatched and the whole chain
     * ends silently. Measured on tripleC, 2026-09-14: one book ran 22 hours of good slices
     * into the ground.
     */

    // Refuse to bibliography-scan a book with more than this many extracted reference rows.
    //
    // The book that broke the tripleC run was "DOWNLOAD THE ENTIRE SPECIAL ISSUE HERE" — an
    // OJS whole-issue PDF with a real DOI, indexed by OpenAlex as `type: article`, whose
    // "bibliography" is every contributing article's reference list concatenated: 973 rows
    // (its siblings: 516, 453, 1997). There is NO usable upstream signal for these —
    // OpenAlex reports `is_paratext: false`, no page range, and `referenced_works_count: 5`.
    // The only honest discriminator is the one measured on our OWN extraction, which is why
    // the gate lives here and not in the harvester's work filter.
    //
    // A skipped book is not silently dropped, and detection is NOT skipped with it: only the
    // scan is refused, so whatever the book's bibliography already resolves to still yields
    // candidates. The skip is counted (`skipped_oversized`) and the book named in the log, so
    // an operator can scan it out-of-band — `php artisan citation:scan-bibliography <book>`
    // runs inline with no queue timeout over it — and the next run picks up the result.
    //
    // Default from the measured prod corpus (2026-09-14, 1,485 books with bibliographies):
    // p50 = 39 refs, p90 = 97, p99 = 508, max = 1,997. A 400 cut excludes 24 books (1.6%),
    // i.e. it sits above essentially every real article and below the bundles. Raising it
    // costs slice time; lowering it starts catching genuine reference-heavy monographs.
    'max_bibliography_scan_rows' => env('HYPERCITE_MAX_BIBLIOGRAPHY_SCAN_ROWS', 400),

    // Don't START a bibliography scan with less than this much slice budget left.
    //
    // The budget is otherwise only consulted BEFORE taking a new book, so a scan entered one
    // second inside the deadline runs unbounded past it — the exact overrun that killed the
    // run (slice budget 3000s, job timeout 3600s, actual 3600s+SIGKILL). Reserving a window
    // means the worst case is a scan that starts at `budget - reserve` and still lands inside
    // the job timeout. Deferred books are not lost: the next slice walks the list from the
    // top and picks them up first.
    'scan_reserve_seconds' => env('HYPERCITE_SCAN_RESERVE_SECONDS', 900),

    // How many times a FAILED slice may hand the baton on before the run is declared dead.
    //
    // Bounded because the failure might be the book rather than the weather: an unbounded
    // retry on a deterministic crash is an infinite chain that burns a worker forever. Two
    // continuations covers a transient LLM/network fault without papering over a real bug.
    'max_failure_continuations' => env('HYPERCITE_MAX_FAILURE_CONTINUATIONS', 2),
];
