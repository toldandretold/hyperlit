<?php

/**
 * CitationReview\Phases\TruthClaimExtractor — Phase 3.
 * Extracted from CitationReviewService::extractTruthClaims. The anti-
 * hallucination property (claims must appear verbatim; hallucinated refIds are
 * dropped) is the thing worth pinning. Mock LlmService::extractTruthClaimsBatch.
 */

use App\Services\CitationReview\Phases\TruthClaimExtractor;
use App\Services\CitationReview\Support\TextNormaliser;
use App\Services\LlmService;

function extractorWith(array $batchReturn): TruthClaimExtractor
{
    $llm = Mockery::mock(LlmService::class);
    $llm->shouldReceive('extractTruthClaimsBatch')->andReturn($batchReturn);
    return new TruthClaimExtractor($llm, new TextNormaliser());
}

function oneNode(): array
{
    return [[
        'node_id'             => 'n1',
        'marked_text'         => 'The sky is blue [CITE:r1] according to science.',
        'plainText'           => 'The sky is blue according to science.',
        'reference_ids'       => ['r1'],
        'preceding_context'   => '',
        'citationPositions'   => ['r1' => 15],
        'extracted_sentences' => [],
    ]];
}

test('a verbatim claim is kept and enriched from citation metadata', function () {
    $svc = extractorWith([[
        ['referenceId' => 'r1', 'truth_claim' => 'The sky is blue'],
    ]]);
    $meta = ['r1' => ['verified' => true, 'title' => 'Sky Studies', 'verification_tier' => 'local']];

    $emitted = [];
    $claims = $svc->extractTruthClaims(oneNode(), $meta, function ($m) use (&$emitted) { $emitted[] = $m; });

    expect($claims)->toHaveCount(1);
    expect($claims[0]['truth_claim'])->toBe('The sky is blue');
    expect($claims[0]['source_title'])->toBe('Sky Studies');
    expect($claims[0]['verified_source'])->toBeTrue();
    expect($emitted[0])->toContain('Processing nodes 1-1 of 1');
});

test('a non-verbatim (hallucinated) claim is discarded', function () {
    $svc = extractorWith([[
        ['referenceId' => 'r1', 'truth_claim' => 'The grass is purple and made of code'],
    ]]);
    $claims = $svc->extractTruthClaims(oneNode(), [], fn($m) => null);
    expect($claims)->toBeEmpty();
});

test('a claim citing a refId not present in the node is dropped', function () {
    $svc = extractorWith([[
        ['referenceId' => 'not_in_node', 'truth_claim' => 'The sky is blue'],
    ]]);
    $claims = $svc->extractTruthClaims(oneNode(), [], fn($m) => null);
    expect($claims)->toBeEmpty();
});
