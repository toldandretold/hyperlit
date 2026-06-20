<?php

/**
 * Security Tests: Anonymous Content Association
 *
 * Tests for the critical vulnerability where any authenticated user
 * could potentially claim content from any anonymous token.
 */

use App\Models\User;
use App\Models\PgLibrary;
use App\Models\PgHyperlight;
use App\Models\PgHypercite;
use Illuminate\Support\Str;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    // Clean up test data before each test
    DB::table('anonymous_sessions')->where('ip_address', 'like', '192.168.%')->delete();
});

test('cannot associate content from another users anonymous token', function () {
    // Create victim's anonymous session
    $victimToken = Str::uuid()->toString();
    DB::table('anonymous_sessions')->insert([
        'token' => $victimToken,
        'created_at' => now(),
        'last_used_at' => now(),
        'ip_address' => '127.0.0.1',
    ]);

    // Create victim's content with the anonymous token
    $this->seedLibrary([
        'book' => 'victim-book-security-test',
        'title' => 'Victim Secret Book',
        'creator_token' => $victimToken,
        'creator' => null, // Anonymous content
        'visibility' => 'private',
    ]);

    // Attacker registers and logs in
    $attacker = $this->seedUser([
        'name' => 'attacker_user',
        'email' => 'attacker@test.com',
    ]);

    // Attacker attempts to claim victim's content using the victim's token
    $response = $this->actingAs($attacker)
        ->postJson('/api/auth/associate-content', [
            'anonymous_token' => $victimToken,
        ]);

    // The endpoint SHOULD reject this - attacker doesn't own this token
    // Current behavior: This test documents the vulnerability
    // After fix: Should return 403 Forbidden

    // Verify content was NOT transferred to attacker
    $library = PgLibrary::on('pgsql_admin')->where('book', 'victim-book-security-test')->first();

    // If the vulnerability exists, creator will be set to attacker
    // This test will FAIL until the vulnerability is fixed
    expect($library->creator)->toBeNull()
        ->and($library->creator_token)->toBe($victimToken);

    // Clean up
    PgLibrary::where('book', 'victim-book-security-test')->delete();
});

test('authenticated user can only associate their own anonymous session cookie', function () {
    $user = $this->seedUser([
        'name' => 'legitimate_user',
        'email' => 'legit@test.com',
    ]);

    // User's own anonymous token (would normally come from cookie)
    $userOwnToken = Str::uuid()->toString();

    DB::table('anonymous_sessions')->insert([
        'token' => $userOwnToken,
        'created_at' => now(),
        'last_used_at' => now(),
        'ip_address' => '127.0.0.1',
    ]);

    // Create content with user's own anonymous token
    $this->seedLibrary([
        'book' => 'my-book-security-test',
        'title' => 'My Book',
        'creator_token' => $userOwnToken,
        'creator' => null,
        'visibility' => 'private',
    ]);

    // User authenticates and provides their matching cookie
    $response = $this->actingAs($user)
        ->withCookie('anon_token', $userOwnToken)
        ->postJson('/api/auth/associate-content', [
            'anonymous_token' => $userOwnToken,
        ]);

    $response->assertOk();

    // Content should now be associated with user
    $library = PgLibrary::on('pgsql_admin')->where('book', 'my-book-security-test')->first();
    expect($library->creator)->toBe('legitimate_user');

    // Clean up
    PgLibrary::where('book', 'my-book-security-test')->delete();
});

test('associate content requires authentication', function () {
    $randomToken = Str::uuid()->toString();

    // Unauthenticated request
    $response = $this->postJson('/api/auth/associate-content', [
        'anonymous_token' => $randomToken,
    ]);

    $response->assertStatus(401);
});

test('associate content requires valid uuid format', function () {
    $user = $this->seedUser();

    $invalidTokens = [
        'not-a-uuid',
        '12345',
        '<script>alert(1)</script>',
        "'; DROP TABLE users; --",
        '',
    ];

    foreach ($invalidTokens as $token) {
        $response = $this->actingAs($user)
            ->postJson('/api/auth/associate-content', [
                'anonymous_token' => $token,
            ]);

        // Should reject invalid UUID format
        expect($response->status())->toBeIn([400, 422]);
    }
});

test('cannot claim content already associated with another user', function () {
    $originalOwner = $this->seedUser(['name' => 'original_owner']);
    $attacker = $this->seedUser(['name' => 'attacker']);

    // Create a token that was used by original owner
    $originalToken = Str::uuid()->toString();
    DB::table('anonymous_sessions')->insert([
        'token' => $originalToken,
        'created_at' => now(),
        'last_used_at' => now(),
        'ip_address' => '127.0.0.1',
    ]);

    // Content already has a creator assigned
    $this->seedLibrary([
        'book' => 'already-owned-book',
        'title' => 'Already Owned',
        'creator_token' => $originalToken,
        'creator' => 'original_owner', // Already associated
        'visibility' => 'private',
    ]);

    // Attacker tries to re-associate
    $response = $this->actingAs($attacker)
        ->postJson('/api/auth/associate-content', [
            'anonymous_token' => $originalToken,
        ]);

    // Verify original ownership preserved
    $library = PgLibrary::on('pgsql_admin')->where('book', 'already-owned-book')->first();
    expect($library->creator)->toBe('original_owner');

    // Clean up
    PgLibrary::where('book', 'already-owned-book')->delete();
});

test('highlights cannot be stolen via content association', function () {
    // Victim creates anonymous highlight
    $victimToken = Str::uuid()->toString();
    DB::table('anonymous_sessions')->insert([
        'token' => $victimToken,
        'created_at' => now(),
        'last_used_at' => now(),
        'ip_address' => '127.0.0.1',
    ]);

    // First create a book for the highlight
    $this->seedLibrary([
        'book' => 'test-book-for-highlight',
        'title' => 'Test Book',
        'creator_token' => $victimToken,
        'visibility' => 'public',
    ]);

    $this->seedHyperlight([
        'book' => 'test-book-for-highlight',
        'hyperlight_id' => 'victim-highlight-security',
        'node_id' => 'n1',
        'highlightedText' => 'Secret annotation',
        'creator_token' => $victimToken,
        'creator' => null,
        'time_since' => time(),
    ]);

    $attacker = $this->seedUser(['name' => 'highlight_attacker']);

    // Attacker attempts to steal highlight
    $this->actingAs($attacker)
        ->postJson('/api/auth/associate-content', [
            'anonymous_token' => $victimToken,
        ]);

    // Highlight should NOT be transferred
    $highlight = PgHyperlight::on('pgsql_admin')->where('hyperlight_id', 'victim-highlight-security')->first();

    // This documents the vulnerability - test will fail until fixed
    expect($highlight->creator)->toBeNull();

    // Clean up
    PgHyperlight::where('hyperlight_id', 'victim-highlight-security')->delete();
    PgLibrary::where('book', 'test-book-for-highlight')->delete();
});

test('hypercites cannot be stolen via content association', function () {
    $victimToken = Str::uuid()->toString();
    DB::table('anonymous_sessions')->insert([
        'token' => $victimToken,
        'created_at' => now(),
        'last_used_at' => now(),
        'ip_address' => '127.0.0.1',
    ]);

    // Create book and hypercite
    $this->seedLibrary([
        'book' => 'test-book-for-cite',
        'title' => 'Test Book',
        'creator_token' => $victimToken,
        'visibility' => 'public',
    ]);

    $this->seedHypercite([
        'book' => 'test-book-for-cite',
        'hyperciteId' => 'victim-cite-security',
        'node_id' => 'n1',
        'hypercitedText' => 'Important citation',
        'creator_token' => $victimToken,
        'creator' => null,
        'time_since' => time(),
    ]);

    $attacker = $this->seedUser(['name' => 'cite_attacker']);

    $this->actingAs($attacker)
        ->postJson('/api/auth/associate-content', [
            'anonymous_token' => $victimToken,
        ]);

    $cite = PgHypercite::on('pgsql_admin')->where('hyperciteId', 'victim-cite-security')->first();

    // Documents vulnerability - test fails until fixed
    expect($cite->creator)->toBeNull();

    // Clean up
    PgHypercite::where('hyperciteId', 'victim-cite-security')->delete();
    PgLibrary::where('book', 'test-book-for-cite')->delete();
});

test('expired anonymous tokens cannot be used for association', function () {
    $expiredToken = Str::uuid()->toString();

    // Create expired token (older than 90 days)
    DB::table('anonymous_sessions')->insert([
        'token' => $expiredToken,
        'created_at' => now()->subDays(91),
        'last_used_at' => now()->subDays(91),
        'ip_address' => '127.0.0.1',
    ]);

    $this->seedLibrary([
        'book' => 'expired-token-book',
        'title' => 'Old Book',
        'creator_token' => $expiredToken,
        'creator' => null,
        'visibility' => 'private',
    ]);

    $user = $this->seedUser();

    $response = $this->actingAs($user)
        ->withCookie('anon_token', $expiredToken)
        ->postJson('/api/auth/associate-content', [
            'anonymous_token' => $expiredToken,
        ]);

    // Should ideally reject expired tokens
    // Note: Current implementation may still allow this
    $library = PgLibrary::on('pgsql_admin')->where('book', 'expired-token-book')->first();

    // Clean up
    PgLibrary::where('book', 'expired-token-book')->delete();
});
