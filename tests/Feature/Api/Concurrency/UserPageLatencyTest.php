<?php

/**
 * Latency dashboard for the /u/{username} page and its data endpoints, against
 * a running server. Companion to the client-side e2e perf spec
 * (tests/e2e/specs/performance/user-page-load.spec.js) — this file isolates the
 * SERVER share of the page-load time.
 *
 * Opt-in (self-skips unless HYPERLIT_TEST_URL is set). Prints a p50/p95/max
 * table. Thresholds are SOFT — this is a dashboard you read, not a gate that
 * flakes CI. See HarnessSupport for how to run.
 *
 *   HYPERLIT_TEST_URL=https://hyperlit.test php artisan test --group=concurrency --filter=UserPageLatency
 *
 * Extra knob:
 *   HYPERLIT_TEST_USERNAME  the user page under test (default "pleaseplease",
 *                           the shared e2e user — see tests/e2e/.env.e2e).
 *
 * The cold-map row busts the hypercite-map cache via `php artisan cache:forget`
 * — CLI artisan shares the live database cache store, whereas an in-process
 * Cache::forget here would hit the phpunit env's cache and miss. Both current
 * key generations are forgotten so the row keeps meaning across the
 * stale-while-revalidate migration (v2 = legacy SVG-only key, v3 = corpus+SVG).
 *
 * SERVER_TIMING_ENABLED=true in the server's .env adds a Server-Timing header
 * to these responses (guards/map/shelves breakdown) — read it in the responses
 * or browser devtools to attribute the totals this file prints.
 */

use Tests\Feature\Api\Concurrency\HarnessSupport;

uses()->group('concurrency');

const USER_PAGE_POOL_N = 10;

beforeEach(function () {
    if (!HarnessSupport::reachable()) {
        $this->markTestSkipped('Set HYPERLIT_TEST_URL to a running server to run the live harness.');
    }
});

function userPageUsername(): string
{
    return getenv('HYPERLIT_TEST_USERNAME') ?: 'pleaseplease';
}

function forgetUserMapCache(string $username): void
{
    $root = base_path();
    foreach (['v2', 'v3'] as $gen) {
        // cache:forget exits 0 whether or not the key existed.
        exec(sprintf('cd %s && php artisan cache:forget %s 2>/dev/null', escapeshellarg($root), escapeshellarg("user-hypercite-map:{$username}:{$gen}")));
    }
}

test('user page latency dashboard', function () {
    $u = userPageUsername();
    $allBook = rawurlencode($u . 'All');
    $lines = ['', "  ── /u/{$u} latency ──────────────────────────────────────"];

    // 1. Page HTML, COLD hypercite-map cache: the first visitor after every
    //    cache expiry pays the whole-corpus map build inline. Sequential, one
    //    forget per request — pooling would let one miss serve the rest.
    $coldTimes = [];
    for ($i = 0; $i < 3; $i++) {
        forgetUserMapCache($u);
        [$times] = HarnessSupport::poolLatencies("/u/{$u}", 1);
        $coldTimes = array_merge($coldTimes, $times);
    }
    $lines[] = HarnessSupport::reportRow("/u/{$u} (map cache cold)", HarnessSupport::percentiles($coldTimes));

    // 2. Page HTML, warm caches — the steady-state TTFB every visitor pays.
    HarnessSupport::poolLatencies("/u/{$u}", 1); // primer
    [$times] = HarnessSupport::poolLatencies("/u/{$u}", USER_PAGE_POOL_N);
    $lines[] = HarnessSupport::reportRow("/u/{$u} (warm)", HarnessSupport::percentiles($times));

    // 3. The feed's first data request (chunk 0 + manifest + ALL annotations).
    [$times] = HarnessSupport::poolLatencies("/api/database-to-indexeddb/books/{$allBook}/initial", 5);
    $lines[] = HarnessSupport::reportRow('…/books/{u}All/initial', HarnessSupport::percentiles($times));

    // 4. The background download's first batch (~50 chunks of library cards).
    [$times] = HarnessSupport::poolLatencies("/api/database-to-indexeddb/books/{$allBook}/data/batch?from=0&to=49", 5);
    $lines[] = HarnessSupport::reportRow('…/books/{u}All/data/batch 0-49', HarnessSupport::percentiles($times));

    // Soft signal only — this is a dashboard, load varies.
    fwrite(STDERR, implode("\n", $lines) . "\n");
    expect($times)->not->toBeEmpty();
})->group('concurrency');
