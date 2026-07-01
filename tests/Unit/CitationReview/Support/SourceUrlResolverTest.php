<?php

use App\Services\CitationReview\Support\SourceUrlResolver;

$r = fn() => new SourceUrlResolver();

test('DOI wins over oa_url and url', function () use ($r) {
    $claim = ['source_doi' => '10.1/x', 'source_oa_url' => 'https://oa', 'source_url' => 'https://u'];
    expect($r()->resolve($claim))->toBe('https://doi.org/10.1/x');
});

test('oa_url wins over url when no DOI', function () use ($r) {
    expect($r()->resolve(['source_oa_url' => 'https://oa', 'source_url' => 'https://u']))->toBe('https://oa');
});

test('falls back to url, then null', function () use ($r) {
    expect($r()->resolve(['source_url' => 'https://u']))->toBe('https://u');
    expect($r()->resolve([]))->toBeNull();
});

test('mdSafe escapes underscores to %5F', function () use ($r) {
    expect($r()->mdSafe('10.1162/qss_a_00195'))->toBe('10.1162/qss%5Fa%5F00195');
});
