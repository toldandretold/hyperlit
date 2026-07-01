<?php

use App\Services\CitationReview\Support\ClaimSpanExtractor;

$x = fn() => new ClaimSpanExtractor();

test('preceding clause starts at the sentence boundary', function () use ($x) {
    $text = 'First sentence. Second clause here';
    $pos = mb_strlen($text);
    expect($x()->precedingClauseSpan($text, $pos, []))->toBe('Second clause here');
});

test('preceding clause clamps at the nearest earlier marker', function () use ($x) {
    $text = 'One marker A then more text B';
    $markerA = mb_strpos($text, 'A');
    $posB = mb_strpos($text, 'B');
    // Clamped at marker A (inclusive) — the span does NOT reach back to the
    // sentence start ('One marker …'), proving the marker-clamp fires.
    expect($x()->precedingClauseSpan($text, $posB, [$markerA]))->toBe('A then more text');
});

test('sentence at position includes text after the marker', function () use ($x) {
    $text = 'Alpha beta. Gamma^ delta epsilon. Zeta';
    $pos = mb_strpos($text, '^');
    expect($x()->sentenceAtPosition($text, $pos))->toBe('Gamma^ delta epsilon.');
});
