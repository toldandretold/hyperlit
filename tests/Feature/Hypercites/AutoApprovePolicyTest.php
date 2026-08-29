<?php

/**
 * AutoApprovePolicy — the single gate for minting without a human. Exact,
 * unambiguous, quote-bearing, and long enough; everything else needs eyes.
 */

use App\Services\Hypercites\AutoApprovePolicy;

function apCandidate(array $overrides = []): object
{
    return (object) array_merge([
        'status'            => 'matched',
        'has_quote'         => true,
        'quote_kind'        => 'inline',
        'match_method'      => 'exact',
        'match_occurrences' => 1,
        'quote_text'        => 'a verbatim quotation comfortably past the forty-character floor for auto approval',
    ], $overrides);
}

test('an exact, single-occurrence, long quote qualifies', function () {
    expect(AutoApprovePolicy::qualifies(apCandidate()))->toBeTrue();
});

test('every relaxation disqualifies', function () {
    expect(AutoApprovePolicy::qualifies(apCandidate(['match_method' => 'normalized'])))->toBeFalse();
    expect(AutoApprovePolicy::qualifies(apCandidate(['match_method' => 'fts_fuzzy'])))->toBeFalse();
    expect(AutoApprovePolicy::qualifies(apCandidate(['match_occurrences' => 2])))->toBeFalse();
    expect(AutoApprovePolicy::qualifies(apCandidate(['has_quote' => false])))->toBeFalse();
    expect(AutoApprovePolicy::qualifies(apCandidate(['status' => 'pending'])))->toBeFalse();
    expect(AutoApprovePolicy::qualifies(apCandidate(['status' => 'rejected'])))->toBeFalse();
    expect(AutoApprovePolicy::qualifies(apCandidate(['quote_text' => 'too short'])))->toBeFalse();
});

test('a blockquote never auto-approves, however strong the match', function () {
    // An inline quote's marks are a boundary the citing AUTHOR wrote. A
    // blockquote's attribution is inferred positionally and its extent is
    // inferred by stripping furniture — good enough to propose, not to mint
    // unattended. Same candidate, one field apart.
    expect(AutoApprovePolicy::qualifies(apCandidate(['quote_kind' => 'inline'])))->toBeTrue();
    expect(AutoApprovePolicy::qualifies(apCandidate(['quote_kind' => 'blockquote'])))->toBeFalse();
    expect(AutoApprovePolicy::qualifies(apCandidate(['quote_kind' => null])))->toBeFalse();
});

test('normalization decides the length, not raw characters', function () {
    // Lots of whitespace padding must not smuggle a short quote past the floor.
    $padded = '   short    quote      with     huge      gaps        ';
    expect(AutoApprovePolicy::qualifies(apCandidate(['quote_text' => $padded])))->toBeFalse();
});
