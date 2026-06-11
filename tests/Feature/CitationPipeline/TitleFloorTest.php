<?php

/**
 * Title floor on citation-scan matching (CitationScanBibliographyJob::
 * hasTitleConfidence): a candidate whose TITLE component is weak must never
 * be accepted on composite score — author + journal fuzz can drag a
 * same-author-different-work candidate over the threshold.
 *
 * Pinned with the live failure: Baldwin (2018) "Peer review" matched
 * Baldwin (2015) "Credibility, peer review, and Nature, 1945–1990" at
 * composite 0.412 with titleScore 0.24 — wrong work, same author.
 * Modus operandi: a wrong link is worse than a missing one.
 */

use App\Jobs\CitationScanBibliographyJob;

function titleFloor(?array $diagnostics, float $score): bool
{
    $job = new CitationScanBibliographyJob('floor-test', 'floor-test-book');
    $ref = new ReflectionMethod($job, 'hasTitleConfidence');
    $ref->setAccessible(true);
    return $ref->invoke($job, $diagnostics, $score);
}

test('the Baldwin case is rejected: composite 0.41 cannot rescue titleScore 0.24', function () {
    $diagnostics = [
        'score'        => 0.4119,
        'titleScore'   => 0.24,
        'authorScore'  => 1,
        'yearScore'    => 0,
        'journalScore' => 0.5981,
    ];

    expect(titleFloor($diagnostics, 0.4119))->toBeFalse();
});

test('a confident title passes regardless of other components', function () {
    expect(titleFloor(['titleScore' => 0.92, 'score' => 0.6], 0.6))->toBeTrue();
    expect(titleFloor(['titleScore' => 0.45, 'score' => 0.5], 0.5))->toBeTrue();
});

test('title-only scoring (no LLM metadata) falls back to the composite as title similarity', function () {
    // No titleScore key — the composite IS the title similarity
    expect(titleFloor(['score' => 0.35], 0.35))->toBeFalse();  // 0.35 title sim: too weak
    expect(titleFloor(['score' => 0.7], 0.7))->toBeTrue();
    expect(titleFloor(null, 0.6))->toBeTrue();
    expect(titleFloor(null, 0.3))->toBeFalse();
});
