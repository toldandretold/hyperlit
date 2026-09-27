<?php

namespace App\Services\CitationPipeline\Testing;

use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Facades\Http;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use RuntimeException;

/**
 * Freezes the resolution ladder's NETWORK, and only its network.
 *
 * The seam is the `Http` facade rather than the service methods, and that choice is the point.
 * `BraveSearchService::searchAndFetchBatch` does not just query — it creates library stub rows and
 * returns their ids. Cassetting it at the method level would replay ids for rows that were never
 * created, so the golden would drift for reasons that have nothing to do with the ladder. Recording
 * one level down means stub creation, scoring, DOI normalisation and every database write run FOR
 * REAL on replay; the only thing served from disk is what the outside world said.
 *
 * Everything in the ladder's metadata layer goes through this facade — OpenAlexHttpClient,
 * OpenLibraryService, SemanticScholarService, BraveSearchService and LlmService all use `Http::`
 * with no raw Guzzle or curl anywhere (verified, 2026-09-26). Pooled requests are covered too:
 * `Pool::asyncRequest()` builds through the same Factory, so a stub registered here reaches
 * `Http::pool()` calls, which is how OpenAlex and Brave issue their batches.
 *
 * NOT covered: `WebFetchService::fetchAndValidateBatch` descends into WebTextAcquirer's browser
 * rungs, which never touch the facade. That one is cassetted at the service level instead — it is
 * side-effect free (it returns text and a grade; the stub write is a separate call), so the
 * objection above does not apply to it.
 *
 * @see LadderCassette for why a characterisation golden is a precondition for touching the waves.
 */
class LadderHttpCassette
{
    /** Bodies above this are stored truncated — a full-text PDF would bloat the cassette to no end. */
    private const MAX_BODY_BYTES = 2_000_000;

    /** Served on a replay miss. 599 is unassigned, so it can never collide with a recorded status. */
    public const MISS_STATUS = 599;

    public function __construct(private LadderCassette $store)
    {
    }

    public function install(): void
    {
        match ($this->store->mode) {
            LadderCassette::MODE_RECORD => $this->installRecorder(),
            LadderCassette::MODE_REPLAY => $this->installReplayer(),
            default => throw new RuntimeException("Unknown cassette mode: {$this->store->mode}"),
        };
    }

    // ── Record ───────────────────────────────────────────────────────────────

    private function installRecorder(): void
    {
        $store = $this->store;

        // A raw Guzzle middleware, because it is the only hook that sees the request AND its
        // response together. `globalResponseMiddleware` cannot correlate the two, and a queue
        // keyed by arrival order misaligns the moment anything is pooled — which is always.
        Http::globalMiddleware(function (callable $handler) use ($store) {
            return function (RequestInterface $request, array $options) use ($handler, $store) {
                return $handler($request, $options)->then(
                    function (ResponseInterface $response) use ($request, $store) {
                        $store->through(
                            'http',
                            [self::signature($request)],
                            fn () => self::encodeResponse($response)
                        );

                        return $response;
                    }
                );
            };
        });
    }

    // ── Replay ───────────────────────────────────────────────────────────────

    private function installReplayer(): void
    {
        $store = $this->store;

        Http::fake(function (ClientRequest $request) use ($store) {
            $signature = self::signatureFromClientRequest($request);
            $found = $store->lookup('http', [$signature], $signature);

            if (!$found['hit']) {
                // Deliberately NOT an exception. This callback runs inside Guzzle's promise chain
                // for every pooled request, and `PendingRequest::otherwise()` is typed
                // `OutOfBoundsException|TransferException` — anything else surfaces as a TypeError
                // about an argument and the real message is lost. A synthetic status carries the
                // miss out safely; the cassette has already recorded it and the command fails on
                // misses > 0, so nothing is swallowed.
                return Http::response('cassette miss: ' . $signature, self::MISS_STATUS);
            }

            return Http::response(
                base64_decode($found['value']['body'], true),
                $found['value']['status'],
                $found['value']['headers'],
            );
        });
    }

    // ── Keying ───────────────────────────────────────────────────────────────

    /**
     * Method, host, path, SORTED query, and a hash of the body.
     *
     * The query is sorted because Guzzle does not guarantee parameter order across a rebuild, and
     * a pure reorder is not a different question. Headers are excluded deliberately: they carry the
     * Brave API key and per-run identifiers, and keying on them would make every cassette
     * single-use.
     */
    private static function signature(RequestInterface $request): string
    {
        $uri = $request->getUri();
        $body = (string) $request->getBody();
        $request->getBody()->rewind();

        return self::compose(
            $request->getMethod(),
            $uri->getHost(),
            $uri->getPath(),
            $uri->getQuery(),
            $body,
        );
    }

    private static function signatureFromClientRequest(ClientRequest $request): string
    {
        $parts = parse_url($request->url());

        return self::compose(
            $request->method(),
            $parts['host'] ?? '',
            $parts['path'] ?? '',
            $parts['query'] ?? '',
            $request->body(),
        );
    }

    private static function compose(
        string $method,
        string $host,
        string $path,
        string $query,
        string $body,
    ): string {
        parse_str($query, $params);
        ksort($params);

        return strtoupper($method) . ' ' . $host . $path
            . '?' . http_build_query($params)
            . ($body === '' ? '' : ' #' . hash('sha256', $body));
    }

    // ── Response encoding ────────────────────────────────────────────────────

    /** @return array{status: int, headers: array<string, list<string>>, body: string, truncated: bool} */
    private static function encodeResponse(ResponseInterface $response): array
    {
        $body = (string) $response->getBody();
        $response->getBody()->rewind();

        $truncated = strlen($body) > self::MAX_BODY_BYTES;
        if ($truncated) {
            $body = substr($body, 0, self::MAX_BODY_BYTES);
        }

        // Only the headers the ladder actually branches on. Storing them all would put
        // rate-limit counters and dates in the cassette, which then read as diffs.
        $keep = ['content-type', 'content-length', 'retry-after', 'location'];
        $headers = [];
        foreach ($keep as $name) {
            if ($response->hasHeader($name)) {
                $headers[$name] = $response->getHeader($name);
            }
        }

        return [
            'status'    => $response->getStatusCode(),
            'headers'   => $headers,
            // base64 so a PDF or a gzip body survives the JSON round trip intact.
            'body'      => base64_encode($body),
            'truncated' => $truncated,
        ];
    }
}
