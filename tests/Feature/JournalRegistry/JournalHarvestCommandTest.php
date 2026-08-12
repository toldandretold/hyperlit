<?php

/**
 * journal:harvest — enumeration (cursor paging, citable-type gate,
 * journal_source_id stamping, idempotent re-run), the fetch loop's contract
 * with AutoVersionCreator (max-works cap, billing on `assigned` ONLY), the
 * public journal shelf, and registry bookkeeping.
 *
 * OpenAlex works HTTP is Http::fake'd with a two-page cursor sequence.
 * AutoVersionCreator and WorkOcrCharger are container-mocked (their real
 * bodies hit the network / the billing ledger and have their own suites).
 *
 * Connection discipline (see CanonicalSeedHelpers): rows the command must see
 * through pgsql_admin (eligibility) are seeded via pgsql_admin (committed —
 * cleaned by prefix); rows the command writes via Eloquent live inside
 * RefreshDatabase's transaction and are asserted via the default connection.
 */

use App\Models\JournalSource;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\SourceHarvest\WorkOcrCharger;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

function jhDb()
{
    return DB::connection('pgsql_admin');
}

function jhCleanup(): void
{
    $shelfIds = jhDb()->table('shelves')->where('name', 'LIKE', 'Journal: JHTest%')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        jhDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        jhDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    jhDb()->table('canonical_source')->where('openalex_id', 'LIKE', 'WJHTEST%')->delete();
    jhDb()->table('library')->where('book', 'LIKE', 'book_jhtest%')->delete();
    jhDb()->table('journal_sources')->where('openalex_source_id', 'LIKE', 'SJHTEST%')->delete();
    jhDb()->table('users')->where('email', 'LIKE', '%@jhtest.test')->delete();
}

// beforeEach ONLY (the CanonicalSeedHelpers pattern): an afterEach admin-
// connection delete deadlocks when the test's still-open RefreshDatabase
// transaction holds an Eloquent row lock on an admin-committed row (the
// command updates the seeded journal_sources row) — the rollback that would
// release it only happens after afterEach. Next run's beforeEach cleans up.
beforeEach(fn() => jhCleanup());

function jhSeedJournal(array $opts = []): string
{
    $id = (string) Str::uuid();
    jhDb()->table('journal_sources')->insert(array_merge([
        'id'                 => $id,
        'openalex_source_id' => 'SJHTEST1',
        'display_name'       => 'JHTest Journal',
        'slug'               => 'jhtest-journal-' . Str::lower(Str::random(6)),
        'is_diamond'         => true,
        'created_at'         => now(),
        'updated_at'         => now(),
    ], $opts));
    return $id;
}

function jhSeedUser(): string
{
    $name = 'jhtest_admin_' . Str::lower(Str::random(6));
    jhDb()->table('users')->insert([
        'name'       => $name,
        'email'      => $name . '@jhtest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'is_admin'   => true,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return $name;
}

/** A committed, eligibility-visible canonical belonging to the journal. */
function jhSeedCanonical(string $journalId, string $openalexId, array $opts = []): string
{
    $id = (string) Str::uuid();
    jhDb()->table('canonical_source')->insert(array_merge([
        'id'                => $id,
        'title'             => 'JHTest ' . $openalexId,
        'openalex_id'       => $openalexId,
        'journal_source_id' => $journalId,
        'is_oa'             => true,
        'pdf_url'           => "https://example.org/{$openalexId}.pdf",
        'cited_by_count'    => 5,
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $opts));
    return $id;
}

function jhRawWork(int $n, array $overrides = []): array
{
    return array_merge([
        'id'                      => "https://openalex.org/WJHTEST{$n}",
        'title'                   => "JHTest Work {$n}",
        'authorships'             => [],
        'publication_year'        => 2024,
        'primary_location'        => [
            'source'  => ['display_name' => 'JHTest Journal', 'host_organization_name' => 'JHTest Press'],
            'pdf_url' => "https://example.org/WJHTEST{$n}.pdf",
            'license' => 'cc-by',
        ],
        'best_oa_location'        => null,
        'locations'               => [],
        'doi'                     => "https://doi.org/10.9999/jhtest-{$n}",
        'biblio'                  => [],
        'open_access'             => ['is_oa' => true, 'oa_status' => 'gold', 'oa_url' => "https://example.org/WJHTEST{$n}"],
        'type'                    => 'article',
        'language'                => 'en',
        'cited_by_count'          => 100 - $n,
        'abstract_inverted_index' => null,
    ], $overrides);
}

/** Two-page cursor sequence: page 1 at cursor '*', page 2 at 'JH_CUR_2'. */
function fakeWorksPages(array $page1, array $page2): void
{
    Http::fake([
        'api.openalex.org/works*' => function ($request) use ($page1, $page2) {
            parse_str((string) parse_url($request->url(), PHP_URL_QUERY), $q);
            $cursor = $q['cursor'] ?? '*';
            return $cursor === '*'
                ? Http::response(['results' => $page1, 'meta' => ['count' => count($page1) + count($page2), 'next_cursor' => 'JH_CUR_2']])
                : Http::response(['results' => $page2, 'meta' => ['count' => count($page1) + count($page2), 'next_cursor' => null]]);
        },
    ]);
}

test('enumerates across cursor pages, upserts canonicals, stamps journal_source_id, skips paratext', function () {
    $journalId = jhSeedJournal();
    fakeWorksPages(
        [jhRawWork(1), jhRawWork(2, ['type' => 'paratext'])],
        [jhRawWork(3)],
    );

    $this->mock(AutoVersionCreator::class, fn($m) => $m->shouldReceive('create')->never());
    $this->mock(WorkOcrCharger::class, fn($m) => $m->shouldReceive('charge')->never());

    $slug = JournalSource::where('id', $journalId)->value('slug');
    $this->artisan('journal:harvest', ['journal' => $slug, '--sleep' => 0, '--skip-ocr' => true])
        ->assertExitCode(0);

    // Eloquent writes are in-transaction — assert on the default connection.
    expect(DB::table('canonical_source')->where('openalex_id', 'WJHTEST1')->value('journal_source_id'))->toBe($journalId);
    expect(DB::table('canonical_source')->where('openalex_id', 'WJHTEST3')->value('journal_source_id'))->toBe($journalId);
    expect(DB::table('canonical_source')->where('openalex_id', 'WJHTEST2')->exists())->toBeFalse(); // paratext gated

    // Re-run: ingestExternal dedupes on openalex_id — no duplicates.
    fakeWorksPages([jhRawWork(1), jhRawWork(2, ['type' => 'paratext'])], [jhRawWork(3)]);
    $this->artisan('journal:harvest', ['journal' => $slug, '--sleep' => 0, '--skip-ocr' => true])
        ->assertExitCode(0);
    expect(DB::table('canonical_source')->where('openalex_id', 'WJHTEST1')->count())->toBe(1);
});

test('fetch loop: max-works caps attempts, billing fires for assigned ONLY, shelf + bookkeeping land', function () {
    $journalId = jhSeedJournal();
    $user = jhSeedUser();

    // Three committed eligible canonicals, cited_by ordering 1 > 2 > 3.
    $c1 = jhSeedCanonical($journalId, 'WJHTESTA', ['cited_by_count' => 30]);
    $c2 = jhSeedCanonical($journalId, 'WJHTESTB', ['cited_by_count' => 20]);
    jhSeedCanonical($journalId, 'WJHTESTC', ['cited_by_count' => 10]);

    // Enumeration returns nothing new (works already exist as canonicals).
    fakeWorksPages([], []);

    $this->mock(AutoVersionCreator::class, function ($m) use ($c1, $c2) {
        $m->shouldReceive('create')->twice()->andReturnUsing(function ($canonical) use ($c1, $c2) {
            if ($canonical->id === $c1) {
                // Materialize what a real `assigned` produces — the stage-4
                // membership sync reconciles from these rows, not from the
                // return value.
                jhDb()->table('library')->insert([
                    'book' => 'book_jhtest_new', 'title' => 'JHTest Version New',
                    'visibility' => 'public', 'listed' => false, 'has_nodes' => true,
                    'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
                ]);
                jhDb()->table('canonical_source')->where('id', $c1)
                    ->update(['auto_version_book' => 'book_jhtest_new']);
                return ['status' => 'assigned', 'book' => 'book_jhtest_new', 'lane' => 'pdf', 'via' => 'pdf_url', 'reason' => null];
            }
            if ($canonical->id === $c2) {
                return ['status' => 'assigned_existing', 'book' => 'book_jhtest_prior', 'lane' => null, 'via' => null, 'reason' => null];
            }
            throw new RuntimeException('unexpected canonical ' . $canonical->id);
        });
    });

    // The contract under test: exactly ONE charge, for the assigned book.
    $this->mock(WorkOcrCharger::class, function ($m) {
        $m->shouldReceive('charge')
            ->once()
            ->withArgs(fn($u, $book) => $book === 'book_jhtest_new')
            ->andReturn(0.12);
    });

    $slug = JournalSource::where('id', $journalId)->value('slug');
    $this->artisan('journal:harvest', [
        'journal'     => $slug,
        '--max-works' => 2,
        '--user'      => $user,
        '--sleep'     => 0,
    ])->assertExitCode(0);

    // Public journal shelf under the system creator, with the new book on it.
    $shelfRow = jhDb()->table('shelves')->where('name', 'Journal: JHTest Journal')->first();
    expect($shelfRow)->not->toBeNull();
    expect($shelfRow->visibility)->toBe('public');
    expect($shelfRow->creator)->toBe(\App\Services\CanonicalVersions\AutoVersionResolver::CREATOR);
    expect(jhDb()->table('shelf_items')->where('shelf_id', $shelfRow->id)->pluck('book')->all())
        ->toBe(['book_jhtest_new']);

    // Bookkeeping (Eloquent write — default connection sees it).
    $row = DB::table('journal_sources')->where('id', $journalId)->first();
    expect($row->last_harvested_at)->not->toBeNull();
    expect($row->shelf_id)->toBe($shelfRow->id);
    $stats = json_decode($row->harvest_stats, true);
    expect($stats['assigned'])->toBe(1);
    expect($stats['assigned_existing'])->toBe(1);
    expect($stats['spend'])->toBe(0.12);
    expect($stats['runs'])->toBe(1);
});

test('dry-run writes no canonicals, fetches nothing, bills nothing', function () {
    $journalId = jhSeedJournal();
    fakeWorksPages([jhRawWork(1)], [jhRawWork(2)]);

    $this->mock(AutoVersionCreator::class, fn($m) => $m->shouldReceive('create')->never());
    $this->mock(WorkOcrCharger::class, fn($m) => $m->shouldReceive('charge')->never());

    $slug = JournalSource::where('id', $journalId)->value('slug');
    $this->artisan('journal:harvest', ['journal' => $slug, '--dry-run' => true, '--sleep' => 0])
        ->assertExitCode(0);

    expect(DB::table('canonical_source')->where('openalex_id', 'LIKE', 'WJHTEST%')->count())->toBe(0);
});

test('OCR-charging runs refuse to start without --user', function () {
    Http::fake();
    $journalId = jhSeedJournal();
    $slug = JournalSource::where('id', $journalId)->value('slug');

    $this->artisan('journal:harvest', ['journal' => $slug, '--sleep' => 0])
        ->assertExitCode(1);

    Http::assertNothingSent(); // refused before any enumeration
});

test('unknown journal points at journal:sync-registry', function () {
    $this->artisan('journal:harvest', ['journal' => 'no-such-journal-xyz', '--dry-run' => true])
        ->assertExitCode(1);
});
