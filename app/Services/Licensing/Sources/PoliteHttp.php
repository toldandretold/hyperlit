<?php

namespace App\Services\Licensing\Sources;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/**
 * Shared HTTP etiquette for the licence sources: an identifying User-Agent with a contact
 * address (Crossref's "polite pool", arXiv's and Internet Archive's stated expectation), a
 * short timeout, and a per-host minimum interval so a 20k-row sweep never hammers anyone.
 */
final class PoliteHttp
{
    public const USER_AGENT = 'Hyperlit/1.0 (licence discovery; mailto:sam@hyperlit.io)';

    /** @var array<string, float> host → microtime of the last request */
    private static array $last = [];

    /** Tests set this to 0 so a suite doesn't sleep. */
    public static float $intervalScale = 1.0;

    public static function client(): PendingRequest
    {
        return Http::withHeaders(['User-Agent' => self::USER_AGENT, 'Accept' => 'application/json'])
            ->timeout(15)
            ->connectTimeout(8);
    }

    /** GET with a minimum gap between calls to the same host (seconds). */
    public static function get(string $url, array $query = [], float $minInterval = 0.25, array $headers = []): Response
    {
        $host = (string) parse_url($url, PHP_URL_HOST);
        $gap = $minInterval * self::$intervalScale;
        if ($gap > 0 && isset(self::$last[$host])) {
            $wait = self::$last[$host] + $gap - microtime(true);
            if ($wait > 0) {
                usleep((int) ($wait * 1_000_000));
            }
        }
        self::$last[$host] = microtime(true);

        return self::client()->withHeaders($headers)->get($url, $query);
    }

    /** A response that means "we couldn't ask" rather than "they said no". */
    public static function isInfraFailure(Response $r): bool
    {
        return $r->status() === 429 || $r->serverError();
    }
}
