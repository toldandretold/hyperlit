<?php

/**
 * Citation-dense nodes used to lose EVERY citation: the extraction prompt made
 * the model repeat the full claim sentence once per reference, so a
 * multi-citation parenthetical ("(A 2016; B 2017; C 2018; …)") produced
 * O(citations x sentence) output, overran max_tokens, and came back as a
 * truncated JSON array — which json_decode rejected, discarding the whole
 * node. Measured on a real corpus: 43% of one article's citations vanished,
 * concentrated in exactly the dense parentheticals where padded or fabricated
 * references hide (2026-09 citation study, phase1).
 *
 * Three guards, all locked here:
 * 1. Claims are requested GROUPED (referenceIds: [...]) so a shared span is
 *    written once, and the parser fans them back out per citation.
 * 2. A truncated response is SALVAGED — complete objects before the cut are
 *    kept rather than the node being thrown away.
 * 3. Legacy single-referenceId entries still parse unchanged.
 */

use App\Services\LlmService;

function callParse(?string $raw): ?array
{
    $service = app(LlmService::class);
    $method = new ReflectionMethod(LlmService::class, 'parseExtractClaimsResult');
    $method->setAccessible(true);
    return $method->invoke($service, $raw);
}

test('grouped referenceIds fan out to one record per citation', function () {
    $raw = json_encode([[
        'referenceIds' => ['zarsky2016', 'pasquale2015', 'tutt2016'],
        'truth_claim' => 'One possible path to explainability is algorithmic auditing.',
        'contextualised_claim' => 'Algorithmic auditing is a path to explainability.',
    ]]);

    $parsed = callParse($raw);

    expect($parsed)->toHaveCount(3)
        ->and(array_column($parsed, 'referenceId'))->toBe(['zarsky2016', 'pasquale2015', 'tutt2016'])
        ->and($parsed[0]['truth_claim'])->toBe('One possible path to explainability is algorithmic auditing.')
        ->and($parsed[1]['contextualised_claim'])->toBe('Algorithmic auditing is a path to explainability.')
        ->and($parsed[0])->not->toHaveKey('referenceIds');
});

test('a response truncated mid-array keeps the complete objects instead of losing the node', function () {
    // Two complete objects, then a third cut off mid-string — exactly the
    // shape observed in the failing runs.
    $raw = '[
      {"referenceId": "tutt2016", "truth_claim": "Regulatory requirements demonstrate the challenge.", "contextualised_claim": "Regulation is challenging."},
      {"referenceId": "zarsky2016", "truth_claim": "Auditing is one path.", "contextualised_claim": "Auditing is a path."},
      {"referenceId": "sandvig2014", "truth_claim": "Further work is';

    expect(json_decode($raw, true))->toBeNull(); // the old code stopped here and dropped everything

    $parsed = callParse($raw);

    expect($parsed)->toHaveCount(2)
        ->and(array_column($parsed, 'referenceId'))->toBe(['tutt2016', 'zarsky2016']);
});

test('salvage handles braces and escaped quotes inside claim text', function () {
    $raw = '[
      {"referenceId": "a2020", "truth_claim": "He said \"the set {x} is closed\" in passing.", "contextualised_claim": "The set is closed."},
      {"referenceId": "b2021", "truth_claim": "Truncated mid';

    $parsed = callParse($raw);

    expect($parsed)->toHaveCount(1)
        ->and($parsed[0]['referenceId'])->toBe('a2020')
        ->and($parsed[0]['truth_claim'])->toContain('{x}');
});

test('legacy single-referenceId responses still parse unchanged', function () {
    $raw = json_encode([
        ['referenceId' => 'smith2019', 'truth_claim' => 'A claim.', 'contextualised_claim' => 'A claim.'],
    ]);

    $parsed = callParse($raw);

    expect($parsed)->toHaveCount(1)
        ->and($parsed[0]['referenceId'])->toBe('smith2019');
});

test('a truncated response with no complete object still fails rather than inventing claims', function () {
    expect(callParse('[{"referenceId": "a2020", "truth_claim": "cut off mid'))->toBeNull()
        ->and(callParse('not json at all'))->toBeNull()
        ->and(callParse(null))->toBeNull();
});

test('the extraction prompt instructs grouping and forbids repeating a claim', function () {
    $service = app(LlmService::class);
    $method = new ReflectionMethod(LlmService::class, 'extractClaimsSystemPrompt');
    $method->setAccessible(true);
    $prompt = $method->invoke($service);

    expect($prompt)->toContain('referenceIds')
        ->and($prompt)->toContain('GROUP BY CLAIM, NEVER REPEAT IT');
});
