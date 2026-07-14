<?php

/**
 * HarvestEligibility does NOT exclude by OA colour: bronze books (often a
 * front-matter/chapter teaser) stay eligible — the fetch ladder imports them
 * and flags the version `partial` (ContentFetchService::assessCompleteness),
 * so citation review never mistakes a teaser for the whole work.
 */

use App\Services\SourceHarvest\HarvestEligibility;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function seedEligCanonical(array $opts): string
{
    $id = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('canonical_source')->insert([
        'id'          => $id,
        'title'       => $opts['title'] ?? 'Elig Test Work',
        'doi'         => $opts['doi'] ?? ('10.9999/ELIG_' . Str::random(8)),
        'is_oa'       => true,
        'oa_status'   => $opts['oa_status'],
        'type'        => $opts['type'],
        'openalex_id' => 'W_ELIG_' . Str::random(8),
    ]);
    return $id;
}

function reachEligFromBook(string $book, string $canonicalId): void
{
    DB::connection('pgsql_admin')->table('bibliography')->insert([
        'book'                => $book,
        'referenceId'         => 'Ref_elig_' . Str::random(6),
        'content'             => 'Elig Test Reference',
        'canonical_source_id' => $canonicalId,
    ]);
}

beforeEach(function () {
    DB::connection('pgsql_admin')->table('bibliography')->where('book', 'elig_test_book')->delete();
    DB::connection('pgsql_admin')->table('canonical_source')->where('openalex_id', 'LIKE', 'W_ELIG_%')->delete();
});

afterEach(function () {
    DB::connection('pgsql_admin')->table('bibliography')->where('book', 'elig_test_book')->delete();
    DB::connection('pgsql_admin')->table('canonical_source')->where('openalex_id', 'LIKE', 'W_ELIG_%')->delete();
});

test('OA colour never gates eligibility — bronze books and articles both stay in', function () {
    $bronzeBook    = seedEligCanonical(['oa_status' => 'bronze', 'type' => 'book']);
    $bronzeArticle = seedEligCanonical(['oa_status' => 'bronze', 'type' => 'article']);
    $goldBook      = seedEligCanonical(['oa_status' => 'gold', 'type' => 'book']);
    // NULL oa_status/type must not exclude either (the whereNot(=) three-valued
    // NULL bug silently dropped every canonical with unknown OA metadata).
    $unknownStatus = seedEligCanonical(['oa_status' => null, 'type' => null]);

    reachEligFromBook('elig_test_book', $bronzeBook);
    reachEligFromBook('elig_test_book', $bronzeArticle);
    reachEligFromBook('elig_test_book', $goldBook);
    reachEligFromBook('elig_test_book', $unknownStatus);

    $ids = app(HarvestEligibility::class)
        ->eligibleCanonicalsFor('elig_test_book')
        ->pluck('id')
        ->all();

    expect($ids)->toContain($bronzeArticle);
    expect($ids)->toContain($goldBook);
    expect($ids)->toContain($bronzeBook);    // bronze book: kept, flagged partial downstream
    expect($ids)->toContain($unknownStatus); // unknown OA metadata: kept
});
