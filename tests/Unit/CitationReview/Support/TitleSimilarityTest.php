<?php

use App\Services\CitationReview\Support\TitleSimilarity;

$t = fn() => new TitleSimilarity();

test('identical titles score 1.0', function () use ($t) {
    expect($t()->similarity('A Brief History', 'A Brief History'))->toBe(1.0);
});

test('stopwords are ignored so wording differences still match', function () use ($t) {
    // "of/the" dropped; both reduce to {history, neoliberalism}
    expect($t()->similarity('A History of Neoliberalism', 'The History Neoliberalism'))->toBe(1.0);
});

test('completely disjoint titles score 0.0', function () use ($t) {
    expect($t()->similarity('Capital Accumulation', 'Quantum Chromodynamics'))->toBe(0.0);
});

test('empty input scores 0.0', function () use ($t) {
    expect($t()->similarity('', 'anything'))->toBe(0.0);
});

test('partial overlap sits below the 0.7 diagnostic threshold', function () use ($t) {
    // {alpha,beta,gamma} vs {alpha,delta,epsilon} => 1/5 = 0.2
    expect($t()->similarity('alpha beta gamma', 'alpha delta epsilon'))->toBeLessThan(0.7);
});
