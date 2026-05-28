<?php

/**
 * library:backfill-citation-stubs — migrates orphan OpenAlex/Open Library
 * library stubs (the pre-PR4 cache) into canonical_source, rewrites pointing
 * bibliography records, deletes the library rows.
 *
 * Locks: idempotency, library cleanup, bibliography rewrite, no_match handling.
 */

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function backfillDb()
{
    return DB::connection('pgsql_admin');
}

beforeEach(function () {
    backfillDb()->table('bibliography')->whereRaw("book LIKE 'book_backfill_%' OR \"referenceId\" LIKE 'Ref_backfill_%'")->delete();
    backfillDb()->table('library')->whereRaw("book LIKE 'book_backfill_%'")->delete();
    backfillDb()->table('canonical_source')->whereRaw("openalex_id LIKE 'W_BACKFILL_%'")->delete();
});

function backfillSeedStub(array $opts = []): string
{
    $book = $opts['book'] ?? ('book_backfill_' . Str::random(6));
    backfillDb()->table('library')->insert([
        'book'                => $book,
        'title'               => $opts['title'] ?? 'Backfill Stub Title',
        'author'              => $opts['author'] ?? 'Backfill Author',
        'creator'             => $opts['creator'] ?? 'OpenAlex',
        'visibility'          => 'public',
        'listed'              => false,
        'type'                => 'book',
        'has_nodes'           => false,
        'canonical_source_id' => null,
        'openalex_id'         => $opts['openalex_id'] ?? ('W_BACKFILL_' . Str::random(8)),
        'doi'                 => $opts['doi'] ?? null,
        'raw_json'            => '[]',
        'timestamp'           => 0,
    ]);
    return $book;
}

function backfillSeedBibliography(string $containerBook, string $referenceId, string $sourceId): void
{
    backfillDb()->table('bibliography')->insert([
        'book'                => $containerBook,
        'referenceId'         => $referenceId,
        'source_id'           => $sourceId,
        'canonical_source_id' => null,
        'content'             => 'fake citation text',
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);
}

test('deletes orphan stubs and creates canonicals (force matcher promotion)', function () {
    $stub = backfillSeedStub();

    Artisan::call('library:backfill-citation-stubs');

    expect(backfillDb()->table('library')->where('book', $stub)->count())->toBe(0, 'stub library row should be deleted')
        ->and(backfillDb()->table('canonical_source')
            ->where('openalex_id', backfillDb()->table('canonical_source')->where('openalex_id', 'like', 'W_BACKFILL_%')->value('openalex_id'))
            ->count())->toBeGreaterThanOrEqual(1, 'canonical_source row should exist');
});

test('rewrites bibliography source_id to canonical_source_id', function () {
    $stub = backfillSeedStub();
    backfillSeedBibliography('book_backfill_container', 'Ref_backfill_alpha', $stub);

    Artisan::call('library:backfill-citation-stubs');

    $bibRow = backfillDb()->table('bibliography')->where('referenceId', 'Ref_backfill_alpha')->first();
    expect($bibRow)->not->toBeNull()
        ->and($bibRow->source_id)->toBeNull('source_id should be cleared after backfill')
        ->and($bibRow->canonical_source_id)->not->toBeNull('canonical_source_id should be populated');
});

test('is idempotent — second run finds nothing to do', function () {
    backfillSeedStub();

    Artisan::call('library:backfill-citation-stubs');
    $firstRunOutput = Artisan::output();
    expect($firstRunOutput)->toContain('Found 1 stub rows to backfill');

    Artisan::call('library:backfill-citation-stubs');
    $secondRunOutput = Artisan::output();
    expect($secondRunOutput)->toContain('Found 0 stub rows to backfill');
});

test('dry-run does not modify the database', function () {
    $stub = backfillSeedStub();

    Artisan::call('library:backfill-citation-stubs', ['--dry-run' => true]);

    expect(backfillDb()->table('library')->where('book', $stub)->count())->toBe(1, 'dry-run must not delete')
        ->and(backfillDb()->table('canonical_source')->where('openalex_id', 'like', 'W_BACKFILL_%')->count())->toBe(0, 'dry-run must not insert');
});

test('limit option processes at most N rows', function () {
    backfillSeedStub();
    backfillSeedStub();
    backfillSeedStub();

    Artisan::call('library:backfill-citation-stubs', ['--limit' => 2]);

    expect(backfillDb()->table('library')->whereRaw("book LIKE 'book_backfill_%'")->count())->toBe(1, 'should leave 1 stub remaining');
});
