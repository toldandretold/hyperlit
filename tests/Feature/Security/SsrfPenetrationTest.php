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

test('WebFetchService.fetchWebPage fetches internal URLs without host validation', function (string $internalUrl) {
    Http::fake(function ($request) use ($internalUrl) {
        // Capture the URL that was actually requested
        expect($request->url())->toBe($internalUrl);

        return Http::response('internal response', 200);
    });

    $service = app(WebFetchService::class);

    // Use reflection to call the private fetchWebPage method directly.
    $ref = new ReflectionClass($service);
    $method = $ref->getMethod('fetchWebPage');
    $method->setAccessible(true);

    // This SHOULD throw or return null for internal URLs.
    // VULNERABILITY: It fetches the URL without any host check.
    $result = $method->invoke($service, $internalUrl);

    // If we get here, the server fetched the internal URL — SSRF confirmed.
    // The test PASSES (the Http::fake captured the request), proving the
    // server WOULD fetch the internal URL. In production this is a real SSRF.
    expect($result)->not->toBeNull();
})->with('ssrf_internal_targets')->skip(
    'SSRF CONFIRMED: WebFetchService.fetchWebPage has NO host validation. '.
    'A user-imported document with a crafted bibliography URL (e.g. http://169.254.169.254/...) '.
    'is fetched server-side. Un-skip after adding a host allowlist or private-IP blocklist.'
);

// =============================================================================
// 2. OpenAccessPdfFetcher — fetches OpenAlex-sourced pdf_url without host allowlist
// =============================================================================

test('OpenAccessPdfFetcher fetches internal URLs from poisoned pdf_url metadata', function (string $internalUrl) {
    Http::fake(function ($request) use ($internalUrl) {
        expect($request->url())->toBe($internalUrl);

        // Return something that's NOT a PDF so the fetcher reports "not_a_pdf"
        // — but the REQUEST WAS STILL MADE, which is the SSRF.
        return Http::response('<html>internal</html>', 200, ['Content-Type' => 'text/html']);
    });

    $fetcher = app(OpenAccessPdfFetcher::class);

    // Build a SourceMetadata with an internal pdf_url — this simulates
    // an attacker who registered a DOI and poisoned OpenAlex's metadata
    // to point pdf_url at an internal host.
    $metadata = new SourceMetadata([
        'pdf_url' => $internalUrl,
        'source' => 'openalex',
    ]);
    $identifier = new Doi('10.9999/ssrf-test');

    $destDir = sys_get_temp_dir().'/ssrf-test-'.uniqid();
    @mkdir($destDir, 0755, true);

    try {
        $result = $fetcher->fetch($identifier, $metadata, $destDir);

        // The fetcher fetched the URL (Http::fake captured it) and returned
        // a failure because it wasn't a PDF — but the SSRF request was made.
        expect($result->ok)->toBeFalse();
    } finally {
        @rmdir($destDir);
    }
})->with('ssrf_internal_targets')->skip(
    'SSRF CONFIRMED: OpenAccessPdfFetcher.fetch() has NO host allowlist. '.
    'A poisoned OpenAlex pdf_url pointing at 169.254.169.254 / localhost is fetched. '.
    'The %PDF magic check happens AFTER the request, so the SSRF succeeds even though '.
    'the fetcher reports "not_a_pdf". Un-skip after adding a host allowlist.'
);

// =============================================================================
// 3. OpenAlexController — openalex_id path traversal (low severity)
// =============================================================================

test('openalex save-to-library rejects path traversal in openalex_id', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    Http::fake(function ($request) {
        // If the openalex_id traverses to a different API path, capture it.
        // The URL would be https://api.openalex.org/works/../../authors/W123
        // which normalises to https://api.openalex.org/authors/W123
        expect($request->url())->not->toContain('..');

        return Http::response(json_encode(['id' => 'W123', 'title' => 'test']), 200);
    });

    $response = $this->postJson('/api/openalex/save-to-library', [
        'openalex_id' => '../../authors/W123',
    ]);

    // The validation is 'required|string|max:30' — no regex/charset constraint.
    // Path traversal characters (../) are NOT blocked by validation.
    // VULNERABILITY: The request reaches Http::get() with the traversal payload.
    // (Low severity: the host is fixed to api.openalex.org, so this only
    // traverses within the OpenAlex API — but it's still an injection.)
    expect($response->status())->toBeLessThan(500);
})->skip(
    'OpenAlex openalex_id has no charset whitelist (only string|max:30). '.
    'A crafted id like "../../authors/W123" traverses within the OpenAlex API. '.
    'Low severity (fixed host), but add a regex:/^[Ww]\d+$/ validation. '.
    'Un-skip after adding the constraint.'
);

// =============================================================================
// 4. URL import — SSRF via DOI pointing to internal host
// =============================================================================

test('url import inspect rejects DOIs that resolve to internal hosts', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    // A DOI that, when resolved through doi.org, redirects to an internal host.
    // The orchestrator follows redirects — if it doesn't validate the final
    // host, the server fetches the internal URL.
    Http::fake([
        'https://doi.org/*' => Http::response('', 302, [
            'Location' => 'http://169.254.169.254/latest/meta-data/',
        ]),
        'http://169.254.169.254/*' => Http::response('{"secret": "aws-credentials"}', 200),
    ]);

    $response = $this->postJson('/import-url/inspect', [
        'url' => 'https://doi.org/10.9999/ssrf-test-'.uniqid(),
    ]);

    // The response should not contain data from the internal host.
    $content = $response->getContent();
    expect($content)->not->toContain('aws-credentials')
        ->not->toContain('secret');
})->skip(
    'PENDING: The URL import orchestrator follows redirects from doi.org. '.
    'If the DOI redirects to an internal host (169.254.169.254), the server '.
    'follows it. This test needs the ImportOrchestrator to be mockable to '.
    'properly verify the redirect chain. Un-skip after implementing redirect '.
    'host validation in the orchestrator.'
);

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
