<?php

/**
 * CitationReview\Phases\ClaimVerifier — Phase 5.
 * Extracted from CitationReviewService::verifyClaims. Pure orchestration over
 * LlmService (no DB) — mock the three batch methods.
 */

use App\Services\CitationReview\Phases\ClaimVerifier;
use App\Services\LlmService;

function verifierWith(callable $setup): ClaimVerifier
{
    $llm = Mockery::mock(LlmService::class);
    $setup($llm);
    return new ClaimVerifier($llm);
}

test('a claim with no evidence short-circuits to insufficient', function () {
    $svc = verifierWith(function ($llm) {
        $llm->shouldReceive('validateAbstractBatch')->zeroOrMoreTimes();
        $llm->shouldReceive('verifyCitationBatch')->zeroOrMoreTimes();
        $llm->shouldReceive('reviewRejectionBatch')->zeroOrMoreTimes();
    });

    $claims = [[
        'truth_claim' => 'x', 'evidence_type' => 'none', 'source_passages' => [],
    ]];
    $emitted = [];
    $svc->verifyClaims($claims, function ($m) use (&$emitted) { $emitted[] = $m; });

    expect($claims[0]['evidence_type'])->toBe('none');
    expect($claims[0]['llm_verdict']['support'])->toBe('insufficient');
    expect($emitted)->toContain('Validating abstracts...');
});

test('passages produce passages_only evidence and carry the verdict through', function () {
    $svc = verifierWith(function ($llm) {
        $llm->shouldReceive('validateAbstractBatch')->zeroOrMoreTimes();
        $llm->shouldReceive('verifyCitationBatch')->once()
            ->andReturn([['support' => 'confirmed', 'summary' => 'ok']]);
        $llm->shouldReceive('reviewRejectionBatch')->zeroOrMoreTimes();
    });

    $claims = [[
        'truth_claim' => 'A claim.', 'evidence_type' => 'none',
        'source_passages' => [['text' => 'passage', 'node_id' => 'p1', 'rank' => 0.5]],
    ]];
    $svc->verifyClaims($claims, fn($m) => null);

    expect($claims[0]['evidence_type'])->toBe('passages_only');
    expect($claims[0]['llm_verdict']['support'])->toBe('confirmed');
    expect($claims[0]['source_material_sent'])->toContain('PASSAGES FROM SOURCE TEXT');
});

test('a rejected verdict with a topical connection is upgraded to unlikely', function () {
    $svc = verifierWith(function ($llm) {
        $llm->shouldReceive('validateAbstractBatch')->zeroOrMoreTimes();
        $llm->shouldReceive('verifyCitationBatch')->once()
            ->andReturn([['support' => 'rejected', 'summary' => 'no']]);
        $llm->shouldReceive('reviewRejectionBatch')->once()->andReturn([true]);
    });

    $claims = [[
        'truth_claim' => 'A claim.', 'evidence_type' => 'none',
        'source_title' => 'The Work', 'source_author' => 'Author',
        'source_passages' => [['text' => 'passage', 'node_id' => 'p1', 'rank' => 0.5]],
    ]];
    $svc->verifyClaims($claims, fn($m) => null);

    expect($claims[0]['llm_verdict']['support'])->toBe('unlikely');
    expect($claims[0]['llm_verdict']['reasoning'])->toContain('Upgraded from "rejected"');
});
