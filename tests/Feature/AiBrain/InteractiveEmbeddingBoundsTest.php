<?php

/**
 * Guards the failure found 2026-09-23: the AI Archivist died mid-stream with a
 * bare transport error ("network connection was lost" / TypeError: Load failed)
 * and NO error event, 68s after `ask started`, leaving no terminal log line.
 *
 * Cause: retrieval embeds the user's question INSIDE the live SSE request, and
 * that call carried both background defaults — 3 attempts, and a 60s per-attempt
 * HTTP timeout. nginx's fastcgi_read_timeout is 60s and is not overridden, so a
 * single hung provider socket outlives the web server's patience: nginx tears
 * the connection down before PHP can return, so the user never sees the graceful
 * "no relevant passages" path that the code does implement. The 3-attempt ladder
 * compounds it with 2s + 4s of BLOCKING sleep between attempts (~186s worst case).
 *
 * The invariant: an embedding call made inside a request a user is waiting on
 * must fail fast on BOTH axes — one attempt, and a timeout well under the proxy's.
 * Degrading to keyword-only search is correct; losing the whole answer is not.
 */

use App\Services\EmbeddingService;
use App\Services\RetrievalService;
use App\Services\SearchService;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    config([
        'services.llm.base_url'        => 'https://api.fireworks.ai/inference/v1',
        'services.llm.api_key'         => 'test-key',
        'services.llm.embedding_model' => 'nomic-ai/nomic-embed-text-v1.5',
    ]);
});

test('the interactive embedding timeout stays well under the web server read timeout', function () {
    // nginx's default fastcgi_read_timeout. If PHP can still be inside one
    // provider call when this elapses, the response is killed before it returns.
    $proxyReadTimeout = 60;

    expect(EmbeddingService::TIMEOUT_INTERACTIVE)
        ->toBeLessThan($proxyReadTimeout,
            'An interactive embedding call must finish before nginx gives up on the request')
        ->toBeLessThanOrEqual(30,
            'Leave real margin: the request has more work to do after the embedding returns')
        ->toBeGreaterThan(0);

    expect(EmbeddingService::TIMEOUT_BACKGROUND)
        ->toBeGreaterThan(EmbeddingService::TIMEOUT_INTERACTIVE,
            'Background jobs have nobody waiting — they keep the generous timeout');
});

test('retrieval makes exactly ONE embedding attempt and degrades to keyword-only', function () {
    Http::fake([
        '*/embeddings' => Http::response(
            'upstream connect error or disconnect/reset before headers', 503
        ),
    ]);

    $retrieval = new RetrievalService(new EmbeddingService(), app(SearchService::class));

    $started = microtime(true);
    // embedding_query ONLY — keyword/library search are skipped, so this isolates
    // the embedding leg.
    $result = $retrieval->execute(
        ['embedding_query' => 'am i gay? and what would it even take to know such a thing'],
        [
            'bookId' => null, 'nodeIds' => [], 'selectedText' => '', 'question' => 'q',
            'authorName' => null, 'bookTitle' => null, 'sourceScope' => 'public',
            'shelfId' => null, 'creatorName' => 'someone',
        ]
    );
    $elapsed = microtime(true) - $started;

    // ONE attempt. Three would mean the 2s/4s blocking-sleep ladder is back.
    Http::assertSentCount(1);

    // ...and it must not have burned the user's request waiting.
    expect($elapsed)->toBeLessThan(2.0,
        'A failed interactive embedding must not sleep between retries');

    // The graceful degrade actually happens rather than the request dying.
    expect($result['matches'])->toBe([])
        ->and($result['toolsUsed'])->not->toContain('embedding_search')
        ->and(implode(' ', $result['log']))->toContain('Embedding search: FAILED');
});

test('every interactive embedding call site bounds both retries and timeout', function () {
    // Source-level, because Http::fake cannot observe the timeout a caller passed.
    // These are the two paths that embed inside a user-facing request.
    $callSites = [
        'RetrievalService (AI brain / archivist SSE)' => app_path('Services/RetrievalService.php'),
        'EmbeddingService::embedSearchQuery (semantic search)' => app_path('Services/EmbeddingService.php'),
    ];

    foreach ($callSites as $label => $path) {
        // assertStringContainsString (not expect()->toContain) — Pest reads extra
        // args to toContain as MORE needles, so the message would be asserted too.
        test()->assertStringContainsString(
            'TIMEOUT_INTERACTIVE',
            file_get_contents($path),
            "{$label} must pass the interactive timeout, not the background default"
        );
    }
});

test('background embedding callers keep the generous timeout', function () {
    // The inverse guard: a queue job has nobody waiting, and shortening its
    // timeout would just fail work that would otherwise have succeeded.
    test()->assertStringNotContainsString(
        'TIMEOUT_INTERACTIVE',
        file_get_contents(app_path('Jobs/GenerateNodeEmbedding.php')),
        'GenerateNodeEmbedding runs on the queue — it should keep the background default'
    );
});
