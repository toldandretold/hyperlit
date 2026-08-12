<?php

/**
 * HarvestEligibility::eligibleCanonicalsForJournal / estimateForJournal —
 * the journal-rooted twin of the book-rooted predicate. Pure SQL over
 * canonical_source, seeded + cleaned via pgsql_admin (prefix JElig).
 */

use App\Services\SourceHarvest\HarvestEligibility;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function jeligDb()
{
    return DB::connection('pgsql_admin');
}

function jeligCleanup(): void
{
    jeligDb()->table('canonical_source')->where('title', 'LIKE', 'JElig %')->delete();
}

beforeEach(fn() => jeligCleanup());
afterEach(fn() => jeligCleanup());

function jeligSeed(?string $journalId, array $opts = []): string
{
    $id = (string) Str::uuid();
    jeligDb()->table('canonical_source')->insert(array_merge([
        'id'                => $id,
        'title'             => 'JElig ' . Str::random(6),
        'journal_source_id' => $journalId,
        'is_oa'             => true,
        'pdf_url'           => 'https://example.org/jelig.pdf',
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $opts));
    return $id;
}

test('predicate: journal-scoped, unharvested, OA, fetchable', function () {
    $journalId = (string) Str::uuid();
    $otherJournal = (string) Str::uuid();

    $eligiblePdf = jeligSeed($journalId, ['cited_by_count' => 50]);
    $eligibleOaUrl = jeligSeed($journalId, ['pdf_url' => null, 'oa_url' => 'https://example.org/x', 'cited_by_count' => 40]);
    $eligibleDoi = jeligSeed($journalId, ['pdf_url' => null, 'doi' => '10.9999/jelig', 'cited_by_count' => null]);

    jeligSeed($journalId, ['auto_version_book' => 'book_jelig_done']);          // already harvested
    jeligSeed($journalId, ['is_oa' => false]);                                   // not OA
    jeligSeed($journalId, ['is_oa' => null]);                                    // OA unknown
    jeligSeed($journalId, ['pdf_url' => '']);                                    // nothing fetchable
    jeligSeed($otherJournal);                                                    // different journal
    jeligSeed(null, []);                                                         // no journal at all

    $rows = app(HarvestEligibility::class)->eligibleCanonicalsForJournal($journalId);

    // Most-cited first, null citations last.
    expect($rows->pluck('id')->all())->toBe([$eligiblePdf, $eligibleOaUrl, $eligibleDoi]);

    // Limit caps.
    expect(app(HarvestEligibility::class)->eligibleCanonicalsForJournal($journalId, 2))->toHaveCount(2);
});

test('estimateForJournal counts total / eligible / already_harvested', function () {
    $journalId = (string) Str::uuid();

    jeligSeed($journalId, ['cited_by_count' => 5]);
    jeligSeed($journalId, ['auto_version_book' => 'book_jelig_done']);
    jeligSeed($journalId, ['is_oa' => false]);

    $estimate = app(HarvestEligibility::class)->estimateForJournal($journalId);

    expect($estimate)->toBe([
        'total'             => 3,
        'eligible'          => 1,
        'already_harvested' => 1,
    ]);
});
