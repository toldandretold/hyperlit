<?php

use App\Jobs\CitationScanBibliographyJob;

/**
 * Title-search corroboration — the gate that stops "same author, similar title" being accepted as
 * "same work".
 *
 * The real case (2026-09-20): "Neo-Colonialism: The Last Stage of Imperialism" (Nkrumah 1965,
 * Thomas Nelson) matched Open Library's "The spark on neo-colonialism - the last stage of
 * imperialism" — a collection of Spark newspaper articles, year NULL — at composite 0.678. The
 * predecessor check treated absence as innocence (a candidate with NO year could not be
 * year-rejected, and >= 0.6 passed unexamined), so the reviewer judged the WRONG BOOK on its
 * title alone while the right book's full text sat free at the URL the author printed.
 */
function corroborate(?array $llmMeta, array $candidate, ?array $diagnostics): bool
{
    $job = (new ReflectionClass(CitationScanBibliographyJob::class))->newInstanceWithoutConstructor();
    $m = new ReflectionMethod($job, 'hasYearCorroboration');
    $m->setAccessible(true);

    return $m->invoke($job, $llmMeta, $candidate, $diagnostics);
}

test('the nkrumah case is REFUSED: candidate has no year and the title is not near-exact', function () {
    expect(corroborate(
        ['year' => 1965, 'authors' => ['Nkrumah, Kwame']],
        ['title' => 'The spark on neo-colonialism - the last stage of imperialism', 'year' => null],
        ['titleScore' => 0.78],
    ))->toBeFalse();
});

test('a year within ±1 corroborates', function () {
    expect(corroborate(['year' => 1965], ['year' => 1965], ['titleScore' => 0.6]))->toBeTrue()
        ->and(corroborate(['year' => 1965], ['year' => 1966], ['titleScore' => 0.6]))->toBeTrue();
});

test('a DIVERGENT year refuses even at high title similarity — wrong match or wrong details, either is a finding', function () {
    expect(corroborate(['year' => 1965], ['year' => 1994], ['titleScore' => 0.95]))->toBeFalse();
});

test('a reprint corroborates through original_year', function () {
    // Cited "[1938] 1989": the record carries the original year even when the edition year gaps.
    expect(corroborate(['year' => 1989, 'original_year' => 1938], ['year' => 1938], ['titleScore' => 0.7]))->toBeTrue();
});

test('with no year on either side, only a near-exact title stands alone', function () {
    // Undated reports/working papers: at 0.9+ the title IS the identifier.
    expect(corroborate(['authors' => ['X']], ['year' => null], ['titleScore' => 0.93]))->toBeTrue()
        ->and(corroborate(['authors' => ['X']], ['year' => null], ['titleScore' => 0.78]))->toBeFalse();
});

/**
 * The EDITION-MISMATCH tier: identity certain, year divergent — accept WITH a flag the reviewer
 * sees, rather than refusing (which loses a right-work match) or resolving silently (which hides
 * that the printed details and the record disagree).
 *
 * Real case: prebisch1964 printed "1964"; Semantic Scholar's record of the SAME UNCTAD report
 * carries 2016 (a digitised reissue). titleScore 1.0, authorScore 1.0.
 */
function editionTier(?array $llmMeta, array $candidate, ?array $diagnostics): ?array
{
    $job = (new ReflectionClass(CitationScanBibliographyJob::class))->newInstanceWithoutConstructor();
    $m = new ReflectionMethod($job, 'editionMismatchTier');
    $m->setAccessible(true);

    return $m->invoke($job, $llmMeta, $candidate, $diagnostics);
}

test('the prebisch case is ACCEPTED with the flag: exact title+author, divergent year', function () {
    $flag = editionTier(
        ['year' => 1964, 'authors' => ['Prebisch, Raúl']],
        ['title' => 'Towards A New Trade Policy For Development', 'year' => 2016],
        ['titleScore' => 1.0, 'authorScore' => 1.0],
    );

    expect($flag)->not->toBeNull()
        ->and($flag['printed_year'])->toBe(1964)
        ->and($flag['record_year'])->toBe(2016);
});

test('the nkrumah class stays OUT: 0.78 title never reaches the tier', function () {
    expect(editionTier(
        ['year' => 1965],
        ['title' => 'The spark on neo-colonialism', 'year' => 2007],
        ['titleScore' => 0.78, 'authorScore' => 1.0],
    ))->toBeNull();
});

test('a candidate with NO year has nothing to diverge from — tier does not apply', function () {
    expect(editionTier(
        ['year' => 1965],
        ['title' => 'Neo-Colonialism', 'year' => null],
        ['titleScore' => 0.97, 'authorScore' => 1.0],
    ))->toBeNull();
});

test('weak author agreement is not identity — tier refuses', function () {
    expect(editionTier(
        ['year' => 1964],
        ['title' => 'Towards A New Trade Policy For Development', 'year' => 2016],
        ['titleScore' => 1.0, 'authorScore' => 0.5],
    ))->toBeNull();
});
