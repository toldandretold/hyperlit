<?php

/**
 * CitationReview\Phases\VerificationHighlighter — Phase 6.
 * Extracted from CitationReviewService::createVerificationHighlights. Mocks
 * BackendHighlightService to capture the highlight payloads without touching
 * the highlight write path.
 */

use App\Services\BackendHighlightService;
use App\Services\CitationReview\Phases\VerificationHighlighter;

function fakeHighlights(array &$captured)
{
    $mock = Mockery::mock(BackendHighlightService::class);
    $mock->shouldReceive('deleteHighlightsByCreator')->once();
    $mock->shouldReceive('createHighlight')->andReturnUsing(function ($payload) use (&$captured) {
        $captured[] = $payload;
        return 'HL_' . count($captured);
    });
    return $mock;
}

test('clears prior AIreview highlights before writing', function () {
    $captured = [];
    $mock = Mockery::mock(BackendHighlightService::class);
    $mock->shouldReceive('deleteHighlightsByCreator')->once()->with('book1', 'AIreview:');
    $mock->shouldReceive('createHighlight')->andReturn(['id' => 1]);
    $svc = new VerificationHighlighter($mock, app(\App\Services\CitationReview\Support\SourceHtmlBuilder::class));

    $claims = [];
    $svc->createVerificationHighlights($claims, 'book1');
    // Mockery ->once() expectation verified on teardown.
    expect(true)->toBeTrue();
});

test('a confirmed verdict produces a highlight with the confirmed colour', function () {
    $captured = [];
    $svc = new VerificationHighlighter(fakeHighlights($captured), app(\App\Services\CitationReview\Support\SourceHtmlBuilder::class));

    $claims = [[
        'node_id' => 'n1', 'referenceId' => 'r1', 'truth_claim' => 'A claim.',
        'charStart' => 0, 'charEnd' => 8, 'verified_source' => true,
        'llm_verdict' => ['support' => 'confirmed', 'summary' => 'ok', 'reasoning' => 'because'],
    ]];
    $count = $svc->createVerificationHighlights($claims, 'book1');

    expect($count)->toBe(1);
    expect($claims[0]['has_highlight'])->toBeTrue();
    expect($captured[0]['subBookTitle'])->toBe('AI Review: Confirmed');
    expect($captured[0]['subBookContent'][0]['content'])->toContain('#27ae60');
});

test('an unresolved source produces a Source Not Found highlight', function () {
    $captured = [];
    $svc = new VerificationHighlighter(fakeHighlights($captured), app(\App\Services\CitationReview\Support\SourceHtmlBuilder::class));

    $claims = [[
        'node_id' => 'n1', 'referenceId' => 'r1', 'truth_claim' => 'Unfound claim.',
        'charStart' => 0, 'charEnd' => 5, 'verified_source' => false,
        'bib_citation' => '<p>Ghost (1999)</p>',
    ]];
    $count = $svc->createVerificationHighlights($claims, 'book1');

    expect($count)->toBe(1);
    expect($captured[0]['subBookTitle'])->toBe('AI Review: Source Not Found');
    expect($captured[0]['subBookContent'][0]['content'])->toContain('#9b59b6');
});

test('insufficient-evidence claims are skipped', function () {
    $captured = [];
    $svc = new VerificationHighlighter(fakeHighlights($captured), app(\App\Services\CitationReview\Support\SourceHtmlBuilder::class));

    $claims = [[
        'node_id' => 'n1', 'referenceId' => 'r1', 'truth_claim' => 'x',
        'charStart' => 0, 'charEnd' => 1, 'verified_source' => true,
        'llm_verdict' => ['support' => 'insufficient'],
    ]];
    $count = $svc->createVerificationHighlights($claims, 'book1');

    expect($count)->toBe(0);
    expect($captured)->toBeEmpty();
});
