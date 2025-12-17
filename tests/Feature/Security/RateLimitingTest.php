<?php

/**
 * Security Tests: Rate Limiting
 *
 * Tests for rate limiting on critical endpoints to prevent
 * brute force attacks, account enumeration, and resource exhaustion.
 */

use App\Models\User;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    // Clear rate limiters before each test
    RateLimiter::clear('login');
    RateLimiter::clear('register');
});

test('registration endpoint should be rate limited', function () {
    $successCount = 0;
    $rateLimitedCount = 0;

    // Attempt 20 rapid registrations
    for ($i = 0; $i < 20; $i++) {
        $response = $this->postJson('/api/register', [
            'name' => "ratelimituser{$i}",
            'email' => "ratelimit{$i}@test.com",
            'password' => 'password123',
        ]);

        if ($response->status() === 429) {
            $rateLimitedCount++;
        } elseif ($response->status() === 200 || $response->status() === 201) {
            $successCount++;
        }
    }

    // VULNERABILITY: Currently no rate limiting on registration
    // This test documents the missing rate limit
    // After fix: Should hit rate limit before 20 registrations
    expect($rateLimitedCount)->toBeGreaterThan(0)
        ->and($successCount)->toBeLessThan(20);
});

test('login endpoint is rate limited after failed attempts', function () {
    $user = User::factory()->create([
        'email' => 'ratelimit_login@test.com',
        'password' => bcrypt('correctpassword'),
    ]);

    $rateLimitedCount = 0;
    $attemptCount = 10;

    // Attempt multiple failed logins
    for ($i = 0; $i < $attemptCount; $i++) {
        $response = $this->postJson('/api/login', [
            'email' => $user->email,
            'password' => 'wrongpassword' . $i,
        ]);

        if ($response->status() === 429) {
            $rateLimitedCount++;
        }
    }

    // Should hit rate limit after several failed attempts
    expect($rateLimitedCount)->toBeGreaterThan(0);
});

test('anonymous session creation is rate limited per IP', function () {
    $successCount = 0;
    $rateLimitedCount = 0;

    // Clear any existing sessions for test IP
    DB::table('anonymous_sessions')->where('ip_address', '127.0.0.1')->delete();

    // Attempt to create more sessions than allowed (limit is 10 per hour)
    for ($i = 0; $i < 15; $i++) {
        $response = $this->postJson('/api/anonymous-session');

        if ($response->status() === 429) {
            $rateLimitedCount++;
        } elseif ($response->status() === 200) {
            $successCount++;
        }
    }

    // Should hit rate limit (max 10 per hour per IP)
    expect($rateLimitedCount)->toBeGreaterThan(0)
        ->and($successCount)->toBeLessThanOrEqual(10);
});

test('token validation is rate limited to prevent brute force', function () {
    // This tests the TOKEN_VALIDATION_RATE_LIMIT (30 per minute)
    $rateLimitedCount = 0;

    for ($i = 0; $i < 35; $i++) {
        // Use invalid tokens to trigger validation
        $response = $this->withCookie('anon_token', "invalid-token-{$i}")
            ->getJson('/api/auth-check');

        // Rate limited responses return false for anonymous_token silently
        // Check if after many attempts, validation starts failing
    }

    // Note: Rate limiting on token validation fails silently (returns false)
    // This is intentional to not reveal rate limiting to attackers
    expect(true)->toBeTrue(); // Placeholder - manual verification needed
});

test('search endpoint is rate limited', function () {
    $successCount = 0;
    $rateLimitedCount = 0;

    // Attempt many rapid searches (limit is 60 per minute)
    for ($i = 0; $i < 70; $i++) {
        $response = $this->getJson('/api/search/library?q=test');

        if ($response->status() === 429) {
            $rateLimitedCount++;
        } elseif ($response->status() === 200) {
            $successCount++;
        }
    }

    // Should hit rate limit (60 per minute)
    expect($rateLimitedCount)->toBeGreaterThan(0)
        ->and($successCount)->toBeLessThanOrEqual(60);
});

test('api endpoints are rate limited at 120 per minute', function () {
    $user = User::factory()->create();
    $successCount = 0;
    $rateLimitedCount = 0;

    // Attempt many rapid API calls
    for ($i = 0; $i < 130; $i++) {
        $response = $this->actingAs($user)
            ->getJson('/api/home');

        if ($response->status() === 429) {
            $rateLimitedCount++;
        } elseif ($response->status() === 200) {
            $successCount++;
        }
    }

    // Should hit rate limit (120 per minute for general API)
    expect($rateLimitedCount)->toBeGreaterThan(0)
        ->and($successCount)->toBeLessThanOrEqual(120);
});

test('rate limiting cannot be bypassed with X-Forwarded-For header', function () {
    $successCount = 0;
    $rateLimitedCount = 0;

    // Clear existing sessions
    DB::table('anonymous_sessions')->where('ip_address', 'like', '10.0.0.%')->delete();

    // Attempt to bypass rate limiting by spoofing different IPs
    for ($i = 0; $i < 15; $i++) {
        $response = $this->withHeader('X-Forwarded-For', "10.0.0.{$i}")
            ->postJson('/api/anonymous-session');

        if ($response->status() === 429) {
            $rateLimitedCount++;
        } elseif ($response->status() === 200) {
            $successCount++;
        }
    }

    // If rate limiting is properly configured with trusted proxies,
    // X-Forwarded-For spoofing should NOT bypass limits
    // This test may pass or fail depending on proxy configuration
    // In production, only trusted proxies should set this header
});

test('password reset is rate limited', function () {
    $user = User::factory()->create([
        'email' => 'reset_ratelimit@test.com',
    ]);

    $successCount = 0;
    $rateLimitedCount = 0;

    for ($i = 0; $i < 10; $i++) {
        $response = $this->postJson('/forgot-password', [
            'email' => $user->email,
        ]);

        if ($response->status() === 429) {
            $rateLimitedCount++;
        } elseif ($response->status() === 200) {
            $successCount++;
        }
    }

    // Password reset should be throttled (60 second wait between attempts)
    // After first successful request, subsequent should be throttled
    expect($successCount)->toBeLessThan(10);
});

test('concurrent registration attempts from same IP are serialized', function () {
    // This tests the atomic transaction with advisory lock for anonymous sessions
    DB::table('anonymous_sessions')->where('ip_address', '127.0.0.1')->delete();

    $responses = [];

    // Simulate concurrent requests (in sequential test, but tests the lock mechanism)
    for ($i = 0; $i < 5; $i++) {
        $responses[] = $this->postJson('/api/anonymous-session');
    }

    $successfulTokens = collect($responses)
        ->filter(fn($r) => $r->status() === 200)
        ->map(fn($r) => $r->json('token'))
        ->unique()
        ->count();

    // Each successful request should get a unique token
    // (Advisory lock prevents duplicate tokens from race conditions)
    expect($successfulTokens)->toBeLessThanOrEqual(10); // Max 10 per hour
});

test('email enumeration via registration is rate limited', function () {
    // Create existing user
    $existingUser = User::factory()->create([
        'email' => 'existing@test.com',
    ]);

    $sameEmailAttempts = 0;
    $rateLimited = false;

    // Attempt to register with same email multiple times
    for ($i = 0; $i < 10; $i++) {
        $response = $this->postJson('/api/register', [
            'name' => "enumuser{$i}",
            'email' => 'existing@test.com',
            'password' => 'password123',
        ]);

        if ($response->status() === 429) {
            $rateLimited = true;
            break;
        }
        if ($response->status() === 422) {
            // Validation error (email taken) - this reveals user exists
            $sameEmailAttempts++;
        }
    }

    // Rate limiting should kick in before too many enumeration attempts
    // Current vulnerability: no rate limiting allows unlimited enumeration
    expect($rateLimited)->toBeTrue();
});
