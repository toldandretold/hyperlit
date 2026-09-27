<?php

/**
 * The reader's version of the path. What it must never do: bury the story in machine steps, or
 * state more than the record supports. A resolved citation reads as ONE sentence naming where
 * and how; an unresolved one says what was tried AND that "not found" is a fact about our
 * search; evidence worth a reader's attention (the fetched URL's fate, refused look-alikes)
 * surfaces even from failed steps; and a pre-trace row is labelled as such.
 */

use App\Services\CitationReview\Support\CitationPath;

test('a resolved citation summarizes to one identified row naming the route and the cost', function () {
    $s = CitationPath::summarize([
        'match_method' => 'web_fetch',
        'match_diagnostics' => ['trace' => ['steps' => [
            ['stage' => 'doi_from_text', 'outcome' => 'routed'],
            ['stage' => 'local_library_title', 'outcome' => 'no_match'],
            ['stage' => 'openalex_title_search', 'outcome' => 'no_match'],
            ['stage' => 'printed_url_fetch', 'outcome' => 'newly_resolved', 'method' => 'web_fetch'],
        ]]],
    ]);

    $ladder = collect($s['rows'])->firstWhere('band', 'ladder');
    expect($ladder['kind'])->toBe('resolved')
        ->and($ladder['text'])->toContain('Identified')
        ->and($ladder['text'])->toContain('after 2 cheaper routes found nothing')
        ->and($ladder['source_url'])->toStartWith('https://github.com/');
});

test('an unresolved citation counts what was tried and refuses to overclaim', function () {
    $s = CitationPath::summarize([
        'match_method' => null,
        'match_diagnostics' => ['trace' => ['steps' => [
            ['stage' => 'local_library_title', 'outcome' => 'no_match'],
            ['stage' => 'openalex_title_search', 'outcome' => 'no_match'],
            ['stage' => 'brave_search_fallback', 'outcome' => 'no_match'],
        ]]],
    ]);

    $ladder = collect($s['rows'])->firstWhere('band', 'ladder');
    expect($ladder['kind'])->toBe('nomatch')
        ->and($ladder['text'])->toContain('3 routes tried')
        ->and($ladder['text'])->toContain('not proof the citation is wrong');
});

test('the fetched URL\'s fate and refused look-alikes surface as evidence rows', function () {
    $s = CitationPath::summarize([
        'match_method' => null,
        'match_diagnostics' => ['trace' => ['steps' => [
            ['stage' => 'printed_url_fetch', 'outcome' => 'no_match',
             'detail' => ['web_fetch' => ['outcome' => 'blocked', 'http_status' => 403]]],
            ['stage' => 'brave_search_fallback', 'outcome' => 'no_match',
             'detail' => ['brave' => ['refused' => [
                 ['url' => 'https://look-alike.example/x', 'why' => 'host_differs_from_cited_url'],
                 ['url' => 'https://junk.example/y', 'why' => 'weak_title'],
             ]]]],
        ]]],
    ]);

    $texts = array_column($s['rows'], 'text');
    expect(implode(' ', $texts))->toContain('blocked (HTTP 403)')
        ->and(implode(' ', $texts))->toContain('1 look-alike page')
        ->and(implode(' ', $texts))->toContain('not the source');
});

test('a short form is one story row, not a ladder narration', function () {
    $s = CitationPath::summarize(['match_method' => 'short_form_antecedent']);

    expect($s['rows'])->toHaveCount(1)
        ->and($s['rows'][0]['question'])->toBe('What is the citation?')
        ->and($s['rows'][0]['text'])->toContain('inherits the work');
});

test('a pre-trace row carries the not-recorded caveat', function () {
    $s = CitationPath::summarize(['match_method' => 'openalex', 'match_score' => 0.8]);

    expect($s['recorded'])->toBeFalse()
        ->and(collect($s['rows'])->firstWhere('kind', 'notrecorded')['text'])
        ->toContain('before per-step tracing existed');
});

test('the questions are the bands\' — one vocabulary across map, workbench and report', function () {
    $bands = collect(\App\Services\CitationPipeline\ResolutionLadderMap::bands())->keyBy('id');
    $s = CitationPath::summarize(['match_method' => null,
        'match_diagnostics' => ['trace' => ['steps' => [['stage' => 'local_library_title', 'outcome' => 'no_match']]]]]);

    foreach ($s['rows'] as $row) {
        if ($row['kind'] === 'notrecorded') continue;
        expect($row['question'])->toBe($bands[$row['band']]['question']);
    }
});
