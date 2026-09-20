<?php

use App\Services\BraveSearchService;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Psr7\Request as Psr7Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

/**
 * Http::pool does not THROW connection-level failures — it puts the exception OBJECT in the
 * results array. BraveSearchService::searchAndFetchBatch called ->successful() on whatever came
 * back, so ONE dead Brave request was a fatal "Call to undefined method
 * ConnectionException::successful()" that killed the whole book's scan (peer-review-2027-pdf,
 * 2026-09-20 — the only book of 15 to fail its corpus run). Same taxonomy as the
 * TooManyRedirectsException crash fixed in WebFetchService's pool; this pins the LAST unguarded
 * pool consumer (LlmService and EmbeddingService already instanceof-guard).
 */
it('survives a connection-dropped Brave request instead of killing the scan', function () {
    config(['services.brave_search.api_key' => 'test-key']);

    Http::fake([
        // A Guzzle-level ConnectException: what an actual dropped connection produces inside
        // Http::pool's async path (Laravel's ConnectionException wrapper is the SYNC spelling and
        // never reaches the pool's rejection handler).
        'api.search.brave.com/*' => function () {
            throw new ConnectException(
                'cURL error 28: Operation timed out',
                new Psr7Request('GET', 'https://api.search.brave.com/res/v1/web/search'),
            );
        },
    ]);

    $service = app(BraveSearchService::class);

    $out = $service->searchAndFetchBatch([
        'ref1' => ['title' => 'Some Cited Work', 'author' => 'A. Author', 'year' => 2020],
        'ref2' => ['title' => 'Another Cited Work', 'author' => 'B. Author', 'year' => 2021],
    ], DB::connection('pgsql_admin'));

    // One reference lost to a dead request, never the run: no throw, and simply no resolutions.
    expect($out)->toBe([]);
});
