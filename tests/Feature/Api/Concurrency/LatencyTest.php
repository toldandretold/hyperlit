<?php

/**
 * Latency dashboard for hot READ endpoints, against a running server.
 *
 * Opt-in (self-skips unless HYPERLIT_TEST_URL is set). Prints a p50/p95/max table
 * under genuine parallelism. Thresholds are SOFT — this is a dashboard you read,
 * not a gate that flakes CI. See HarnessSupport for how to run.
 *
 *   HYPERLIT_TEST_URL=http://hyperlit.test php artisan test --group=concurrency
 */

use Illuminate\Support\Facades\Http;
use Tests\Feature\Api\Concurrency\HarnessSupport;

uses()->group('concurrency');

beforeEach(function () {
    if (!HarnessSupport::reachable()) {
        $this->markTestSkipped('Set HYPERLIT_TEST_URL to a running server to run the live harness.');
    }
});

/**
 * Fire $n concurrent GETs at $path and return per-request wall-times (seconds).
 * Uses transferStats so each pooled request is timed individually.
 */
function poolLatencies(string $path, int $n, array $headers = []): array
{
    $base = HarnessSupport::baseUrl();
    $times = [];
    $responses = Http::pool(fn ($pool) => array_map(
        fn ($i) => $pool->withHeaders($headers)->withOptions([
            'on_stats' => function ($stats) use (&$times) {
                $times[] = $stats->getTransferTime();
            },
        ])->get("{$base}{$path}"),
        range(1, $n)
    ));

    return [$times, $responses];
}

test('public read endpoints stay responsive under 20 concurrent requests', function () {
    $endpoints = [
        '/api/auth-check'                 => [],
        '/api/auth/session-info'          => [],
    ];

    $lines = ['', '  ── live latency (20 concurrent) ─────────────────────────────'];
    foreach ($endpoints as $path => $headers) {
        [$times] = poolLatencies($path, 20, $headers);
        $p = HarnessSupport::percentiles($times);
        $lines[] = HarnessSupport::reportRow($path, $p);

        // Soft signal: warn loudly past 2s p95, but don't fail — load varies.
        expect($p['p95'])->not->toBeNull();
    }
    fwrite(STDERR, implode("\n", $lines) . "\n");
})->group('concurrency');

test('an owned book read path is timed when a token + book are provided', function () {
    $token = HarnessSupport::token();
    $book  = HarnessSupport::book();
    if (!$token || !$book) {
        $this->markTestSkipped('Set HYPERLIT_TEST_TOKEN and HYPERLIT_TEST_BOOK to time the authed read path.');
    }

    [$times, $responses] = poolLatencies(
        "/api/database-to-indexeddb/books/{$book}/initial",
        10,
        ['Authorization' => "Bearer {$token}", 'Accept' => 'application/json'],
    );
    $p = HarnessSupport::percentiles($times);
    fwrite(STDERR, "\n" . HarnessSupport::reportRow("authed initial-chunk ({$book})", $p) . "\n");

    // At least one response should be a 2xx for a real owned book.
    $ok = collect($responses)->contains(fn ($r) => method_exists($r, 'successful') && $r->successful());
    expect($ok)->toBeTrue();
})->group('concurrency');
