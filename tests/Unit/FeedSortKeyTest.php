<?php

use App\Support\FeedSortKey;

/**
 * Pins the feed collation choice (library-catalog convention): leading
 * punctuation is IGNORED, so a quoted or bracketed title files under its
 * first real letter instead of clustering above the digits (quotes) or
 * between digits and letters (brackets) — the raw codepoint order users
 * read as "Title A–Z is broken".
 */

test('leading quotes and brackets are ignored', function () {
    expect(FeedSortKey::for("'Real Socialism' in Historical Perspective"))->toBe("real socialism' in historical perspective");
    expect(FeedSortKey::for('"Quoted" Title'))->toBe('quoted" title');
    expect(FeedSortKey::for('[selected] Records of the General Conference'))->toBe('selected] records of the general conference');
    expect(FeedSortKey::for('…An Ellipsis Start'))->toBe('an ellipsis start');
    expect(FeedSortKey::for('“Curly” opener'))->toBe('curly” opener');
});

test('the resulting ORDER files punctuated titles under their first letter', function () {
    $titles = [
        "'Real Socialism' in Historical Perspective",
        '[selected] Records of the General Conference',
        '2026 Census Field Recruitment',
        'Apple Studies',
        'zebra crossings',
    ];
    usort($titles, fn($a, $b) => FeedSortKey::for($a) <=> FeedSortKey::for($b));

    expect($titles)->toBe([
        '2026 Census Field Recruitment',          // digits still lead letters
        'Apple Studies',
        "'Real Socialism' in Historical Perspective", // under R, not under '
        '[selected] Records of the General Conference', // under S, not under [
        'zebra crossings',
    ]);
});

test('interior punctuation still counts and case is folded', function () {
    expect(FeedSortKey::for('Anti-Dühring'))->toBe('anti-dühring');
    expect(FeedSortKey::for('ANTI-DÜHRING'))->toBe(FeedSortKey::for('anti-dühring'));
});

test('degenerate values stay deterministic', function () {
    expect(FeedSortKey::for(null))->toBe('');
    expect(FeedSortKey::for(''))->toBe('');
    // Punctuation-only keeps its own form rather than collapsing to ''.
    expect(FeedSortKey::for('???'))->toBe('???');
});
