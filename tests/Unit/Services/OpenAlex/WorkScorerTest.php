<?php

/**
 * Characterization tests for OpenAlexService's similarity + scoring layer
 * (titleSimilarity / metadataScore / isCitableWork), written BEFORE the
 * facade modularization so the extracted WorkScorer module can be verified
 * as pure code motion. Must pass identically before and after the split.
 */

use App\Services\OpenAlexService;
use Tests\TestCase;

uses(TestCase::class);

$svc = fn () => app(OpenAlexService::class);

// ----------------------------------------------------------- titleSimilarity

test('identical titles score 1.0', function () use ($svc) {
    expect($svc()->titleSimilarity('A Brief History of Neoliberalism', 'A Brief History of Neoliberalism'))
        ->toBe(1.0);
});

test('diacritics and punctuation are normalised away', function () use ($svc) {
    expect($svc()->titleSimilarity('Mbembé: On the Postcolony!', 'Mbembe On the Postcolony'))
        ->toBeGreaterThan(0.95);
});

test('disjoint titles score near zero', function () use ($svc) {
    expect($svc()->titleSimilarity('Capital Accumulation on a World Scale', 'Quantum Chromodynamics Primer'))
        ->toBeLessThan(0.3);
});

test('empty input scores 0.0', function () use ($svc) {
    expect($svc()->titleSimilarity('', 'anything'))->toBe(0.0);
    expect($svc()->titleSimilarity('anything', ''))->toBe(0.0);
});

test('a long subtitle drags the score below the match threshold (why the shortened-title retry wave exists)', function () use ($svc) {
    // The length penalty punishes the extra subtitle words hard — CanonicalSourceMatcher
    // compensates with its wave-7 shortened-title retry (strip after ':'), not here.
    expect($svc()->titleSimilarity(
        'Seeing Like a State',
        'Seeing Like a State: How Certain Schemes to Improve the Human Condition Have Failed'
    ))->toBeLessThan(0.5);
});

// ------------------------------------------------------------- metadataScore

test('title floor: a non-matching title hard-rejects regardless of author and year', function () use ($svc) {
    $result = $svc()->metadataScore(
        ['title' => 'Quantum Chromodynamics Primer', 'authors' => ['David Harvey'], 'year' => 2005],
        ['title' => 'A Brief History of Neoliberalism', 'author' => 'David Harvey', 'year' => 2005]
    );
    expect($result['score'])->toBe(0.0);
    expect($result['reason'])->toBe('title_floor');
});

test('author hard reject: matching title but fully mismatched authors on both sides scores 0', function () use ($svc) {
    $result = $svc()->metadataScore(
        ['title' => 'A Brief History of Neoliberalism', 'authors' => ['Jane Nobody'], 'year' => 2005],
        ['title' => 'A Brief History of Neoliberalism', 'author' => 'David Harvey', 'year' => 2005]
    );
    expect($result['score'])->toBe(0.0);
    expect($result['reason'])->toBe('author_hard_reject');
});

test('full match scores high with a complete breakdown', function () use ($svc) {
    $result = $svc()->metadataScore(
        ['title' => 'A Brief History of Neoliberalism', 'authors' => ['David Harvey'], 'year' => 2005],
        ['title' => 'A Brief History of Neoliberalism', 'author' => 'David Harvey', 'year' => 2005]
    );
    expect($result['score'])->toBeGreaterThan(0.8);
    expect($result['titleScore'])->toBe(1.0);
    expect($result['authorScore'])->toBe(1.0);
    expect($result['yearScore'])->toBe(1.0);
    expect($result)->toHaveKeys(['journalScore', 'publisherScore', 'authorPenalty', 'rawScore']);
});

test('author name reordering still matches (Last, First vs First Last)', function () use ($svc) {
    $result = $svc()->metadataScore(
        ['title' => 'Dispossession and Resistance in India', 'authors' => ['Nilsen, Alf Gunvald']],
        ['title' => 'Dispossession and Resistance in India', 'author' => 'Alf Gunvald Nilsen']
    );
    expect($result['authorScore'])->toBe(1.0);
});

test('et al. is stripped from LLM authors and does not deflate the score', function () use ($svc) {
    $result = $svc()->metadataScore(
        ['title' => 'A Brief History of Neoliberalism', 'authors' => ['David Harvey', 'et al.']],
        ['title' => 'A Brief History of Neoliberalism', 'author' => 'David Harvey']
    );
    expect($result['authorScore'])->toBe(1.0);
    expect($result['llmAuthors'])->toBe(['David Harvey']);
});

test('candidate missing author data gets the softened 0.85 penalty, not a hard reject', function () use ($svc) {
    $result = $svc()->metadataScore(
        ['title' => 'A Brief History of Neoliberalism', 'authors' => ['David Harvey'], 'year' => 2005],
        ['title' => 'A Brief History of Neoliberalism', 'author' => '', 'year' => 2005]
    );
    expect($result['score'])->toBeGreaterThan(0.0);
    expect($result['authorPenalty'])->toBe(0.85);
});

test('year off by one earns the half score', function () use ($svc) {
    $result = $svc()->metadataScore(
        ['title' => 'A Brief History of Neoliberalism', 'authors' => ['David Harvey'], 'year' => 2006],
        ['title' => 'A Brief History of Neoliberalism', 'author' => 'David Harvey', 'year' => 2005]
    );
    expect($result['yearScore'])->toBe(0.5);
});

test('original_year is checked as an alternative year', function () use ($svc) {
    $result = $svc()->metadataScore(
        ['title' => 'A Brief History of Neoliberalism', 'authors' => ['David Harvey'], 'year' => 2019, 'original_year' => 2005],
        ['title' => 'A Brief History of Neoliberalism', 'author' => 'David Harvey', 'year' => 2005]
    );
    expect($result['yearScore'])->toBe(1.0);
});

// ------------------------------------------------------------- isCitableWork

test('citable types pass, paratext and unknown fail', function () use ($svc) {
    expect($svc()->isCitableWork(['type' => 'journal-article']))->toBeTrue();
    expect($svc()->isCitableWork(['type' => 'book']))->toBeTrue();
    expect($svc()->isCitableWork(['type' => 'edited-book']))->toBeTrue();
    expect($svc()->isCitableWork(['type' => 'paratext']))->toBeFalse();
    expect($svc()->isCitableWork(['type' => null]))->toBeFalse();
    expect($svc()->isCitableWork([]))->toBeFalse();
});
