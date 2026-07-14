<?php

/**
 * What the harvester now does with the two real works a user reported as bad
 * sources (both imported a partial as if it were the full text before this work):
 *
 *   W4254999268 "Oil Revolution"            — type=book, oa_status=bronze, the only
 *                                             OA copy is a Cambridge ebook chapter-1
 *                                             PDF (p.26-60). => EXCLUDED at eligibility
 *                                             by the bronze-book rule. Clean catch.
 *   W2072251792 "The History of Development" — type=article, oa_status=green, and
 *                                             OpenAlex reports a 1-page span
 *                                             (first_page==last_page==141). Green is
 *                                             NOT excluded, and a 1-page expected span
 *                                             DISABLES the page-count gate (needs >=4),
 *                                             so this one is only caught if its ToC
 *                                             OCRs under the 500-char text floor.
 *                                             Documented gap — see the assertion.
 *
 * Fixtures are the real OpenAlex work JSON (tests/fixtures/openalex/*.json).
 */

use App\Services\OpenAlex\WorkNormaliser;
use App\Services\SourceHarvest\HarvestEligibility;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function normaliseFixture(string $openalexId): array
{
    $raw = json_decode(file_get_contents(base_path("tests/fixtures/openalex/{$openalexId}.json")), true);
    return app(WorkNormaliser::class)->normaliseWork($raw);
}

function seedRealCanonical(array $n): string
{
    $id = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('canonical_source')->insert([
        'id'          => $id,
        'title'       => $n['title'] ?? 'Real Example',
        'doi'         => $n['doi'] ?? null,
        'openalex_id' => 'W_REAL_' . Str::random(8), // prefixed so cleanup is scoped
        'is_oa'       => $n['is_oa'] ?? null,
        'oa_status'   => $n['oa_status'] ?? null,
        'type'        => $n['type'] ?? null,
        'oa_url'      => $n['oa_url'] ?? null,
        'pdf_url'     => $n['pdf_url'] ?? null,
        'first_page'  => $n['first_page'] ?? null,
        'last_page'   => $n['last_page'] ?? null,
    ]);
    return $id;
}

function reachRealFromBook(string $book, string $canonicalId): void
{
    DB::connection('pgsql_admin')->table('bibliography')->insert([
        'book'                => $book,
        'referenceId'         => 'Ref_real_' . Str::random(6),
        'content'             => 'Real Example Reference',
        'canonical_source_id' => $canonicalId,
    ]);
}

function isEligible(string $book, string $canonicalId): bool
{
    return app(HarvestEligibility::class)
        ->eligibleCanonicalsFor($book)
        ->pluck('id')
        ->contains($canonicalId);
}

beforeEach(function () {
    DB::connection('pgsql_admin')->table('bibliography')->where('book', 'real_examples_book')->delete();
    DB::connection('pgsql_admin')->table('canonical_source')->where('openalex_id', 'LIKE', 'W_REAL_%')->delete();
});

afterEach(function () {
    DB::connection('pgsql_admin')->table('bibliography')->where('book', 'real_examples_book')->delete();
    DB::connection('pgsql_admin')->table('canonical_source')->where('openalex_id', 'LIKE', 'W_REAL_%')->delete();
});

test('W4254999268 (Oil Revolution) — a bronze book — stays ELIGIBLE (imported + flagged partial downstream)', function () {
    $n = normaliseFixture('W4254999268');

    // Confirm the fixture is the real profile: a bronze-book (chapter-1 teaser).
    expect($n['oa_status'])->toBe('bronze');
    expect($n['type'])->toBe('book');
    expect($n['is_oa'])->toBeTrue();

    $id = seedRealCanonical($n);
    reachRealFromBook('real_examples_book', $id);

    // Eligibility no longer gates on OA colour: the fetch ladder imports this
    // Cambridge chapter-1 PDF and assessCompleteness flags the version
    // `partial`, so citation review never treats the teaser as the whole work.
    expect(isEligible('real_examples_book', $id))->toBeTrue();
});

test('W2072251792 (History of Development) — a green article — stays eligible, and the page-count gate is disabled by its 1-page span', function () {
    $n = normaliseFixture('W2072251792');

    expect($n['oa_status'])->toBe('green');
    expect($n['type'])->toBe('article');
    // The metadata that neuters the page-count gate: a single-page span.
    expect($n['first_page'])->toBe(141);
    expect($n['last_page'])->toBe(141);

    $id = seedRealCanonical($n);
    reachRealFromBook('real_examples_book', $id);

    // Green is not excluded, so eligibility keeps it — the partial (a ToC) must be
    // caught downstream, NOT here.
    expect(isEligible('real_examples_book', $id))->toBeTrue();

    // Documented gap: expected span = last-first+1 = 1, below the page-count gate's
    // >=4 floor, so validatePdfExtent() cannot judge this one on page count. The
    // ToC would only be rejected by the post-OCR <500-char text floor. If we want a
    // hard catch here we need a stronger signal (see the test's docblock).
    $expectedSpan = $n['last_page'] - $n['first_page'] + 1;
    expect($expectedSpan)->toBeLessThan(4);
});
