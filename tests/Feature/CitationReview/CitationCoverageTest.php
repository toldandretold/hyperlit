<?php

use App\Services\CitationReview\Support\CitationCoverage;

/**
 * Review COVERAGE — how many of a book's citations the review actually examined.
 *
 * The bug this exists for is a silence, not an error. A citation that produces no truth claim
 * produces no row, no verdict and no highlight, so a reader counting verdicts cannot tell "checked
 * and supported" from "never looked at". Measured on the 2026-09-18 phase2 run: up to 9% of
 * correctly-LINKED citations were in that state (nicholls-nieo-paste 6 of 66, chacko-2025-pdf 12 of
 * 228, barnett-2020-paste 0 of 26).
 */
function coverageNode(array $overrides = []): array
{
    return array_merge([
        'node_id' => 'n1',
        'plainText' => 'Alpha claims X (A 2001). Beta asserts Y (B 2002).',
        'reference_ids' => ['a2001', 'b2002'],
        'citationPositions' => ['a2001' => 16, 'b2002' => 41],
        'extracted_sentences' => [
            'a2001' => 'Alpha claims X (A 2001).',
            'b2002' => 'Beta asserts Y (B 2002).',
        ],
    ], $overrides);
}

it('reports full coverage when every citation produced a claim', function () {
    $result = app(CitationCoverage::class)->assess([coverageNode()], [
        ['node_id' => 'n1', 'referenceId' => 'a2001'],
        ['node_id' => 'n1', 'referenceId' => 'b2002'],
    ]);

    expect($result['instances'])->toBe(2)
        ->and($result['matched'])->toBe(2)
        ->and($result['unmatched'])->toBe(0)
        ->and($result['rate'])->toBe(1.0)
        ->and($result['details'])->toBe([]);
});

it('names the citation that produced no claim, with the span to highlight', function () {
    $result = app(CitationCoverage::class)->assess([coverageNode()], [
        ['node_id' => 'n1', 'referenceId' => 'a2001'],
    ]);

    expect($result['instances'])->toBe(2)
        ->and($result['matched'])->toBe(1)
        ->and($result['unmatched'])->toBe(1)
        ->and($result['rate'])->toBe(0.5)
        ->and($result['details'])->toHaveCount(1);

    $gap = $result['details'][0];
    // The span must cover the SENTENCE, so the highlight marks the same text a successful claim
    // would have marked — not merely the citation's own offset.
    expect($gap['referenceId'])->toBe('b2002')
        ->and($gap['sentence'])->toBe('Beta asserts Y (B 2002).')
        ->and(mb_substr(coverageNode()['plainText'], $gap['charStart'], $gap['charEnd'] - $gap['charStart']))
        ->toBe('Beta asserts Y (B 2002).');
});

it('counts a claim as covering only its OWN node', function () {
    // A reference cited in two paragraphs must be matched per paragraph: a claim extracted from one
    // says nothing about the other, and crediting it would hide a real gap.
    $nodes = [
        coverageNode(),
        coverageNode(['node_id' => 'n2', 'reference_ids' => ['a2001'], 'citationPositions' => ['a2001' => 16]]),
    ];

    $result = app(CitationCoverage::class)->assess($nodes, [
        ['node_id' => 'n1', 'referenceId' => 'a2001'],
        ['node_id' => 'n1', 'referenceId' => 'b2002'],
    ]);

    expect($result['instances'])->toBe(3)
        ->and($result['matched'])->toBe(2)
        ->and($result['details'][0]['node_id'])->toBe('n2')
        ->and($result['details'][0]['referenceId'])->toBe('a2001');
});

it('counts distinct unmatched SOURCES separately from instances', function () {
    // The same work unmatched in three places is one source to chase, but three unreviewed
    // citations — the report needs both numbers.
    $nodes = [
        coverageNode(['reference_ids' => ['a2001']]),
        coverageNode(['node_id' => 'n2', 'reference_ids' => ['a2001']]),
        coverageNode(['node_id' => 'n3', 'reference_ids' => ['a2001']]),
    ];

    $result = app(CitationCoverage::class)->assess($nodes, []);

    expect($result['unmatched'])->toBe(3)
        ->and($result['unmatched_refs'])->toBe(1);
});

it('survives a citation with no resolvable position rather than inventing a span', function () {
    $nodes = [coverageNode([
        'reference_ids' => ['a2001', 'ghost1999'],
        'citationPositions' => ['a2001' => 16],
        'extracted_sentences' => ['a2001' => 'Alpha claims X (A 2001).'],
    ])];

    $result = app(CitationCoverage::class)->assess($nodes, [
        ['node_id' => 'n1', 'referenceId' => 'a2001'],
    ]);

    expect($result['unmatched'])->toBe(1);
    $gap = $result['details'][0];
    expect($gap['referenceId'])->toBe('ghost1999')
        ->and($gap['charStart'])->toBeNull()
        ->and($gap['charEnd'])->toBeNull()
        ->and($gap['sentence'])->toBeNull();
});

it('reports a perfect rate for a book with no citations at all', function () {
    $result = app(CitationCoverage::class)->assess([], []);

    expect($result['instances'])->toBe(0)
        ->and($result['rate'])->toBe(1.0)
        ->and($result['details'])->toBe([]);
});
