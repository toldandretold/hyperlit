<?php

/**
 * Pins the homepage skip-if-unchanged guard (HomePageServerController):
 * the 15-minute rebuild used to delete + reinsert the three ranking books and
 * stamp them a fresh `timestamp` UNCONDITIONALLY — marking every returning
 * visitor's cached feed stale (~96 pointless clear+redownloads a day). Now it
 * skips entirely when the connection recompute reports zero changed rows AND
 * the corpus signal (count + max meta_updated_at over PUBLIC + LISTED books,
 * via the library_meta_touch trigger) is unchanged.
 *
 * Seeds via pgsql_admin (escapes the RefreshDatabase transaction), so
 * beforeEach-only cleanup — same pattern as HomepageFeedsTest.
 */

use App\Http\Controllers\HomePageServerController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function hskipDb()
{
    return DB::connection('pgsql_admin');
}

function hskipCleanup(): void
{
    $db = hskipDb();
    foreach (['library'] as $table) {
        $db->table($table)->where('book', 'LIKE', 'book_hskip_%')->delete();
    }
    $db->table('nodes')->whereIn('book', ['most-recent', 'most-connected', 'most-lit'])
        ->where('node_id', 'LIKE', '%book_hskip_%')->delete();
    Cache::forget('homepage_books_signal');
    Cache::forget('homepage_books_data');
}

beforeEach(fn () => hskipCleanup());
afterAll(fn () => hskipCleanup());

function hskipSeedBook(array $fields = []): string
{
    $book = 'book_hskip_' . Str::lower(Str::random(10));
    hskipDb()->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'HSkip ' . $book,
        'visibility' => 'public',
        'listed' => true,
        'has_nodes' => true,
        'creator' => 'hskip_seeder',
        'raw_json' => json_encode(['type' => 'book']),
        'timestamp' => (int) round(microtime(true) * 1000),
        'created_at' => now(),
        'updated_at' => now(),
    ], $fields));

    return $book;
}

function hskipRebuild(): void
{
    app(HomePageServerController::class)->updateHomePageBooks(new Request, true);
}

/** Autoincrement ids of the ranking books' node rows — change iff delete+reinserted. */
function hskipFingerprint(): string
{
    return hskipDb()->table('nodes')
        ->whereIn('book', ['most-recent', 'most-connected', 'most-lit'])
        ->orderBy('id')->pluck('id')->implode(',');
}

function hskipRankingTimestamps(): array
{
    return hskipDb()->table('library')
        ->whereIn('book', ['most-recent', 'most-connected', 'most-lit'])
        ->orderBy('book')->pluck('timestamp', 'book')->all();
}

test('an unchanged corpus skips the rebuild — no node churn, no timestamp bump', function () {
    hskipSeedBook();
    hskipSeedBook();

    hskipRebuild(); // establishes the feed + records the signal
    $fp = hskipFingerprint();
    $ts = hskipRankingTimestamps();

    hskipRebuild(); // nothing changed → must be a no-op

    expect(hskipFingerprint())->toBe($fp);           // nodes untouched
    expect(hskipRankingTimestamps())->toBe($ts);     // timestamps untouched → client caches stay valid
});

test('a CONTENT edit (timestamp-only bump) on a listed book still skips', function () {
    $book = hskipSeedBook();
    hskipRebuild();
    $fp = hskipFingerprint();

    hskipDb()->table('library')->where('book', $book)
        ->update(['timestamp' => (int) round(microtime(true) * 1000) + 5000]);

    hskipRebuild();
    expect(hskipFingerprint())->toBe($fp);
});

test('a metadata change on a PRIVATE or UNLISTED book does not trigger a rebuild', function () {
    hskipSeedBook();
    $private = hskipSeedBook(['visibility' => 'private']);
    $unlisted = hskipSeedBook(['listed' => false]);
    hskipRebuild();
    $fp = hskipFingerprint();

    hskipDb()->table('library')->where('book', $private)->update(['title' => 'renamed private']);
    hskipDb()->table('library')->where('book', $unlisted)->update(['title' => 'renamed unlisted']);

    hskipRebuild();
    expect(hskipFingerprint())->toBe($fp);
});

test('a metadata change on a listed public book triggers a real rebuild', function () {
    $book = hskipSeedBook();
    hskipRebuild();
    $fp = hskipFingerprint();

    hskipDb()->table('library')->where('book', $book)->update(['title' => 'Renamed for the feed']);

    hskipRebuild();
    expect(hskipFingerprint())->not->toBe($fp);      // rebuilt
    expect(hskipFingerprint())->toContain(',');      // and populated

    // …and settles again.
    $fp2 = hskipFingerprint();
    hskipRebuild();
    expect(hskipFingerprint())->toBe($fp2);
});

test('a NEW listed public book triggers a rebuild; delisting one does too', function () {
    hskipSeedBook();
    hskipRebuild();
    $fp = hskipFingerprint();

    $new = hskipSeedBook();
    hskipRebuild();
    $fp2 = hskipFingerprint();
    expect($fp2)->not->toBe($fp);

    // Delist: membership shrinks — the trigger's `listed` column stamps meta.
    hskipDb()->table('library')->where('book', $new)->update(['listed' => false]);
    hskipRebuild();
    expect(hskipFingerprint())->not->toBe($fp2);
});

