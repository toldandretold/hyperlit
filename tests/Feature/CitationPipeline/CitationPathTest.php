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

/**
 * Every rail must NAME the work it chased. deloitte-2025-pdf/c06 cites two works in one footnote
 * — a Cth legislative instrument and the DSS Social Security Guide — and ran two independent
 * ladders with identical stations and identical "no match" dots. Nothing on screen said which
 * rail was about which work, so two distinct failures read as one failure of an unidentified
 * thing, and the only evidence of the subject was a Brave query inside a collapsed step.
 */
test('each rail of a multi-work footnote names its own work', function () {
    $path = CitationPath::build([
        'match_method' => null,
        'llm_metadata' => [
            'title'   => 'Social Security Administration (Non-Compliance) Determination 2018 (No 1) (Cth)',
            'authors' => ['Social Security Administration'],
            'year'    => 2018,
            // No type: on the live row the extractor did NOT classify this instrument as
            // legislation, so it ran the full ladder (Brave returned 0 results for the quoted
            // title). The legislation-typed variant is the pre-routing test below.
            'sub_citations' => [
                ['title' => 'Social Security Guide', 'authors' => ['Department of Social Services'],
                 'year' => 2025, 'type' => 'website'],
            ],
        ],
        'match_diagnostics' => [
            'trace' => [
                'steps' => [['stage' => 'brave_search_fallback', 'outcome' => 'no_match']],
                'subs'  => ['sub1' => [['stage' => 'brave_search_fallback', 'outcome' => 'no_match']]],
            ],
        ],
    ]);

    // The entry's own rail is work 1; the sub's rail is work 2. Both carry a human label.
    expect($path['works']['steps']['position'])->toBe(1)
        ->and($path['works']['steps']['total'])->toBe(2)
        ->and($path['works']['steps']['label'])->toContain('Non-Compliance')
        ->and($path['works']['steps']['searched'])->toBeTrue()
        ->and($path['works']['sub1']['position'])->toBe(2)
        ->and($path['works']['sub1']['label'])->toContain('Social Security Guide')
        ->and($path['works']['sub1']['label'])->toContain('Department of Social Services')
        ->and($path['works']['sub1']['searched'])->toBeTrue();
});

test('a pre-routed primary keeps its subs rails — the excluded work is not the whole footnote', function () {
    // The AGLC house style of this corpus cites an instrument alongside a searchable work
    // ("… Determination 2018 (No 1) (Cth); … Social Security Guide …"). Legislation pre-routes
    // (counted, never searched), and returning there with no subs deleted the rail of the ONLY
    // work that WAS searched — a two-work footnote rendering as one excluded citation.
    $path = CitationPath::build([
        'match_method' => null,
        'llm_metadata' => [
            'title' => 'Social Security Administration (Non-Compliance) Determination 2018 (No 1) (Cth)',
            'type'  => 'legislation',
            'year'  => 2018,
            'sub_citations' => [
                ['title' => 'Social Security Guide', 'authors' => ['Department of Social Services'],
                 'year' => 2025, 'type' => 'website'],
            ],
        ],
        'match_diagnostics' => [
            'trace' => ['subs' => ['sub1' => [['stage' => 'brave_search_fallback', 'outcome' => 'no_match']]]],
        ],
    ]);

    expect($path['steps'][0]['outcome'])->toBe('excluded_by_design')
        ->and($path['subs'])->toHaveKey('sub1')
        ->and($path['works']['sub1']['label'])->toContain('Social Security Guide')
        ->and($path['works']['sub1']['searched'])->toBeTrue();
});

test('a single-work citation gets no work headings — the rail can only be about the one work', function () {
    $path = CitationPath::build([
        'match_method' => 'openalex',
        'llm_metadata' => ['title' => 'Capital', 'authors' => ['Marx'], 'year' => 1867],
    ]);

    expect($path['works'])->toBe([]);
});

test('a title-less sub is reported as never searched, not as a work that could not be found', function () {
    // Pool expansion skips a sub with no title outright (CitationScanBibliographyJob), so it has
    // no rail and never will. Dropping it from the list would hide a pipeline failure entirely.
    $path = CitationPath::build([
        'match_method' => null,
        'llm_metadata' => [
            'title' => 'A Report', 'year' => 2020,
            'sub_citations' => [['authors' => ['Someone'], 'year' => 2021]],
        ],
        'match_diagnostics' => ['trace' => ['steps' => [['stage' => 'brave_search_fallback', 'outcome' => 'no_match']]]],
    ]);

    expect($path['works']['sub1']['searched'])->toBeFalse()
        ->and($path['works']['sub1']['skipped'])->toContain('never entered the resolver')
        ->and($path['works']['sub1']['label'])->toContain('no title extracted');
});

test('a titled sub with no rail is UNKNOWN, never "never searched"', function () {
    // A resolving PARENT retires its subs (removeRelatedPoolEntries), and pre-trace rows have no
    // sub rails at all — rendering either as "never ran" states more than the record supports.
    $path = CitationPath::build([
        'match_method' => 'openalex',
        'llm_metadata' => [
            'title' => 'A Report', 'year' => 2020,
            'sub_citations' => [['title' => 'A Second Work', 'year' => 2021,
                                 'resolution' => ['status' => 'matched']]],
        ],
        'match_diagnostics' => ['trace' => ['steps' => [['stage' => 'openalex_title_search', 'outcome' => 'newly_resolved']]]],
    ]);

    expect($path['works']['sub1']['searched'])->toBeNull()
        ->and($path['works']['sub1']['skipped'])->toBeNull()
        // A MATCHED sub still owns a work slot — SourceTypeClassifier::works() drops it (right
        // for a not-found assessment, wrong here), and its indices would desync from subN.
        ->and($path['works']['sub1']['status'])->toBe('matched')
        ->and($path['works']['sub1']['position'])->toBe(2);
});

test('a work split onto its own row by the review fan-out still says which of N it is', function () {
    $path = CitationPath::build([
        'match_method' => null,
        'cited_work_position' => 2,
        'cited_work_total' => 3,
        'llm_metadata' => ['title' => 'Social Security Guide', 'year' => 2025, 'split_from' => 'c06'],
    ]);

    expect($path['works']['steps']['position'])->toBe(2)
        ->and($path['works']['steps']['total'])->toBe(3);
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
