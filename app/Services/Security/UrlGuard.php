<?php

namespace App\Services\Security;

use Illuminate\Support\Facades\Log;
use InvalidArgumentException;

/**
 * SSRF guard: blocks server-side fetches of internal/private URLs.
 *
 * Used by every service that fetches a URL whose provenance is not a
 * hard-coded host (WebFetchService, OpenAccessPdfFetcher,
 * PlaywrightPdfFetcher, ContentFetchService). The ScrapeController is
 * exempt — it already uses a host allowlist, which is stricter.
 *
 * The check:
 *  1. Scheme must be http or https (no file://, gopher://, dict://, etc.).
 *  2. The hostname is resolved to an IP via gethostbyname(). If resolution
 *     fails the raw hostname is checked — it may itself be an IP literal.
 *  3. The resolved IP must NOT be private, reserved, or loopback
 *     (FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE).
 *
 * Caveats: DNS rebinding (the record changes between the check and the
 * fetch) is not mitigated — that requires a custom HTTP client that pins
 * the resolved IP. For our use case (fetching OA PDFs and bibliography
 * pages) the check raises the bar from "trivially exploitable" to "requires
 * a DNS rebinding setup", which is acceptable defence-in-depth.
 */
class UrlGuard
{
    /**
     * Is this URL safe for the server to fetch?
     *
     * Returns true if: scheme is http/https AND the resolved IP is public.
     * Returns false for: internal IPs, loopback, link-local, non-http schemes,
     * unresolvable hostnames that look like IP literals in private ranges.
     */
    public static function isSafeFetchUrl(string $url): bool
    {
        $parsed = parse_url($url);
        if ($parsed === false) {
            return false;
        }

        $scheme = strtolower($parsed['scheme'] ?? '');
        if ($scheme !== 'http' && $scheme !== 'https') {
            return false;
        }

        $host = $parsed['host'] ?? '';
        if ($host === '') {
            return false;
        }

        // If the host is already an IP literal, check it directly.
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return self::isPublicIp($host);
        }

        // Resolve the hostname. gethostbyname() returns the IP on success,
        // or the unmodified hostname on failure.
        $resolved = gethostbyname($host);
        if ($resolved === $host) {
            // Resolution failed — the hostname is not an IP and DNS didn't
            // resolve it. Block the fetch (can't verify it's safe).
            return false;
        }

        return self::isPublicIp($resolved);
    }

    /**
     * Assert that a URL is safe to fetch, throwing if it is not.
     *
     * @throws InvalidArgumentException
     */
    public static function assertSafeFetchUrl(string $url): void
    {
        if (! self::isSafeFetchUrl($url)) {
            Log::warning('UrlGuard blocked SSRF attempt', ['url' => $url]);
            throw new InvalidArgumentException('Blocked: URL resolves to a private or reserved address.');
        }
    }

    /**
     * Is this IP address public (not private, not reserved, not loopback)?
     */
    private static function isPublicIp(string $ip): bool
    {
        $result = filter_var(
            $ip,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE,
        );

        return $result !== false;
    }
}
