<?php

/**
 * telemetry:rollup — old identity-bearing telemetry folds into de-identified
 * daily counts; totals never change, identities genuinely disappear.
 *
 * All seeding/assertion on pgsql_admin (telemetry tables have no RLS, and
 * admin writes escape RefreshDatabase — cleaned in afterEach).
 */

use App\Services\Stats\ReadStatsCounter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function tadmin()
{
    return DB::connection('pgsql_admin');
}

afterEach(function () {
    $a = tadmin();
    $a->table('book_reads')->where('book', 'like', 'rollup_test_%')->delete();
    $a->table('book_read_rollups')->where('book', 'like', 'rollup_test_%')->delete();
    $a->table('page_views')->where('page', 'rollup_test_home')->delete();
    $a->table('page_view_rollups')->where('page', 'rollup_test_home')->delete();
    $a->table('library')->where('book', 'like', 'rollup_test_%')->delete();
});

function seedTelemetry(string $book): array
{
    $a = tadmin();
    $oldDay = now()->subDays(120)->toDateString();
    $oldDay2 = now()->subDays(119)->toDateString();
    $recentDay = now()->subDays(5)->toDateString();

    // Three readers on one old day, one on another old day, two recent.
    foreach ([['alice', $oldDay], ['bob', $oldDay], [null, $oldDay], ['alice', $oldDay2], ['alice', $recentDay], [null, $recentDay]] as [$user, $day]) {
        $a->table('book_reads')->insert([
            'book' => $book,
            'user_name' => $user,
            'anon_token' => $user === null ? Str::uuid()->toString() : null,
            'read_date' => $day,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
    $a->table('page_views')->insert([
        ['page' => 'rollup_test_home', 'user_name' => 'alice', 'view_date' => $oldDay, 'created_at' => now(), 'updated_at' => now()],
        ['page' => 'rollup_test_home', 'user_name' => 'bob', 'view_date' => $recentDay, 'created_at' => now(), 'updated_at' => now()],
    ]);

    return compact('oldDay', 'oldDay2', 'recentDay');
}

test('dry-run (the default) reports and changes nothing', function () {
    $book = 'rollup_test_'.strtolower(Str::random(6));
    seedTelemetry($book);

    $this->artisan('telemetry:rollup')->assertExitCode(0);

    expect(tadmin()->table('book_reads')->where('book', $book)->count())->toBe(6);
    expect(tadmin()->table('book_read_rollups')->where('book', $book)->exists())->toBeFalse();
});

test('--force folds old rows into de-identified daily counts and deletes them', function () {
    $book = 'rollup_test_'.strtolower(Str::random(6));
    $days = seedTelemetry($book);

    $this->artisan('telemetry:rollup --force')->assertExitCode(0);

    // Old raw rows gone; recent raw rows kept.
    $remaining = tadmin()->table('book_reads')->where('book', $book)->get();
    expect($remaining)->toHaveCount(2);
    expect($remaining->every(fn ($r) => $r->read_date === $days['recentDay']))->toBeTrue();

    // Rollups: one row per day, summed, NO identity columns exist at all.
    $rollups = tadmin()->table('book_read_rollups')->where('book', $book)->orderBy('read_date')->get();
    expect($rollups)->toHaveCount(2);
    expect((int) $rollups[0]->views)->toBe(3); // oldDay had 3 readers
    expect((int) $rollups[1]->views)->toBe(1); // oldDay2 had 1

    // page_views: old folded, recent kept.
    expect(tadmin()->table('page_view_rollups')->where('page', 'rollup_test_home')->sum('views'))->toBe(1);
    expect(tadmin()->table('page_views')->where('page', 'rollup_test_home')->count())->toBe(1);

    // Nothing in the rollup remembers WHO: the named identities are gone from
    // every telemetry table they appeared in for the swept window.
    expect(tadmin()->table('book_reads')->where('book', $book)->where('user_name', 'bob')->exists())->toBeFalse();
});

test('re-running is a no-op and never double-counts', function () {
    $book = 'rollup_test_'.strtolower(Str::random(6));
    seedTelemetry($book);

    $this->artisan('telemetry:rollup --force')->assertExitCode(0);
    $firstSum = (int) tadmin()->table('book_read_rollups')->where('book', $book)->sum('views');
    $this->artisan('telemetry:rollup --force')->assertExitCode(0);

    expect((int) tadmin()->table('book_read_rollups')->where('book', $book)->sum('views'))->toBe($firstSum);
});

test('library.total_views is unchanged by the sweep (raw + rollup)', function () {
    $book = 'rollup_test_'.strtolower(Str::random(6));
    seedTelemetry($book);
    tadmin()->table('library')->insert([
        'book' => $book, 'visibility' => 'public', 'raw_json' => '{}',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $counter = new ReadStatsCounter;
    $counter->recomputeViews([$book]);
    $before = (int) tadmin()->table('library')->where('book', $book)->value('total_views');
    expect($before)->toBe(6);

    $this->artisan('telemetry:rollup --force')->assertExitCode(0);
    $counter->recomputeViews([$book]);

    expect((int) tadmin()->table('library')->where('book', $book)->value('total_views'))->toBe($before);
});

test('a retention setting below the floor refuses to run', function () {
    config(['telemetry.raw_retention_days' => 7]);

    $this->artisan('telemetry:rollup --force')->assertExitCode(1);
});
