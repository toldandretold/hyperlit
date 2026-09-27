<?php

/**
 * CitationPath is the ONE data model behind the workbench path view and the reader-facing
 * report figure, so what it must not do is lie in either direction: a pre-routed citation must
 * not look like a ladder failure, and a row scanned before tracing existed must read as "not
 * recorded", never as "did not run". Both mistakes produce a confident diagram of something
 * that never happened — the exact failure class this whole visibility effort exists to end.
 */

use App\Services\CitationReview\Support\CitationPath;

test('a traced citation renders its real steps, decorated from the map', function () {
    $path = CitationPath::build([
        'match_method' => 'web_fetch',
        'match_diagnostics' => [
            'trace' => [
                'steps' => [
                    ['stage' => 'doi_from_text', 'outcome' => 'routed'],
                    ['stage' => 'printed_url_fetch', 'outcome' => 'newly_resolved', 'method' => 'web_fetch'],
                ],
            ],
        ],
    ]);

    expect($path['recorded'])->toBeTrue()
        ->and(array_column($path['steps'], 'stage'))->toBe(['doi_from_text', 'printed_url_fetch'])
        ->and($path['steps'][1]['label_plain'])->not->toBe('printed_url_fetch') // decorated, not the raw id
        ->and($path['steps'][1]['source_url'])->toStartWith('https://github.com/toldandretold/hyperlit/')
        ->and($path['steps'][1]['recorded'])->toBeTrue();
});

test('a short form is a pre-routing journey, not a ladder failure', function () {
    // 13 of deloitte's 132 rows end here BY DESIGN — rendering them as "no wave matched"
    // would be a diagram of a search that deliberately never ran.
    $path = CitationPath::build(['match_method' => 'short_form_antecedent']);

    expect(array_column($path['steps'], 'stage'))->toBe(['short_form'])
        ->and($path['steps'][0]['outcome'])->toBe('inherited_antecedent');
});

test('legislation is excluded, and only when nothing resolved it', function () {
    expect(CitationPath::build([
        'match_method' => null,
        'llm_metadata' => ['type' => 'legislation'],
    ])['steps'][0]['stage'])->toBe('legal_excluded')
        // ...but a legislation row that DID resolve somehow shows its real method, not the exclusion.
        ->and(CitationPath::build([
            'match_method' => 'library',
            'match_score'  => 0.9,
            'llm_metadata' => ['type' => 'legislation'],
        ])['steps'][0]['stage'])->toBe('local_library_title');
});

test('a non-citation ends at classification', function () {
    $path = CitationPath::build(['is_citation' => false]);

    expect(array_column($path['steps'], 'stage'))->toBe(['classify'])
        ->and($path['steps'][0]['outcome'])->toBe('not_a_citation');
});

test('a pre-trace resolved row synthesizes ONE step and marks it not recorded', function () {
    // Rows scanned before tracing landed carry only match_method. The path says what that
    // column testifies to and no more — recorded: false is the renderer's cue for "not
    // recorded", which must never display as "did not run".
    $path = CitationPath::build(['match_method' => 'brave_search', 'match_score' => 0.71]);

    expect($path['recorded'])->toBeFalse()
        ->and($path['steps'])->toHaveCount(1)
        ->and($path['steps'][0]['stage'])->toBe('brave_search_fallback')
        ->and($path['steps'][0]['recorded'])->toBeFalse()
        ->and($path['steps'][0]['score'])->toBe(0.71);
});

test('a pre-trace UNresolved row is a bare no_match, still marked not recorded', function () {
    $path = CitationPath::build(['match_method' => null]);

    expect($path['steps'][0]['stage'])->toBe('no_match')
        ->and($path['recorded'])->toBeFalse();
});

test('sub-citation traces ride along, decorated the same way', function () {
    $path = CitationPath::build([
        'match_method' => 'openalex',
        'match_diagnostics' => [
            'trace' => [
                'steps' => [['stage' => 'openalex_title_search', 'outcome' => 'newly_resolved']],
                'subs'  => ['sub1' => [['stage' => 'openalex_title_search', 'outcome' => 'no_match']]],
            ],
        ],
    ]);

    expect($path['subs'])->toHaveKey('sub1')
        ->and($path['subs']['sub1'][0]['label_plain'])->not->toBe('openalex_title_search');
});

test('every legacy match_method in the database maps to a real map station', function () {
    // The mapping bridges rows scanned before tracing to the diagram; a method it does not
    // know renders as a bare no_match, silently wrong for that row.
    $ref = new ReflectionClass(CitationPath::class);
    $map = $ref->getConstant('METHOD_TO_STAGE');
    $stageIds = \App\Services\CitationPipeline\ResolutionLadderMap::stageIds();

    foreach ($map as $method => $stageId) {
        expect(in_array($stageId, $stageIds, true))
            ->toBeTrue("METHOD_TO_STAGE['{$method}'] points at unknown stage '{$stageId}'");
    }

    // The methods observed across the live database (2026-09-27), minus the pre-routing ones
    // CitationPath handles by name.
    foreach (['local_doi', 'doi', 'library', 'openalex', 'open_library', 'semantic_scholar',
              'openalex_referenced', 'web_fetch', 'brave_search'] as $method) {
        expect($map)->toHaveKey($method);
    }
});
