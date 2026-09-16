<?php

/**
 * /maintainer/stats + its API. Gating mirrors the sibling maintainer pages:
 * the PAGE 404s for guests and non-admins (never advertised), the API 403s
 * behind auth:sanctum + admin. Payload shapes are asserted on admin fixtures
 * seeded via pgsql_admin (the controller aggregates through it).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

test('the /maintainer/stats page 404s for guests and non-admins, renders for admins', function () {
    $this->get('/maintainer/stats')->assertNotFound();

    $this->loginUser(); // authenticated but NOT admin
    $this->get('/maintainer/stats')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/stats')->assertOk()->assertViewIs('maintainer-stats')->assertSee('Stats');
});

test('every stats API endpoint is admin-gated', function () {
    $this->loginUser();

    $this->getJson('/api/maintainer/stats/summary')->assertStatus(403);
    $this->getJson('/api/maintainer/stats/daily')->assertStatus(403);
    $this->getJson('/api/maintainer/stats/top-books')->assertStatus(403);
});

test('summary and top-books aggregate the seeded corpus', function () {
    $creator = $this->apiUser();
    $book = $this->makeBook($creator, ['visibility' => 'public', 'title' => 'Stats Fixture Book']);

    $admin = DB::connection('pgsql_admin');
    foreach ([['a', '2026-09-14'], ['b', '2026-09-15']] as [$reader, $day]) {
        $admin->table('book_reads')->insert([
            'book' => $book,
            'anon_token' => 'tok_' . $reader . '_' . Str::random(6),
            'read_date' => $day,
            'chunks_viewed' => json_encode([0, 5]),
            'max_chunk' => 5,
            'total_chunks' => 10,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
    $admin->table('book_likes')->insert([
        'book' => $book,
        'creator' => $creator->name,
        'created_at' => now(),
    ]);
    // top-books reads library.total_likes — run the same recompute the like
    // endpoint fires after commit.
    (new \App\Services\Stats\ReadStatsCounter())->recomputeLikes([$book]);

    $this->loginUser(['is_admin' => true]);

    $summary = $this->getJson('/api/maintainer/stats/summary')->assertOk()->json();
    expect($summary['views'])->toBeGreaterThanOrEqual(2)
        ->and($summary['likes'])->toBeGreaterThanOrEqual(1)
        ->and($summary['readers'])->toBeGreaterThanOrEqual(2);

    $top = collect($this->getJson('/api/maintainer/stats/top-books')->assertOk()->json('books'));
    $row = $top->firstWhere('book', $book);
    expect($row)->not->toBeNull()
        ->and($row['views'])->toBe(2)
        ->and($row['likes'])->toBe(1)
        ->and((float) $row['avg_depth_pct'])->toBe(50.0);

    $daily = $this->getJson('/api/maintainer/stats/daily')->assertOk()->json();
    expect(collect($daily['views'])->firstWhere('day', '2026-09-15')['n'])->toBeGreaterThanOrEqual(1);
});
