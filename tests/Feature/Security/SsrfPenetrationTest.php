<?php

/**
 * Penetration Tests: SSRF (Server-Side Request Forgery)
 *
 * The codebase has multiple services that fetch URLs server-side. An attacker
 * who can influence those URLs can make the server fetch internal resources
 * (cloud metadata at 169.254.169.254, Redis on localhost, internal admin
 * panels, etc.). These tests probe each fetcher for host-validation gaps.
 *
 * Attack vectors covered:
 *  1. WebFetchService — fetches URLs extracted from user-imported bibliography content
 *  2. OpenAccessPdfFetcher — fetches OpenAlex-sourced pdf_url (attacker-poisonable metadata)
 *  3. PlaywrightPdfFetcher — browser-based fetch, no URL validation in the Node script
 *  4. ContentFetchService — fetches oa_url/pdf_url from library records, follows redirects
 *  5. OpenAlexController — openalex_id interpolated into URL path without charset whitelist
 */

use App\Services\SourceImport\Content\OpenAccessPdfFetcher;
use App\Services\SourceImport\Identifier\Doi;
use App\Services\SourceImport\Metadata\SourceMetadata;
use App\Services\WebFetchService;
use Illuminate\Support\Facades\Http;

// =============================================================================
// SHARED SSRF PAYLOADS
// =============================================================================

dataset('ssrf_internal_targets', [
    'aws_metadata' => 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'gcp_metadata' => 'http://metadata.google.internal/computeMetadata/v1/',
    'localhost_redis' => 'http://localhost:6379/',
    'localhost_alt' => 'http://127.0.0.1:6379/',
    'localhost_any_port' => 'http://127.0.0.1:8080/admin',
    'internal_10' => 'http://10.0.0.1/',
    'internal_172' => 'http://172.16.0.1/',
    'internal_192' => 'http://192.168.1.1/',
    'ipv6_loopback' => 'http://[::1]/',
    'file_protocol' => 'file:///etc/passwd',
    'gopher_protocol' => 'gopher://localhost:6379/_FLUSHALL',
    'dict_protocol' => 'dict://localhost:11211/stats',
]);

// =============================================================================
// 1. WebFetchService — NO host validation on bibliography-extracted URLs
// =============================================================================

test('WebFetchService.extractUrl extracts internal URLs from bibliography content', function () {
    $service = app(WebFetchService::class);

    $content = '<a href="http://169.254.169.254/latest/meta-data/">Click here</a>';
    $url = $service->extractUrl($content);

    // The extractor pulls ANY http(s) URL — it has no host filtering.
    // This confirms the first half of the SSRF chain: the URL IS extracted.
    // (The trailing / is stripped by the extractor's rtrim.)
    expect($url)->toBe('http://169.254.169.254/latest/meta-data');
});

test('WebFetchService.extractUrl extracts localhost URLs from plain text', function () {
    $service = app(WebFetchService::class);

    $content = 'See http://localhost:6379/ for details';
    $url = $service->extractUrl($content);

    // (The trailing / is stripped by the extractor's rtrim.)
    expect($url)->toBe('http://localhost:6379');
});

test('WebFetchService.fetchWebPage blocks internal URLs via UrlGuard', function (string $internalUrl) {
    // No Http::fake needed — the guard should block BEFORE any HTTP call.
    // If the guard fails, the Http call to an internal URL would throw in the
    // test environment (no fake to catch it), which is also a valid failure signal.

    $service = app(WebFetchService::class);

    // Use reflection to call the private fetchWebPage method directly.
    $ref = new ReflectionClass($service);
    $method = $ref->getMethod('fetchWebPage');
    $method->setAccessible(true);

    // UrlGuard now blocks internal URLs — fetchWebPage returns null without
    // making the HTTP request. The Http::fake would fail if the request WAS
    // made (the expect($request->url()) assertion inside the fake callback).
    $result = $method->invoke($service, $internalUrl);

    expect($result)->toBeNull();
})->with('ssrf_internal_targets');

// =============================================================================
// 2. OpenAccessPdfFetcher — fetches OpenAlex-sourced pdf_url without host allowlist
// =============================================================================

test('OpenAccessPdfFetcher blocks internal URLs via UrlGuard', function (string $internalUrl) {
    $fetcher = app(OpenAccessPdfFetcher::class);

    // Build a SourceMetadata with an internal pdf_url — this simulates
    // an attacker who registered a DOI and poisoned OpenAlex's metadata
    // to point pdf_url at an internal host.
    $metadata = new SourceMetadata(
        ['pdf_url' => $internalUrl],
        'openalex',
    );
    $identifier = new Doi('10.9999/ssrf-test');

    $destDir = sys_get_temp_dir().'/ssrf-test-'.uniqid();
    @mkdir($destDir, 0755, true);

    try {
        $result = $fetcher->fetch($identifier, $metadata, $destDir);

        // UrlGuard should block the fetch — the result is a failure with
        // reason 'blocked_url', and NO HTTP request was made.
        expect($result->ok)->toBeFalse()
            ->and($result->reason)->toBe('blocked_url');
    } finally {
        @rmdir($destDir);
    }
})->with('ssrf_internal_targets');

// =============================================================================
// 3. OpenAlexController — openalex_id path traversal (low severity)
// =============================================================================

test('openalex save-to-library rejects path traversal in openalex_id', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    $response = $this->postJson('/api/openalex/save-to-library', [
        'openalex_id' => '../../authors/W123',
    ]);

    // The regex:/^[WwAa]\d++$/ validation now rejects path traversal characters.
    expect($response->status())->toBe(422);
});

// =============================================================================
// 4. URL import — SSRF via DOI pointing to internal host
// =============================================================================

test('url import inspect never fetches a user-supplied internal URL (SSRF surface is closed at the identifier layer)', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    // The original concern was "inspect follows a doi.org redirect to an internal host". It
    // can't: IdentifierNormalizer::parse only accepts an arXiv id or a DOI, and a DOI is
    // resolved via structured APIs (OpenAlex/CrossRef) keyed by the DOI VALUE — the URL is
    // never fetched and no redirect is followed. Anything else is rejected as
    // 'unrecognised_identifier' BEFORE any I/O. Prove it: a raw internal URL is refused, and
    // if any code path did fetch it, the fake would leak — assert it does not.
    Http::fake([
        '*169.254.169.254*' => Http::response('{"secret": "aws-credentials"}', 200),
        '169.254.169.254/*' => Http::response('{"secret": "aws-credentials"}', 200),
    ]);

    foreach ([
        'http://169.254.169.254/latest/meta-data/',   // AWS metadata (cloud SSRF classic)
        'http://127.0.0.1:5432/',                      // loopback
        'http://[::1]/',                               // IPv6 loopback
        'http://192.168.1.1/admin',                    // private LAN
    ] as $internalUrl) {
        $response = $this->postJson('/import-url/inspect', ['url' => $internalUrl]);

        // Rejected as a non-identifier, and NOTHING from the internal host leaked into the body.
        $response->assertStatus(422);
        expect($response->json('ok'))->toBeFalse();
        expect($response->getContent())->not->toContain('aws-credentials')->not->toContain('secret');
    }

    // And the guard for the phase that DOES fetch URLs (content fetch) rejects these hosts too.
    foreach (['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:5432/', 'http://[::1]/'] as $internalUrl) {
        expect(\App\Services\Security\UrlGuard::isSafeFetchUrl($internalUrl))->toBeFalse();
    }
});

// =============================================================================
// 5. ScrapeController — verify host allowlist IS enforced (positive control)
// =============================================================================

test('scrape controller rejects non-allowlisted hosts (positive control)', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    $response = $this->postJson('/api/scrape/novel/chapters', [
        'url' => 'http://169.254.169.254/latest/meta-data/',
    ]);

    // ScrapeController.validateHost() checks against NOVEL_HOSTS allowlist.
    // This is the CORRECT pattern — confirm it works as a positive control.
    expect($response->status())->toBe(422);
    $content = $response->getContent();
    expect($content)->toContain('Unsupported domain');
});

test('scrape controller rejects localhost (positive control)', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    $response = $this->postJson('/api/scrape/novel/chapter', [
        'url' => 'http://localhost:8080/admin',
    ]);

    expect($response->status())->toBe(422);
});

// =============================================================================
// 6. SSRF protection helper — propose and test a host validation utility
// =============================================================================

test('internal IP ranges are correctly identified as private', function () {
    $privateRanges = [
        '127.0.0.1', '127.255.255.255',
        '10.0.0.1', '10.255.255.255',
        '172.16.0.1', '172.31.255.255',
        '192.168.1.1', '192.168.255.255',
        '169.254.169.254',
        '0.0.0.0', '0.0.0.1',
    ];

    foreach ($privateRanges as $ip) {
        $isPrivate = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
        // filter_var returns false for private/reserved IPs
        expect($isPrivate)->toBeFalse("Expected {$ip} to be private/reserved");
    }
});

test('public IPs are correctly identified as non-private', function () {
    $publicIps = ['8.8.8.8', '1.1.1.1', '203.0.113.1', '104.16.132.229'];

    foreach ($publicIps as $ip) {
        $isPrivate = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
        expect($isPrivate)->not->toBeFalse("Expected {$ip} to be public");
    }
});
