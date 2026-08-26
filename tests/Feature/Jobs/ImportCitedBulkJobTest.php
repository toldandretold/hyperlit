<?php

/**
 * ImportCitedBulkJob — the hypercite console's "import all OA" run — and the shelf
 * side-effect added to ImportCitedSourceJob. AutoVersionCreator and WorkOcrCharger are
 * mocked (no network, no OCR, no billing); the work-list, the "Cited by:" shelf and the
 * run-row bookkeeping are the real code under test.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (an afterEach admin delete deadlocks
 * against the still-open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use App\Jobs\ImportCitedBulkJob;
use App\Jobs\ImportCitedSourceJob;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Hypercites\CitedWorksQuery;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\WorkOcrCharger;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

uses(Tests\Feature\Api\Support\InteractsWithApi::class);

function icbDb()
{
    return DB::connection('pgsql_admin');
}

function icbCleanup(): void
{
    icbDb()->table('hypercite_runs')->whereIn(
        'journal_source_id',
        icbDb()->table('journal_sources')->where('display_name', 'LIKE', 'ICB %')->pluck('id')
    )->delete();
    icbDb()->table('bibliography')->where('book', 'LIKE', 'book_icb%')->delete();
    icbDb()->table('canonical_source')->where('title', 'LIKE', 'ICB %')->delete();
    icbDb()->table('library')->where('book', 'LIKE', 'book_icb%')->delete();
    icbDb()->table('shelf_items')->whereIn(
        'shelf_id',
        icbDb()->table('shelves')->where('name', 'LIKE', 'Cited by: ICB %')->pluck('id')
    )->delete();
    icbDb()->table('shelves')->where('name', 'LIKE', 'Cited by: ICB %')->delete();
    icbDb()->table('journal_sources')->where('display_name', 'LIKE', 'ICB %')->delete();
}

beforeEach(function () {
    icbCleanup();
    config(['services.source_fetch.work_sleep_seconds' => 0]);
});

function icbSeedJournal(): object
{
    $row = [
        'id'                 => (string) Str::uuid(),
        'openalex_source_id' => 'SICB' . Str::upper(Str::random(6)),
        'display_name'       => 'ICB Journal',
        'slug'               => 'icb-' . Str::lower(Str::random(8)),
        'is_diamond'         => true,
        'created_at'         => now(),
        'updated_at'         => now(),
    ];
    icbDb()->table('journal_sources')->insert($row);

    return (object) $row;
}

/** A held article of the journal whose bibliography cites the given canonicals. */
function icbSeedCitingArticle(string $journalId, array $citedCanonicalIds): array
{
    $canonicalId = (string) Str::uuid();
    $book = 'book_icb_' . Str::lower(Str::random(8));

    icbDb()->table('library')->insert([
        'book'                => $book,
        'title'               => 'ICB Citing Article',
        'visibility'          => 'public',
        'listed'              => false,
        'has_nodes'           => true,
        'type'                => 'book',
        'raw_json'            => '[]',
        'timestamp'           => 0,
        'canonical_source_id' => $canonicalId,
        'created_at'          => now(),
    ]);
    icbDb()->table('canonical_source')->insert([
        'id'                => $canonicalId,
        'title'             => 'ICB Citing Article',
        'journal_source_id' => $journalId,
        'is_oa'             => true,
        'auto_version_book' => $book,
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    foreach ($citedCanonicalIds as $i => $citedId) {
        icbDb()->table('bibliography')->insert([
            'book'                => $book,
            'referenceId'         => 'icbref' . $i,
            'content'             => 'ICB ref',
            'canonical_source_id' => $citedId,
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);
    }

    return ['canonical_id' => $canonicalId, 'book' => $book];
}

/** An external canonical row with the given OA shape. */
function icbSeedExternal(string $title, array $opts = []): string
{
    $id = (string) Str::uuid();
    icbDb()->table('canonical_source')->insert(array_merge([
        'id'         => $id,
        'title'      => $title,
        'is_oa'      => true,
        'pdf_url'    => 'https://example.org/' . Str::lower(Str::random(6)) . '.pdf',
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts));

    return $id;
}

function icbSeedRun(object $journal, int $limit = 0, ?int $userId = null): string
{
    $runId = (string) Str::uuid();
    icbDb()->table('hypercite_runs')->insert([
        'id'                => $runId,
        'journal_source_id' => $journal->id,
        'user_id'           => $userId,
        'action'            => 'import_cited_bulk',
        'status'            => 'pending',
        'work_limit'        => $limit,
        'counts'            => '{}',
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    return $runId;
}

function icbRunJob(string $runId, \Mockery\MockInterface $creator, ?\Mockery\MockInterface $charger = null): void
{
    $charger ??= Mockery::mock(WorkOcrCharger::class)->shouldIgnoreMissing();
    (new ImportCitedBulkJob($runId))->handle(
        $creator,
        $charger,
        app(HarvestShelf::class),
        app(CitedWorksQuery::class),
    );
}

test('the bulk job imports only importable externals, collects them on the cited shelf, and reports counts', function () {
    $journal = icbSeedJournal();

    $importable = icbSeedExternal('ICB Importable One');
    $importable2 = icbSeedExternal('ICB Importable Two');
    $notOa = icbSeedExternal('ICB Paywalled', ['is_oa' => false]);
    // Held: a public content-bearing version already exists.
    $heldId = icbSeedExternal('ICB Already Held');
    icbDb()->table('library')->insert([
        'book'                => 'book_icb_held' . Str::lower(Str::random(4)),
        'title'               => 'ICB Already Held',
        'visibility'          => 'public',
        'listed'              => false,
        'has_nodes'           => true,
        'type'                => 'book',
        'raw_json'            => '[]',
        'timestamp'           => 0,
        'canonical_source_id' => $heldId,
        'created_at'          => now(),
    ]);

    icbSeedCitingArticle($journal->id, [$importable, $importable2, $notOa, $heldId]);

    $bookOne = 'book_icb_new1' . Str::lower(Str::random(4));
    $creator = Mockery::mock(AutoVersionCreator::class);
    $creator->shouldReceive('create')
        ->twice()
        ->andReturnUsing(function ($canonical) use ($importable, $bookOne) {
            if ($canonical->id === $importable) {
                // Mint the row the real creator would, so `held` flips and `remaining` drops.
                icbDb()->table('library')->insert([
                    'book'                => $bookOne,
                    'title'               => 'ICB Importable One',
                    'visibility'          => 'public',
                    'listed'              => false,
                    'has_nodes'           => true,
                    'type'                => 'book',
                    'raw_json'            => '[]',
                    'timestamp'           => 0,
                    'canonical_source_id' => $canonical->id,
                    'created_at'          => now(),
                ]);

                return ['status' => 'assigned', 'book' => $bookOne, 'lane' => 'pdf', 'reason' => null];
            }

            return ['status' => 'fetch_failed', 'book' => null, 'lane' => 'pdf', 'reason' => 'no copy answered'];
        });

    $runId = icbSeedRun($journal);
    icbRunJob($runId, $creator);

    $run = icbDb()->table('hypercite_runs')->where('id', $runId)->first();
    expect($run->status)->toBe('completed');

    $counts = json_decode((string) $run->counts, true);
    expect($counts['requested'])->toBe(2);       // the paywalled and held works were never listed
    expect($counts['attempted'])->toBe(2);
    expect($counts['imported'])->toBe(1);
    expect($counts['failed'])->toBe(1);
    expect($counts['failures'])->toHaveCount(1);
    expect($counts['failures'][0]['reason'])->toBe('no copy answered');
    expect($counts['remaining'])->toBe(1);       // the failed one is still importable
    expect($counts['stopped_early'])->toBeFalse();

    // The shelf: public, system-owned, named for the scope, holding the imported book.
    $shelf = icbDb()->table('shelves')->where('id', $counts['shelf']['id'])->first();
    expect($shelf->name)->toBe('Cited by: ICB Journal');
    expect($shelf->creator)->toBe(AutoVersionResolver::CREATOR);
    expect($shelf->visibility)->toBe('public');
    expect(icbDb()->table('shelf_items')->where('shelf_id', $shelf->id)->pluck('book')->all())
        ->toBe([$bookOne]);
});

test('a second run reuses the same shelf and an assigned_existing result is collected without a charge', function () {
    $journal = icbSeedJournal();
    $importable = icbSeedExternal('ICB Existing Stub');
    icbSeedCitingArticle($journal->id, [$importable]);

    $existingBook = 'book_icb_stub' . Str::lower(Str::random(4));
    $creator = Mockery::mock(AutoVersionCreator::class);
    $creator->shouldReceive('create')->twice()->andReturn(
        ['status' => 'assigned_existing', 'book' => $existingBook, 'lane' => 'pdf', 'reason' => null],
    );
    // A user is on the run, but assigned_existing must never bill.
    $charger = Mockery::mock(WorkOcrCharger::class);
    $charger->shouldNotReceive('charge');

    $user = $this->loginUser(['is_admin' => true]);
    icbRunJob(icbSeedRun($journal, 0, $user->id), $creator, $charger);
    icbRunJob(icbSeedRun($journal, 0, $user->id), $creator, $charger);

    $shelves = icbDb()->table('shelves')->where('name', 'Cited by: ICB Journal')->get();
    expect($shelves)->toHaveCount(1);
    // addBooks is an upsert: two runs, one shelf_items row.
    expect(icbDb()->table('shelf_items')->where('shelf_id', $shelves[0]->id)->count())->toBe(1);
});

test('an assigned result with a user on the run is charged', function () {
    $journal = icbSeedJournal();
    $importable = icbSeedExternal('ICB Chargeable');
    icbSeedCitingArticle($journal->id, [$importable]);

    $newBook = 'book_icb_paid' . Str::lower(Str::random(4));
    $creator = Mockery::mock(AutoVersionCreator::class);
    $creator->shouldReceive('create')->once()->andReturn(
        ['status' => 'assigned', 'book' => $newBook, 'lane' => 'pdf', 'reason' => null],
    );

    $user = $this->loginUser(['is_admin' => true]);
    $charger = Mockery::mock(WorkOcrCharger::class);
    $charger->shouldReceive('charge')
        ->once()
        ->withArgs(fn ($chargedUser, $book) => $chargedUser->id === $user->id && $book === $newBook)
        ->andReturn(0.05);

    icbRunJob(icbSeedRun($journal, 0, $user->id), $creator, $charger);
});

test('work_limit slices the list', function () {
    $journal = icbSeedJournal();
    $cited = [
        icbSeedExternal('ICB Sliced A'),
        icbSeedExternal('ICB Sliced B'),
        icbSeedExternal('ICB Sliced C'),
    ];
    icbSeedCitingArticle($journal->id, $cited);

    $creator = Mockery::mock(AutoVersionCreator::class);
    $creator->shouldReceive('create')->twice()->andReturn(
        ['status' => 'fetch_failed', 'book' => null, 'lane' => 'pdf', 'reason' => 'x'],
    );

    $runId = icbSeedRun($journal, 2);
    icbRunJob($runId, $creator);

    $counts = json_decode((string) icbDb()->table('hypercite_runs')->where('id', $runId)->value('counts'), true);
    expect($counts['requested'])->toBe(2);
    expect($counts['attempted'])->toBe(2);
    expect($counts['remaining'])->toBe(3); // nothing landed, all three still importable
});

test('the single-import job now lands its book on the cited shelf too', function () {
    $journal = icbSeedJournal();
    $importable = icbSeedExternal('ICB Single Import');

    $runId = (string) Str::uuid();
    icbDb()->table('hypercite_runs')->insert([
        'id'                  => $runId,
        'journal_source_id'   => $journal->id,
        'canonical_source_id' => $importable,
        'action'              => 'import_source',
        'status'              => 'pending',
        'counts'              => '{}',
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);

    $newBook = 'book_icb_single' . Str::lower(Str::random(4));
    $creator = Mockery::mock(AutoVersionCreator::class);
    $creator->shouldReceive('create')->once()->andReturn(
        ['status' => 'assigned', 'book' => $newBook, 'lane' => 'pdf', 'reason' => null],
    );

    (new ImportCitedSourceJob($runId))->handle(
        $creator,
        Mockery::mock(WorkOcrCharger::class)->shouldIgnoreMissing(),
        app(HarvestShelf::class),
    );

    expect(icbDb()->table('hypercite_runs')->where('id', $runId)->value('status'))->toBe('completed');
    $shelfId = icbDb()->table('shelves')->where('name', 'Cited by: ICB Journal')->value('id');
    expect($shelfId)->not->toBeNull();
    expect(icbDb()->table('shelf_items')->where('shelf_id', $shelfId)->pluck('book')->all())
        ->toBe([$newBook]);
});
