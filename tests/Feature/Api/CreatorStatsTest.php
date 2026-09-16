<?php

/**
 * Creator stats (GET /api/creator/stats, GET /api/creator/stats/{book}).
 *
 * The contract under test: a creator sees ONLY their own books; responses are
 * AGGREGATES ONLY — no reader identity (user_name/anon_token) may ever appear
 * in a response body; the depth funnel's decile math holds on a seeded
 * fixture; and another creator's book 404s.
 *
 * All fixture rows go through pgsql_admin (committed) because the controller
 * reads through the admin connection; cleanupApiFixtures removes them.
 */

use App\Services\Stats\ReadStatsCounter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

/**
 * Seed one read, then run the real recompute.
 *
 * The recompute is not optional garnish: `library.total_views` is a
 * denormalized column with ReadStatsCounter as its SOLE writer, and the stats
 * list reads/sorts on it rather than counting book_reads live (that count is
 * what let a paged, sortable list stay cheap for a creator with thousands of
 * books). Inserting a book_reads row WITHOUT recomputing builds a state
 * production can never be in — reads with no matching total — so the fixture
 * goes through the same writer the app does.
 */
function seedRead(string $book, array $chunks, ?int $totalChunks, string $day = '2026-09-15'): string
{
    $token = 'tok_' . Str::random(10);
    DB::connection('pgsql_admin')->table('book_reads')->insert([
        'book' => $book,
        'user_name' => null,
        'anon_token' => $token,
        'read_date' => $day,
        'chunks_viewed' => json_encode($chunks),
        'max_chunk' => $chunks ? max($chunks) : null,
        'total_chunks' => $totalChunks,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    (new ReadStatsCounter())->recomputeViews([$book]);

    return $token;
}

test('guests get 401', function () {
    $this->getJson('/api/creator/stats')->assertStatus(401);
});

test('a creator sees their own books with view counts — and nobody\'s identities', function () {
    $creator = $this->loginUser();
    $mine = $this->makeBook($creator, ['visibility' => 'public']);
    $theirs = $this->makeBook($this->apiUser(), ['visibility' => 'public']);

    $leakedToken = seedRead($mine, [0, 1], 10);
    seedRead($mine, [0], 10, '2026-09-14');
    seedRead($theirs, [0], 10);

    $response = $this->getJson('/api/creator/stats')->assertOk();
    $books = collect($response->json('books'));

    expect($books->firstWhere('book', $mine)['total_views'])->toBe(2)
        ->and($books->firstWhere('book', $theirs))->toBeNull();

    // Aggregates only: reader identities must never leave the server.
    $raw = $response->getContent();
    expect($raw)->not->toContain($leakedToken)
        ->and($raw)->not->toContain('anon_token')
        ->and($raw)->not->toContain('user_name');
});

test('the depth funnel reports, per decile, the share of views that reached it', function () {
    $creator = $this->loginUser();
    $book = $this->makeBook($creator, ['visibility' => 'public']);

    // 10 chunks → chunk N is decile N. Reader A got halfway; reader B saw only the top.
    seedRead($book, [0, 1, 2, 3, 4], 10);
    seedRead($book, [0], 10);

    $response = $this->getJson("/api/creator/stats/{$book}")->assertOk();

    expect($response->json('total_views'))->toBe(2)
        ->and($response->json('total_chunks'))->toBe(10)
        ->and((float) $response->json('max_chunk_reached'))->toBe(4.0);

    // toEqual (==): json_encode drops a float's zero fraction, so 100.0 arrives as int 100.
    $pct = collect($response->json('deciles'))->pluck('pct', 'decile');
    expect($pct[0])->toEqual(100)   // everyone saw the opening
        ->and($pct[4])->toEqual(50) // half got to the 50% mark
        ->and($pct[9])->toEqual(0); // nobody finished
});

test('another creator\'s book 404s from the detail endpoint', function () {
    $other = $this->apiUser();
    $book = $this->makeBook($other, ['visibility' => 'public']);
    seedRead($book, [0], 10);

    $this->loginUser();
    $this->getJson("/api/creator/stats/{$book}")->assertStatus(404);
});

test('the list is paged and reports the FULL total — never a silent cap', function () {
    $creator = $this->loginUser();
    // PAGE_SIZE is 100; make enough to need a second page without being slow.
    $books = [];
    for ($i = 0; $i < 105; $i++) {
        $books[] = $this->makeBook($creator, ['visibility' => 'public']);
    }

    $first = $this->getJson('/api/creator/stats')->assertOk()->json();
    expect(count($first['books']))->toBe(100)
        ->and($first['total'])->toBeGreaterThanOrEqual(105)
        ->and($first['offset'])->toBe(0)
        ->and($first['limit'])->toBe(100);

    $second = $this->getJson('/api/creator/stats?offset=100')->assertOk()->json();
    expect(count($second['books']))->toBeGreaterThan(0);

    // Pages must not overlap — the ORDER BY carries a `book ASC` tiebreak
    // precisely so a non-unique sort can't repeat or skip rows across pages.
    $firstIds = collect($first['books'])->pluck('book');
    $secondIds = collect($second['books'])->pluck('book');
    expect($firstIds->intersect($secondIds))->toBeEmpty();
});

test('search matches title AND author, and narrows the total', function () {
    $creator = $this->loginUser();
    $match = $this->makeBook($creator, ['visibility' => 'public']);
    $byAuthor = $this->makeBook($creator, ['visibility' => 'public']);
    $this->makeBook($creator, ['visibility' => 'public']);

    DB::connection('pgsql_admin')->table('library')->where('book', $match)
        ->update(['title' => 'Zygomorphic Cartography']);
    DB::connection('pgsql_admin')->table('library')->where('book', $byAuthor)
        ->update(['title' => 'Something Else', 'author' => 'Zygomorphic, A.']);

    $res = $this->getJson('/api/creator/stats?q=zygomorphic')->assertOk()->json();

    expect(collect($res['books'])->pluck('book')->sort()->values()->all())
        ->toBe(collect([$match, $byAuthor])->sort()->values()->all())
        ->and($res['total'])->toBe(2);
});

test('an unknown sort key falls back instead of reaching the SQL', function () {
    $creator = $this->loginUser();
    $this->makeBook($creator, ['visibility' => 'public']);

    // The sort value is interpolated into ORDER BY, so a non-whitelisted key
    // must never reach it — this is the injection boundary.
    $this->getJson('/api/creator/stats?sort=' . urlencode('book; DROP TABLE library--'))
        ->assertOk();

    expect(DB::connection('pgsql_admin')->getSchemaBuilder()->hasTable('library'))->toBeTrue();
});

test('sort=title orders alphabetically', function () {
    $creator = $this->loginUser();
    $b = $this->makeBook($creator, ['visibility' => 'public']);
    $a = $this->makeBook($creator, ['visibility' => 'public']);
    DB::connection('pgsql_admin')->table('library')->where('book', $a)->update(['title' => 'aaa first']);
    DB::connection('pgsql_admin')->table('library')->where('book', $b)->update(['title' => 'zzz last']);

    $titles = collect($this->getJson('/api/creator/stats?sort=title')->assertOk()->json('books'))
        ->pluck('title')->filter()->values();

    expect($titles->first())->toBe('aaa first');
});
