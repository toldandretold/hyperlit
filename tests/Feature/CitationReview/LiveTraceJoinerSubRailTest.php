<?php

/**
 * A multi-work fan-out row ("{parent}::subN") is not a live footnote row, so
 * the live-trace join used to find nothing for it and the workbench rendered
 * "path not recorded" — while the parent's trace carried the sub's full rail
 * under trace.subs. The joiner now lifts that rail into the sub claim's own
 * trace (and never overwrites a trace the claim already carries).
 */

use App\Services\CitationReview\Support\LiveTraceJoiner;

it('lifts a sub rail out of the parent live trace onto the fan-out row', function () {
    $liveTraces = [
        'fn9' => [
            'steps' => [['stage' => 'printed_url_fetch', 'outcome' => 'newly_resolved']],
            'subs' => ['sub1' => [
                ['stage' => 'openalex_title_search', 'outcome' => 'no_match'],
                ['stage' => 'printed_url_fetch', 'outcome' => 'newly_resolved'],
            ]],
        ],
    ];
    $claims = [
        ['referenceId' => 'fn9'],
        ['referenceId' => 'fn9::sub1'],
        ['referenceId' => 'fn9::sub2'], // no recorded rail — stays traceless
        ['referenceId' => 'other'],
    ];

    $merged = (new LiveTraceJoiner)->merge($claims, $liveTraces);

    expect($merged[0]['match_diagnostics']['trace']['steps'][0]['stage'])->toBe('printed_url_fetch')
        ->and(array_column($merged[1]['match_diagnostics']['trace']['steps'], 'stage'))
        ->toBe(['openalex_title_search', 'printed_url_fetch'])
        ->and($merged[1]['match_diagnostics']['trace']['subs'])->toBe([])
        ->and($merged[2])->not->toHaveKey('match_diagnostics')
        ->and($merged[3])->not->toHaveKey('match_diagnostics');
});

it('follows short_form_of so an Ibid row carries its antecedent’s journey', function () {
    // The Ibid footnote (fn10) inherited fn9; fn9's row holds the real rails.
    $liveTraces = [
        'fn9' => [
            'steps' => [['stage' => 'printed_url_fetch', 'outcome' => 'newly_resolved']],
            'subs' => ['sub1' => [['stage' => 'brave_search_fallback', 'outcome' => 'newly_resolved']]],
        ],
    ];
    $claims = [
        [
            'referenceId' => 'fn10',
            'match_method' => 'short_form_antecedent',
            'llm_metadata' => ['short_form_of' => 'fn9'],
        ],
        [
            // The fan-out sub row: its own meta has no short_form_of — the
            // antecedent comes from its parent claim in the same set.
            'referenceId' => 'fn10::sub1',
            'match_method' => 'short_form_antecedent',
            'llm_metadata' => [],
        ],
    ];

    $merged = (new LiveTraceJoiner)->merge($claims, $liveTraces);

    expect($merged[0]['match_diagnostics']['trace']['steps'][0]['stage'])->toBe('printed_url_fetch')
        // The parent also carries the antecedent's sub rails, so its per-work display works.
        ->and($merged[0]['match_diagnostics']['trace']['subs']['sub1'][0]['stage'])->toBe('brave_search_fallback')
        ->and($merged[1]['match_diagnostics']['trace']['steps'][0]['stage'])->toBe('brave_search_fallback');
});

it('never overwrites a trace the claim already carries', function () {
    $own = ['steps' => [['stage' => 'brave_search_fallback', 'outcome' => 'no_match']], 'subs' => []];
    $claims = [['referenceId' => 'fn9::sub1', 'match_diagnostics' => ['trace' => $own]]];
    $liveTraces = ['fn9' => ['steps' => [], 'subs' => ['sub1' => [['stage' => 'doi_from_text', 'outcome' => 'routed']]]]];

    $merged = (new LiveTraceJoiner)->merge($claims, $liveTraces);

    expect($merged[0]['match_diagnostics']['trace'])->toBe($own);
});
