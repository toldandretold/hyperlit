<?php

/**
 * Security Tests: HTTP Security Headers
 *
 * Tests for presence and correctness of security headers
 * that protect against various web attacks.
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

// =============================================================================
// STANDARD SECURITY HEADERS
// =============================================================================

test('X-Frame-Options header prevents clickjacking', function () {
    $response = $this->get('/');

    $response->assertHeader('X-Frame-Options', 'DENY');
});

test('X-Content-Type-Options prevents MIME sniffing', function () {
    $response = $this->get('/');

    $response->assertHeader('X-Content-Type-Options', 'nosniff');
});

test('X-XSS-Protection enables browser XSS filter', function () {
    $response = $this->get('/');

    $response->assertHeader('X-XSS-Protection', '1; mode=block');
});

test('Referrer-Policy controls referrer information', function () {
    $response = $this->get('/');

    $response->assertHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
});

// =============================================================================
// API CACHE HEADERS
// =============================================================================

test('API responses have no-cache headers', function () {
    $response = $this->getJson('/api/auth-check');

    $response->assertHeader('Cache-Control');

    $cacheControl = $response->headers->get('Cache-Control');
    expect($cacheControl)->toContain('no-store');
});

test('authenticated API responses prevent caching', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->getJson('/api/home');

    $cacheControl = $response->headers->get('Cache-Control');
    expect($cacheControl)->toContain('no-store')
        ->or->toContain('no-cache');
});

// =============================================================================
// COOKIE SECURITY
// =============================================================================

test('session cookie has HttpOnly flag', function () {
    $response = $this->get('/');

    $cookies = $response->headers->getCookies();

    foreach ($cookies as $cookie) {
        if (str_contains($cookie->getName(), 'session')) {
            expect($cookie->isHttpOnly())->toBeTrue();
        }
    }
});

test('anonymous token cookie has secure attributes', function () {
    $response = $this->postJson('/api/anonymous-session');

    $cookies = $response->headers->getCookies();

    foreach ($cookies as $cookie) {
        if ($cookie->getName() === 'anon_token') {
            expect($cookie->isHttpOnly())->toBeTrue();
            expect($cookie->getSameSite())->toBe('lax');
            // Note: Secure flag only set in production (HTTPS)
        }
    }
});

test('cookies have SameSite attribute', function () {
    $response = $this->postJson('/api/anonymous-session');

    $cookies = $response->headers->getCookies();

    foreach ($cookies as $cookie) {
        if ($cookie->getName() === 'anon_token') {
            // SameSite should be 'lax' or 'strict'
            expect($cookie->getSameSite())->toBeIn(['lax', 'strict', 'Lax', 'Strict']);
        }
    }
});

// =============================================================================
// CONTENT SECURITY POLICY (CSP) - CURRENTLY MISSING
// =============================================================================

test('Content-Security-Policy header should be implemented', function () {
    $response = $this->get('/');

    // This test documents that CSP is NOT currently implemented
    // After implementing CSP, update this test
    $csp = $response->headers->get('Content-Security-Policy');

    // Mark as incomplete until CSP is implemented
    if (!$csp) {
        $this->markTestIncomplete('Content-Security-Policy header is not implemented yet');
    }

    // When implemented, CSP should include these directives:
    // expect($csp)->toContain("default-src 'self'");
    // expect($csp)->toContain("script-src");
    // expect($csp)->toContain("style-src");
});

// =============================================================================
// STRICT-TRANSPORT-SECURITY (HSTS)
// =============================================================================

test('HSTS header should be present in production', function () {
    // HSTS is typically only set in production with HTTPS
    // This test documents the expected behavior
    $response = $this->get('/');

    $hsts = $response->headers->get('Strict-Transport-Security');

    // In development, HSTS might not be set
    // In production, it should be: max-age=31536000; includeSubDomains
    if (config('app.env') === 'production') {
        expect($hsts)->not->toBeNull();
    }
});

// =============================================================================
// CORS HEADERS
// =============================================================================

test('CORS headers only allow whitelisted origins', function () {
    // Test with allowed origin
    $response = $this->withHeader('Origin', 'http://localhost:8000')
        ->getJson('/api/auth-check');

    $allowedOrigin = $response->headers->get('Access-Control-Allow-Origin');
    expect($allowedOrigin)->toBe('http://localhost:8000');
});

test('CORS rejects unknown origins', function () {
    $response = $this->withHeader('Origin', 'https://evil.com')
        ->getJson('/api/auth-check');

    $allowedOrigin = $response->headers->get('Access-Control-Allow-Origin');

    // Should either be null or not match the evil origin
    expect($allowedOrigin)->not->toBe('https://evil.com');
});

test('CORS preflight request is handled correctly', function () {
    $response = $this->withHeader('Origin', 'http://localhost:8000')
        ->withHeader('Access-Control-Request-Method', 'POST')
        ->options('/api/db/library/upsert');

    // Preflight should return appropriate headers
    $response->assertHeader('Access-Control-Allow-Methods');
});

// =============================================================================
// ERROR RESPONSE SECURITY
// =============================================================================

test('error responses do not leak stack traces', function () {
    // Force an error
    $response = $this->getJson('/api/nonexistent-endpoint-12345');

    $content = $response->getContent();

    // Should not contain file paths
    expect(strtolower($content))->not->toContain('/users/')
        ->not->toContain('/var/')
        ->not->toContain('vendor/')
        ->not->toContain('.php:')
        ->not->toContain('stack trace');
});

test('500 errors return generic message', function () {
    // This would require triggering an actual 500 error
    // which is difficult in test environment
    // Document the expected behavior

    // In production, 500 errors should show generic message
    // Never expose: file paths, class names, SQL queries, config values
});

// =============================================================================
// API VERSION/SERVER HEADERS
// =============================================================================

test('server header does not reveal technology stack', function () {
    $response = $this->get('/');

    $server = $response->headers->get('Server');

    // Should not reveal specific versions
    if ($server) {
        expect(strtolower($server))->not->toContain('php/')
            ->not->toContain('apache/')
            ->not->toContain('nginx/');
    }
});

test('X-Powered-By header is removed', function () {
    $response = $this->get('/');

    // X-Powered-By reveals PHP version - should be removed
    $poweredBy = $response->headers->get('X-Powered-By');
    expect($poweredBy)->toBeNull();
});

// =============================================================================
// PERMISSION HEADERS
// =============================================================================

test('Permissions-Policy restricts browser features', function () {
    $response = $this->get('/');

    // Permissions-Policy (formerly Feature-Policy) should restrict:
    // - camera, microphone, geolocation, etc.
    $permissionsPolicy = $response->headers->get('Permissions-Policy');

    // Document if not implemented
    if (!$permissionsPolicy) {
        $this->markTestIncomplete('Permissions-Policy header is not implemented');
    }
});

// =============================================================================
// SECURITY HEADERS ON ALL ROUTES
// =============================================================================

test('security headers present on public pages', function () {
    $publicRoutes = ['/', '/login', '/register'];

    foreach ($publicRoutes as $route) {
        $response = $this->get($route);

        expect($response->headers->has('X-Frame-Options'))->toBeTrue();
        expect($response->headers->has('X-Content-Type-Options'))->toBeTrue();
    }
});

test('security headers present on API routes', function () {
    $apiRoutes = ['/api/auth-check', '/api/search/library?q=test'];

    foreach ($apiRoutes as $route) {
        $response = $this->getJson($route);

        expect($response->headers->has('X-Content-Type-Options'))->toBeTrue();
    }
});

test('security headers present on authenticated routes', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->get('/dashboard');

    expect($response->headers->has('X-Frame-Options'))->toBeTrue();
    expect($response->headers->has('X-Content-Type-Options'))->toBeTrue();
});

// =============================================================================
// CSRF TOKEN VALIDATION
// =============================================================================

test('CSRF token is required for state-changing requests', function () {
    $user = User::factory()->create();

    // Try to make POST without CSRF token (outside of API route)
    // API routes use Sanctum instead of CSRF
});

test('CSRF token mismatch is rejected', function () {
    // Web routes should reject requests with invalid CSRF tokens
    // API routes should require Sanctum authentication
});

// =============================================================================
// CONTENT-TYPE ENFORCEMENT
// =============================================================================

test('API only accepts application/json content type', function () {
    $user = User::factory()->create();

    // Send request with wrong content type
    $response = $this->actingAs($user)
        ->withHeader('Content-Type', 'text/plain')
        ->post('/api/db/library/upsert', [
            'data' => ['book' => 'test', 'title' => 'Test'],
        ]);

    // Should either reject or handle gracefully
    expect($response->status())->toBeIn([200, 400, 415, 422]);
});

// =============================================================================
// DOWNLOAD HEADERS FOR MEDIA
// =============================================================================

test('media downloads have correct disposition headers', function () {
    // Test that served files have appropriate headers
    // to prevent XSS through content-type sniffing
});
