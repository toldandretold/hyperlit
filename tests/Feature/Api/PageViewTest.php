<?php

/**
 * Home-page view counting (POST /api/database-to-indexeddb/page-view) and its
 * appearance in /maintainer/stats.
 *
 * The contract under test: one row per (page, identity, day) — the SAME unit
 * as a book view, so the two numbers on the maintainer dashboard mean the same
 * thing; only whitelisted page names are accepted; an identity is required
 * (without one there is no dedup key, so counting would inflate the total);
 * and home views are reported SEPARATELY from book reads, never mixed into the
 * corpus reading aggregates.
 */

use Illuminate\Support\Facades\DB;

afterEach(fn () => $this->cleanupApiFixtures());

/**
 * Count on the DEFAULT connection — the controller writes there, and inside a
 * test that write is still in an uncommitted transaction that pgsql_admin
 * cannot see. (page_views is not RLS'd, so the default connection sees every
 * row.) The maintainer-aggregate tests below have the opposite problem: the
 * controller READS through pgsql_admin, so their fixture must be committed.
 */
function homeViewCount(): int
{
    return (int) DB::table('page_views')->where('page', 'home')->count();
}

test('a logged-in visit records one home view', function () {
    $this->loginUser();

    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => 'home'])->assertOk();

    expect(homeViewCount())->toBe(1);
});

test('the same visitor on the same day counts ONCE — views are per identity per day', function () {
    $this->loginUser();

    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => 'home'])->assertOk();
    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => 'home'])->assertOk();
    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => 'home'])->assertOk();

    // A refresh is not a view. This is what makes "home views" comparable with
    // "book views" rather than being a raw hit counter.
    expect(homeViewCount())->toBe(1);
});

test('two different visitors on the same day are two views', function () {
    $this->loginUser();
    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => 'home'])->assertOk();

    $this->actingAs($this->apiUser());
    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => 'home'])->assertOk();

    expect(homeViewCount())->toBe(2);
});

test('a non-whitelisted page name is refused', function () {
    $this->loginUser();

    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => 'reader'])->assertStatus(422);
    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => ''])->assertStatus(422);
    $this->postJson('/api/database-to-indexeddb/page-view', [])->assertStatus(422);

    expect(homeViewCount())->toBe(0);
});

test('home views never land in book_reads — they are a separate mechanism', function () {
    $before = (int) DB::connection('pgsql_admin')->table('book_reads')->count();

    $this->loginUser();
    $this->postJson('/api/database-to-indexeddb/page-view', ['page' => 'home'])->assertOk();

    expect((int) DB::connection('pgsql_admin')->table('book_reads')->count())->toBe($before);
});

/** Committed fixture — the maintainer endpoints aggregate through pgsql_admin. */
function seedHomeView(string $identity): void
{
    DB::connection('pgsql_admin')->table('page_views')->insert([
        'page' => 'home',
        'user_name' => $identity,
        'anon_token' => null,
        'view_date' => now()->toDateString(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

test('the maintainer summary reports home views separately from book views', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    seedHomeView($admin->name);

    $summary = $this->getJson('/api/maintainer/stats/summary')->assertOk()->json();

    expect($summary)->toHaveKeys(['views', 'home_views', 'home_views_30d'])
        ->and($summary['home_views'])->toBeGreaterThanOrEqual(1);
});

test('the maintainer daily series carries a home band', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    seedHomeView($admin->name);

    $daily = $this->getJson('/api/maintainer/stats/daily')->assertOk()->json();

    expect($daily)->toHaveKey('home');
    expect(collect($daily['home'])->sum('n'))->toBeGreaterThanOrEqual(1);
});
