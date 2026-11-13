<?php

/**
 * The operator workbenches, listed ONCE.
 *
 * Rendered by the /maintainer index page (resources/views/maintainer-index.blade.php).
 * These pages were built one at a time and several were linked from nowhere —
 * that is how they got forgotten. Adding a workbench means adding it here;
 * tests/Feature/Api/MaintainerIndexTest.php fails if a parameterless
 * /maintainer page route is missing from this list (or an entry points at a
 * route that no longer exists).
 *
 * Grouped by what the tool is FOR. See docs/workbenches.md.
 */

return [
    'Conversion quality' => [
        [
            'name' => 'Conversion triage',
            'url' => '/maintainer/conversion',
            'purpose' => 'Flagged conversions: the book beside its original source. Resolve, reconvert, retract, download a case bundle.',
        ],
        [
            'name' => 'Ambiguous citations',
            'url' => '/maintainer/citations',
            'purpose' => 'Bare-year citations that fit more than one bibliography entry. Answer once; reconverts re-apply it.',
        ],
        [
            'name' => 'Conversion regression tests',
            'url' => '/dev/conversion-tests',
            'purpose' => 'The regression fixture corpus: coverage by footnote strategy, run the suite, add a fixture.',
        ],
    ],
    'Corpus building' => [
        [
            'name' => 'Journal import',
            'url' => '/maintainer/journal-import',
            'purpose' => 'Per journal: enumerate, import, compare the pdf / html / ar5iv lanes, promote a version, certify.',
        ],
        [
            'name' => 'Shelf import',
            'url' => '/maintainer/shelf-import',
            'purpose' => 'The journal-import workflow over any public shelf, including the "Cited by:" shelves.',
        ],
        [
            'name' => 'Hypercites',
            'url' => '/maintainer/hypercites',
            'purpose' => 'Detect citations between held works in a journal or shelf, review side by side, mint hypercites, import the most-cited sources.',
        ],
    ],
    'Research' => [
        [
            'name' => 'Citation study',
            'url' => '/maintainer/study',
            'purpose' => 'Adjudicate the AI citation review against a hand-curated corpus: verdicts, failure causes, evidence.',
        ],
    ],
    'Operations' => [
        [
            'name' => 'Job failures',
            'url' => '/maintainer/jobs',
            'purpose' => 'Failed queue jobs grouped by what actually broke. Retry, forget, or export a case bundle.',
        ],
        [
            'name' => 'Storage',
            'url' => '/maintainer/storage',
            'purpose' => 'What is stored and how much of it is waste: by category, by user, orphans, deleted content.',
        ],
        [
            'name' => 'Reading stats',
            'url' => '/maintainer/stats',
            'purpose' => 'Site-wide reading analytics: views, likes and reading depth, daily and by book.',
        ],
    ],
];
