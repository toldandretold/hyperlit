<?php

use App\Jobs\CitationScanBibliographyJob;
use Illuminate\Support\Facades\Http;

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

/**
 * The CONTAINER-CORROBORATION tier: a chapter in an edited volume, year divergent, vouched for by
 * the volume the citation prints and the record's own container agreeing.
 *
 * Real case: dedesaileontug2015 (chacko) — "Political articulation: The structured creativity of
 * parties. In: … (eds) Building Blocs: How Parties Organize Society" (2015). Semantic Scholar has
 * the chapter as "Introduction. Political Articulation: The Structured Creativity of Parties",
 * authorScore 1.0, but titleScore 0.79 (the "Introduction." prefix) and year 2020 (the eBook
 * edition) — too fuzzy for the edition tier, refused by plain corroboration. Crossref's
 * container-title for the chapter's DOI is "Building Blocs": the missing witness.
 */
function containerTier(?array $llmMeta, array $candidate, ?array $diagnostics): ?array
{
    $job = (new ReflectionClass(CitationScanBibliographyJob::class))->newInstanceWithoutConstructor();
    $m = new ReflectionMethod($job, 'containerCorroborationTier');
    $m->setAccessible(true);

    return $m->invoke($job, $llmMeta, $candidate, $diagnostics);
}

// The chacko chapter's real data, verbatim.
const DELEON_META = [
    'title'           => 'Political articulation: The structured creativity of parties',
    'authors'         => ['De Leon, C', 'Desai, M', 'Tugál, C'],
    'year'            => 2015,
    'container_title' => 'Building Blocs: How Parties Organize Society',
];
const DELEON_CANDIDATE = [
    'title'   => 'Introduction. Political Articulation: The Structured Creativity of Parties',
    'author'  => 'C. de Leon; M. Desai; C. Tuğal',
    'year'    => 2020,
    'journal' => null,
    'doi'     => '10.1515/9780804794985-003',
];
const DELEON_DIAG = ['titleScore' => 0.7886, 'authorScore' => 1.0];

test('the de leon chapter is ACCEPTED via crossref: the record\'s container-title is the printed volume', function () {
    Http::fake([
        'api.crossref.org/*' => Http::response(['message' => [
            'container-title' => ['Building Blocs'],
        ]]),
    ]);

    $flag = containerTier(DELEON_META, DELEON_CANDIDATE, DELEON_DIAG);

    expect($flag)->not->toBeNull()
        ->and($flag['via'])->toBe('crossref')
        ->and($flag['record_container'])->toBe('Building Blocs')
        ->and($flag['printed_year'])->toBe(2015)
        ->and($flag['record_year'])->toBe(2020);
});

test('a provider venue carrying the volume title corroborates without any HTTP call', function () {
    Http::fake(fn () => throw new RuntimeException('no HTTP call expected'));

    $flag = containerTier(
        DELEON_META,
        ['journal' => 'Building Blocs: How Parties Organize Society', 'year' => 2020, 'doi' => null] + DELEON_CANDIDATE,
        DELEON_DIAG,
    );

    expect($flag)->not->toBeNull()->and($flag['via'])->toBe('venue');
});

test('a standalone book prints no container — the tier never applies (nkrumah stays out)', function () {
    expect(containerTier(
        ['title' => 'Neo-Colonialism: The Last Stage of Imperialism', 'year' => 1965],
        ['title' => 'The spark on neo-colonialism', 'year' => 2007, 'doi' => '10.1/x'],
        ['titleScore' => 0.78, 'authorScore' => 1.0],
    ))->toBeNull();
});

test('an OCR-garbled author name does not sink a container-vouched match (majority bar, not 0.9)', function () {
    // The SAME citation's second extraction rendered "Tugál, C" as "Tug ̆al, C" (combining
    // breve) — that token never matches "C. Tuğal", so authorScore capped at 0.6667 with two
    // of three authors EXACT. The container is the identity witness here; a garbled third
    // name is evidence-free, not contrary (the Kwon lesson, again).
    Http::fake([
        'api.crossref.org/*' => Http::response(['message' => [
            'container-title' => ['Building Blocs'],
        ]]),
    ]);

    $flag = containerTier(DELEON_META, DELEON_CANDIDATE, ['titleScore' => 0.7886, 'authorScore' => 0.6667]);

    expect($flag)->not->toBeNull()->and($flag['author_score'])->toBe(0.667);
});

test('a MINORITY author match refuses even with an agreeing container', function () {
    expect(containerTier(DELEON_META, DELEON_CANDIDATE, ['titleScore' => 0.7886, 'authorScore' => 0.4]))
        ->toBeNull();
});

test('a DIFFERENT chapter in the same volume fails the title floor — containment alone is not identity', function () {
    expect(containerTier(
        DELEON_META,
        DELEON_CANDIDATE,
        ['titleScore' => 0.4, 'authorScore' => 1.0],
    ))->toBeNull();
});

test('a record living in a DIFFERENT volume refuses', function () {
    Http::fake([
        'api.crossref.org/*' => Http::response(['message' => [
            'container-title' => ['The Oxford Handbook of Political Parties'],
        ]]),
    ]);

    expect(containerTier(DELEON_META, DELEON_CANDIDATE, DELEON_DIAG))->toBeNull();
});

test('a crossref outage refuses rather than crashing the wave', function () {
    Http::fake(['api.crossref.org/*' => Http::response(null, 500)]);

    expect(containerTier(DELEON_META, DELEON_CANDIDATE, DELEON_DIAG))->toBeNull();
});

test('cached chapter metadata that predates container_title is re-extracted, everything else is reused', function () {
    // Without this, the container tier exists only for books imported after the field was
    // added — a re-scan reuses the old JSON forever and the fix looks like it never shipped.
    $job = (new ReflectionClass(CitationScanBibliographyJob::class))->newInstanceWithoutConstructor();
    $m = new ReflectionMethod($job, 'cachedMetadataUsable');
    $m->setAccessible(true);

    expect($m->invoke($job, ['type' => 'book-chapter', 'title' => 'X']))->toBeFalse()
        ->and($m->invoke($job, ['type' => 'book-chapter', 'container_title' => 'The Volume']))->toBeTrue()
        ->and($m->invoke($job, ['type' => 'book-chapter', 'container_title' => null]))->toBeTrue()
        ->and($m->invoke($job, ['type' => 'journal-article', 'title' => 'X']))->toBeTrue()
        ->and($m->invoke($job, ['title' => 'X']))->toBeFalse()
        ->and($m->invoke($job, [
            'type' => 'journal-article',
            'sub_citations' => [['type' => 'book-chapter', 'title' => 'Y']],
        ]))->toBeFalse();
});

test('abbreviated containers agree by containment, one-word containers vouch for nothing', function () {
    $job = (new ReflectionClass(CitationScanBibliographyJob::class))->newInstanceWithoutConstructor();
    $m = new ReflectionMethod($job, 'containerTitlesAgree');
    $m->setAccessible(true);

    expect($m->invoke($job, 'Building Blocs: How Parties Organize Society', 'Building Blocs'))->toBeTrue()
        ->and($m->invoke($job, 'Building Blocs: How Parties Organize Society', 'Stanford University Press eBooks'))->toBeFalse()
        ->and($m->invoke($job, 'Conference Proceedings', 'Proceedings'))->toBeFalse();
});
