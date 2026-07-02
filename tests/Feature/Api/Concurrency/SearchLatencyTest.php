<?php

/**
 * Latency dashboard for the SEARCH endpoints, against a running server.
 *
 * Opt-in (self-skips unless HYPERLIT_TEST_URL is set). Prints a p50/p95/max table
 * under genuine parallelism. Thresholds are SOFT — this is a dashboard you read,
 * not a gate that flakes CI. See HarnessSupport for how to run.
 *
 *   HYPERLIT_TEST_URL=http://hyperlit.test php artisan test --group=concurrency --filter=SearchLatency
 *
 * Extra knobs:
 *   HYPERLIT_TEST_SEARCH_QUERY  corpus query used for the timed rows (default "marx capital" —
 *                               pick something that actually matches your local corpus).
 *   HYPERLIT_TEST_EXTERNAL=1    also time ONE external-triggering /api/search/combined request.
 *                               That request hits real OpenAlex/Open Library and writes real
 *                               rows to canonical_source on the target DB — off by default.
 *
 * Budget note: the search routes sit behind throttle:60,1 (per IP per minute), so this
 * file deliberately keeps its total request count under 60. For heavier sweeps use
 * tests/load/loadprobe.php --ip-spread instead.
 */

use Tests\Feature\Api\Concurrency\HarnessSupport;

uses()->group('concurrency');

// 12 per pooled row × 4 rows + primers + optional external = well under the 60/min throttle.
const SEARCH_POOL_N = 12;

beforeEach(function () {
    if (!HarnessSupport::reachable()) {
        $this->markTestSkipped('Set HYPERLIT_TEST_URL to a running server to run the live harness.');
    }
});

function searchQuery(): string
{
    return getenv('HYPERLIT_TEST_SEARCH_QUERY') ?: 'marx capital';
}

test('search endpoints latency dashboard', function () {
    $q = rawurlencode(searchQuery());
    $lines = ['', '  ── search latency (' . SEARCH_POOL_N . ' concurrent) ──────────────────────────'];

    // 1. Library title/author FTS.
    [$times] = HarnessSupport::poolLatencies("/api/search/library?q={$q}", SEARCH_POOL_N);
    $lines[] = HarnessSupport::reportRow('/api/search/library', HarnessSupport::percentiles($times));

    // 2. Node full-text — COLD: unique nonsense suffix per request defeats the 60s
    //    Cache::remember so every request pays full SQL (ts_headline included).
    $salt = substr(sha1((string) hrtime(true)), 0, 6);
    $coldPaths = array_map(
        fn ($i) => "/api/search/nodes?q={$q}%20zq{$salt}{$i}",
        range(1, SEARCH_POOL_N)
    );
    [$times] = HarnessSupport::poolLatencies($coldPaths, SEARCH_POOL_N);
    $lines[] = HarnessSupport::reportRow('/api/search/nodes (cold)', HarnessSupport::percentiles($times));

    // 3. Node full-text — WARM: prime once, then identical repeats hit the cache.
    HarnessSupport::poolLatencies("/api/search/nodes?q={$q}", 1);
    [$times] = HarnessSupport::poolLatencies("/api/search/nodes?q={$q}", SEARCH_POOL_N);
    $lines[] = HarnessSupport::reportRow('/api/search/nodes (warm)', HarnessSupport::percentiles($times));

    // 4. Hybrid citation search — warm-ish: the primer sets the 900s external-dedup
    //    key (and, once response caching lands, populates it), so the pooled row
    //    measures local hybrid SQL / cache cost without external HTTP.
    HarnessSupport::poolLatencies("/api/search/combined?q={$q}", 1);
    [$times] = HarnessSupport::poolLatencies("/api/search/combined?q={$q}", SEARCH_POOL_N);
    $lines[] = HarnessSupport::reportRow('/api/search/combined (warm)', HarnessSupport::percentiles($times));

    // Soft signal only — this is a dashboard, load varies.
    fwrite(STDERR, implode("\n", $lines) . "\n");
    expect($times)->not->toBeEmpty();
})->group('concurrency');

test('an external-triggering combined search is timed when opted in', function () {
    if (getenv('HYPERLIT_TEST_EXTERNAL') !== '1') {
        $this->markTestSkipped('Set HYPERLIT_TEST_EXTERNAL=1 to time the external-supplement path (hits real APIs, writes canonical rows).');
    }

    // A unique-nonsense query guarantees thin local results (< limit), so the
    // external supplementation gate in CitationSearchService fires. This is the
    // headline "before" number for the async-ingest work.
    $nonce = substr(sha1((string) hrtime(true)), 0, 8);
    $q = rawurlencode("perf probe {$nonce}");

    [$times, $responses] = HarnessSupport::poolLatencies("/api/search/combined?q={$q}", 1);
    $p = HarnessSupport::percentiles($times);
    fwrite(STDERR, "\n" . HarnessSupport::reportRow('combined (external-triggering)', $p) . "\n");

    $ok = collect($responses)->contains(fn ($r) => method_exists($r, 'successful') && $r->successful());
    expect($ok)->toBeTrue();
})->group('concurrency');
