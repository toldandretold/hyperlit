<?php

/**
 * Reading-depth telemetry (POST /api/database-to-indexeddb/books/{book}/read-telemetry).
 *
 * The contract under test: one book_reads row = one (book, reader identity,
 * day) = one "view"; same-day posts MERGE (jsonb union of chunks, GREATEST of
 * max/total) instead of adding rows; no identity ⇒ 401; hostile payloads ⇒
 * 422; and library.total_views is recomputed from row COUNT by
 * ReadStatsCounter (the sole writer — the client column write was removed).
 *
 * HTTP-driven rows live inside the RefreshDatabase transaction (book_reads is
 * un-RLS'd, default connection), so assertions read DB::table('book_reads')
 * directly. The recompute test seeds via pgsql_admin instead, because
 * ReadStatsCounter reads through the admin connection — those rows commit and
 * are cleaned up by cleanupApiFixtures.
 */

use App\Services\Stats\ReadStatsCounter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

function telemetryUrl(string $book): string
{
    return "/api/database-to-indexeddb/books/{$book}/read-telemetry";
}

test('no identity means 401 and no row', function () {
    $book = $this->makeBook(null, ['visibility' => 'public']);

    $this->postJson(telemetryUrl($book), ['chunks' => [0, 1]])->assertStatus(401);

    expect(DB::table('book_reads')->where('book', $book)->count())->toBe(0);
});

test('an anonymous reader creates one row keyed by their cookie token', function () {
    $book = $this->makeBook(null, ['visibility' => 'public']);
    $token = Str::uuid()->toString();

    $this->withCredentials()
        ->withUnencryptedCookie('anon_token', $token)
        ->postJson(telemetryUrl($book), ['chunks' => [0, 1.5], 'total_chunks' => 12])
        ->assertOk();

    $row = DB::table('book_reads')->where('book', $book)->first();
    expect($row)->not->toBeNull()
        ->and($row->anon_token)->toBe($token)
        ->and($row->user_name)->toBeNull()
        ->and(json_decode($row->chunks_viewed))->toEqualCanonicalizing([0, 1.5])
        ->and((float) $row->max_chunk)->toBe(1.5)
        ->and($row->total_chunks)->toBe(12);
});

test('a logged-in reader creates one row keyed by their user name', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    $this->postJson(telemetryUrl($book), ['chunks' => [3], 'total_chunks' => 5])->assertOk();

    $row = DB::table('book_reads')->where('book', $book)->first();
    expect($row->user_name)->toBe($user->name)
        ->and($row->anon_token)->toBeNull();
});

test('a same-day second post merges chunks into the SAME row — the view count does not inflate', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    $this->postJson(telemetryUrl($book), ['chunks' => [0, 1], 'total_chunks' => 10])->assertOk();
    // The client resends its FULL cumulative set; overlap must dedupe, and a
    // missing total_chunks must not regress the stored one (GREATEST merge).
    $this->postJson(telemetryUrl($book), ['chunks' => [1, 2.5, 4]])->assertOk();

    $rows = DB::table('book_reads')->where('book', $book)->get();
    expect($rows)->toHaveCount(1);
    $row = $rows->first();
    expect(json_decode($row->chunks_viewed))->toEqualCanonicalizing([0, 1, 2.5, 4])
        ->and((float) $row->max_chunk)->toBe(4.0)
        ->and($row->total_chunks)->toBe(10);
});

test('fractional chunk ids survive the round trip', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    $this->postJson(telemetryUrl($book), ['chunks' => [4.5, 4.25]])->assertOk();

    $row = DB::table('book_reads')->where('book', $book)->first();
    expect(json_decode($row->chunks_viewed))->toEqualCanonicalizing([4.25, 4.5]);
});

test('hostile payloads are rejected with 422', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    // not an array
    $this->postJson(telemetryUrl($book), ['chunks' => 'zero'])->assertStatus(422);
    // non-numeric member
    $this->postJson(telemetryUrl($book), ['chunks' => [1, 'DROP TABLE']])->assertStatus(422);
    // over the size cap
    $this->postJson(telemetryUrl($book), ['chunks' => range(0, 2100)])->assertStatus(422);
    // bogus total
    $this->postJson(telemetryUrl($book), ['chunks' => [0], 'total_chunks' => -5])->assertStatus(422);

    expect(DB::table('book_reads')->where('book', $book)->count())->toBe(0);
});

test('ReadStatsCounter recomputes library.total_views as the row count', function () {
    $user = $this->apiUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    // Committed via admin — ReadStatsCounter reads through pgsql_admin.
    $admin = DB::connection('pgsql_admin');
    foreach ([['r1', '2026-09-14'], ['r1', '2026-09-15'], ['r2', '2026-09-15']] as [$reader, $day]) {
        $admin->table('book_reads')->insert([
            'book' => $book,
            'user_name' => null,
            'anon_token' => "tok_{$reader}_" . Str::random(6),
            'read_date' => $day,
            'chunks_viewed' => json_encode([0]),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    (new ReadStatsCounter())->recomputeViews([$book]);

    $views = $admin->table('library')->where('book', $book)->value('total_views');
    expect((int) $views)->toBe(3);
});

test('the client can no longer seed total_views through the library sync payload', function () {
    $user = $this->loginUser();
    $book = 'apitest_' . Str::random(12);

    $this->postJson('/api/db/library/bulk-create', [
        'data' => [
            'book' => $book,
            'title' => 'Seeded Views Book',
            'timestamp' => now()->timestamp * 1000,
            'total_views' => 999999,
        ],
    ])->assertOk();

    $views = DB::table('library')->where('book', $book)->value('total_views');
    expect($views)->toBeNull();
});
