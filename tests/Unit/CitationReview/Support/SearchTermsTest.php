<?php

use App\Services\CitationReview\Support\SearchTerms;

$s = fn() => new SearchTerms();

test('drops words of 3 chars or fewer and joins with OR', function () use ($s) {
    expect($s()->orSearchTerms('the quick brown fox'))->toBe('quick OR brown');
});

test('dedupes and lowercases terms', function () use ($s) {
    expect($s()->orSearchTerms('Wealth wealth WEALTH nations'))->toBe('wealth OR nations');
});

test('caps at 15 terms', function () use ($s) {
    $words = [];
    for ($i = 1; $i <= 20; $i++) {
        $words[] = "term{$i}x";
    }
    $result = $s()->orSearchTerms(implode(' ', $words));
    expect(substr_count($result, ' OR ') + 1)->toBe(15);
});
