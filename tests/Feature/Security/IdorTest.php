<?php

/**
 * Security Tests: IDOR (Insecure Direct Object Reference)
 *
 * Tests for authorization bypass vulnerabilities where users
 * can access or modify resources belonging to other users.
 */

use App\Models\User;
use App\Models\PgLibrary;
use App\Models\PgHyperlight;
use App\Models\PgHypercite;
use App\Models\PgNode;
use Illuminate\Support\Str;
use Illuminate\Support\Facades\DB;

// =============================================================================
// HIGHLIGHT IDOR TESTS
// =============================================================================

test('cannot modify another users highlight', function () {
    $userA = $this->seedUser(['name' => 'user_a_idor']);
    $userB = $this->seedUser(['name' => 'user_b_idor']);

    // Create a public book
    $this->seedLibrary([
        'book' => 'public-idor-highlight-test',
        'title' => 'Public Book',
        'creator' => $userA->name,
        'visibility' => 'public',
    ]);

    // User A creates a highlight
    $this->seedHyperlight([
        'book' => 'public-idor-highlight-test',
        'hyperlight_id' => 'idor-hl-test',
        'node_id' => 'n1',
        'highlightedText' => 'Original text by User A',
        'annotation' => 'User A private note',
        'creator' => $userA->name,
        'time_since' => time(),
    ]);

    // User B attempts to modify User A's highlight
    $response = $this->actingAs($userB)
        ->postJson('/api/db/hyperlights/upsert', [
            'data' => [[
                'book' => 'public-idor-highlight-test',
                'hyperlight_id' => 'idor-hl-test',
                'node_id' => 'n1',
                'highlightedText' => 'MODIFIED BY ATTACKER',
                'annotation' => 'Hijacked annotation!',
            ]],
        ]);

    // Verify original data is preserved
    $highlight = PgHyperlight::where('hyperlight_id', 'idor-hl-test')->first();

    expect($highlight->highlightedText)->toBe('Original text by User A')
        ->and($highlight->annotation)->toBe('User A private note')
        ->and($highlight->creator)->toBe('user_a_idor');

    // Clean up
    PgHyperlight::where('hyperlight_id', 'idor-hl-test')->delete();
    PgLibrary::where('book', 'public-idor-highlight-test')->delete();
});

test('cannot delete another users highlight', function () {
    $owner = $this->seedUser(['name' => 'idor_owner']);
    $attacker = $this->seedUser(['name' => 'idor_attacker']);

    $this->seedLibrary([
        'book' => 'idor-delete-test',
        'title' => 'Test Book',
        'creator' => $owner->name,
        'visibility' => 'public',
    ]);

    $this->seedHyperlight([
        'book' => 'idor-delete-test',
        'hyperlight_id' => 'hl-delete-idor',
        'node_id' => 'n1',
        'highlightedText' => 'Protected text',
        'creator' => $owner->name,
        'time_since' => time(),
    ]);

    // Attacker attempts to delete owner's highlight
    $response = $this->actingAs($attacker)
        ->postJson('/api/db/hyperlights/delete', [
            'data' => [[
                'book' => 'idor-delete-test',
                'hyperlight_id' => 'hl-delete-idor',
            ]],
        ]);

    // Highlight should still exist
    expect(PgHyperlight::where('hyperlight_id', 'hl-delete-idor')->exists())->toBeTrue();

    // Clean up
    PgHyperlight::where('hyperlight_id', 'hl-delete-idor')->delete();
    PgLibrary::where('book', 'idor-delete-test')->delete();
});

// =============================================================================
// HYPERCITE IDOR TESTS
// =============================================================================

test('cannot modify another users hypercite', function () {
    $userA = $this->seedUser(['name' => 'cite_owner']);
    $userB = $this->seedUser(['name' => 'cite_attacker']);

    $this->seedLibrary([
        'book' => 'idor-cite-test',
        'title' => 'Test Book',
        'creator' => $userA->name,
        'visibility' => 'public',
    ]);

    $this->seedHypercite([
        'book' => 'idor-cite-test',
        'hypercite_id' => 'idor-cite-id',
        'node_id' => 'n1',
        'hypercitedText' => 'Original citation by User A',
        'creator' => $userA->name,
        'time_since' => time(),
    ]);

    // User B attempts to modify
    $response = $this->actingAs($userB)
        ->postJson('/api/db/hypercites/upsert', [
            'data' => [[
                'book' => 'idor-cite-test',
                'hypercite_id' => 'idor-cite-id',
                'node_id' => 'n1',
                'hypercitedText' => 'HIJACKED CITATION',
            ]],
        ]);

    $cite = PgHypercite::where('hypercite_id', 'idor-cite-id')->first();
    expect($cite->hypercitedText)->toBe('Original citation by User A')
        ->and($cite->creator)->toBe('cite_owner');

    // Clean up
    PgHypercite::where('hypercite_id', 'idor-cite-id')->delete();
    PgLibrary::where('book', 'idor-cite-test')->delete();
});

// =============================================================================
// LIBRARY/BOOK IDOR TESTS
// =============================================================================

test('cannot delete book owned by another user', function () {
    $owner = $this->seedUser(['name' => 'book_owner']);
    $attacker = $this->seedUser(['name' => 'book_attacker']);

    $this->seedLibrary([
        'book' => 'protected-book-idor',
        'title' => 'Owner\'s Protected Book',
        'creator' => $owner->name,
        'visibility' => 'public',
    ]);

    $response = $this->actingAs($attacker)
        ->deleteJson('/api/books/protected-book-idor');

    // Should be forbidden
    $response->assertStatus(403);

    // Book should still exist
    expect(PgLibrary::where('book', 'protected-book-idor')->exists())->toBeTrue();

    // Clean up
    PgLibrary::where('book', 'protected-book-idor')->delete();
});

test('cannot modify another users book metadata', function () {
    $owner = $this->seedUser(['name' => 'metadata_owner']);
    $attacker = $this->seedUser(['name' => 'metadata_attacker']);

    $this->seedLibrary([
        'book' => 'metadata-idor-test',
        'title' => 'Original Title',
        'author' => 'Original Author',
        'creator' => $owner->name,
        'visibility' => 'private',
    ]);

    // Attacker tries to modify metadata
    $response = $this->actingAs($attacker)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'metadata-idor-test',
                'title' => 'HIJACKED TITLE',
                'author' => 'HIJACKED AUTHOR',
            ],
        ]);

    // Verify original data preserved
    $library = PgLibrary::where('book', 'metadata-idor-test')->first();
    expect($library->title)->toBe('Original Title')
        ->and($library->author)->toBe('Original Author')
        ->and($library->creator)->toBe('metadata_owner');

    // Clean up
    PgLibrary::where('book', 'metadata-idor-test')->delete();
});

test('cannot change book visibility if not owner', function () {
    $owner = $this->seedUser(['name' => 'visibility_owner']);
    $attacker = $this->seedUser(['name' => 'visibility_attacker']);

    $this->seedLibrary([
        'book' => 'visibility-idor-test',
        'title' => 'Private Book',
        'creator' => $owner->name,
        'visibility' => 'private',
    ]);

    // Attacker tries to make it public
    $response = $this->actingAs($attacker)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'visibility-idor-test',
                'visibility' => 'public',
            ],
        ]);

    // Visibility should remain private
    $library = PgLibrary::where('book', 'visibility-idor-test')->first();
    expect($library->visibility)->toBe('private');

    // Clean up
    PgLibrary::where('book', 'visibility-idor-test')->delete();
});

// =============================================================================
// PRIVATE BOOK ACCESS TESTS
// =============================================================================

test('cannot access private book data', function () {
    $owner = $this->seedUser();
    $stranger = $this->seedUser();

    $this->seedLibrary([
        'book' => 'private-book-access-test',
        'title' => 'Secret Book',
        'creator' => $owner->name,
        'visibility' => 'private',
        'listed' => false,
    ]);

    $this->seedNode([
        'book' => 'private-book-access-test',
        'node_id' => 'secret_node',
        'startLine' => 100,
        'content' => '<p>Secret content that should not be visible</p>',
        'plainText' => 'Secret content that should not be visible',
    ]);

    // Stranger tries to access book data
    $response = $this->actingAs($stranger)
        ->getJson('/api/database-to-indexeddb/books/private-book-access-test/data');

    $response->assertStatus(403);

    // Clean up
    PgNode::where('book', 'private-book-access-test')->delete();
    PgLibrary::where('book', 'private-book-access-test')->delete();
});

test('owner can access their private book', function () {
    $owner = $this->seedUser();

    $this->seedLibrary([
        'book' => 'owner-private-book-test',
        'title' => 'My Secret Book',
        'creator' => $owner->name,
        'visibility' => 'private',
    ]);

    $response = $this->actingAs($owner)
        ->getJson('/api/database-to-indexeddb/books/owner-private-book-test/data');

    // Owner should be able to access
    expect($response->status())->toBeIn([200, 404]); // 404 if no data yet

    // Clean up
    PgLibrary::where('book', 'owner-private-book-test')->delete();
});

test('private books not returned in search results for non-owners', function () {
    $owner = $this->seedUser(['name' => 'search_owner']);
    $searcher = $this->seedUser(['name' => 'search_stranger']);

    $this->seedLibrary([
        'book' => 'searchable-private-idor',
        'title' => 'UniqueSearchablePrivateBook123',
        'creator' => $owner->name,
        'visibility' => 'private',
        'listed' => false,
    ]);

    $response = $this->actingAs($searcher)
        ->getJson('/api/search/library?q=UniqueSearchablePrivateBook123');

    $response->assertOk();

    // Should not find private book
    $results = $response->json('results') ?? [];
    $books = collect($results)->pluck('book')->toArray();
    expect($books)->not->toContain('searchable-private-idor');

    // Clean up
    PgLibrary::where('book', 'searchable-private-idor')->delete();
});

// =============================================================================
// HIDE HIGHLIGHT AUTHORIZATION TESTS
// =============================================================================

test('book owner can hide highlights on their book', function () {
    $bookOwner = $this->seedUser(['name' => 'book_owner_hide']);
    $highlightCreator = $this->seedUser(['name' => 'highlight_creator_hide']);

    $this->seedLibrary([
        'book' => 'hide-test-book',
        'title' => 'Book for hide test',
        'creator' => $bookOwner->name,
        'visibility' => 'public',
    ]);

    $this->seedHyperlight([
        'book' => 'hide-test-book',
        'hyperlight_id' => 'hl-hide-test',
        'node_id' => 'n1',
        'highlightedText' => 'User highlight on book',
        'creator' => $highlightCreator->name,
        'time_since' => time(),
        'hidden' => false,
    ]);

    // Book owner hides another user's highlight (moderation feature)
    $response = $this->actingAs($bookOwner)
        ->postJson('/api/db/hyperlights/hide', [
            'data' => [[
                'book' => 'hide-test-book',
                'hyperlight_id' => 'hl-hide-test',
            ]],
        ]);

    // Book owner CAN hide highlights on their book (this is intentional for moderation)
    $highlight = PgHyperlight::where('hyperlight_id', 'hl-hide-test')->first();
    expect($highlight->hidden)->toBeTrue();

    // Clean up
    PgHyperlight::where('hyperlight_id', 'hl-hide-test')->delete();
    PgLibrary::where('book', 'hide-test-book')->delete();
});

test('non-owner cannot hide highlights on others books', function () {
    $bookOwner = $this->seedUser(['name' => 'real_owner']);
    $highlightCreator = $this->seedUser(['name' => 'hl_creator']);
    $randomUser = $this->seedUser(['name' => 'random_user']);

    $this->seedLibrary([
        'book' => 'no-hide-rights-book',
        'title' => 'Someone else book',
        'creator' => $bookOwner->name,
        'visibility' => 'public',
    ]);

    $this->seedHyperlight([
        'book' => 'no-hide-rights-book',
        'hyperlight_id' => 'hl-no-hide',
        'node_id' => 'n1',
        'highlightedText' => 'A highlight',
        'creator' => $highlightCreator->name,
        'time_since' => time(),
        'hidden' => false,
    ]);

    // Random user (not book owner, not highlight creator) tries to hide
    $response = $this->actingAs($randomUser)
        ->postJson('/api/db/hyperlights/hide', [
            'data' => [[
                'book' => 'no-hide-rights-book',
                'hyperlight_id' => 'hl-no-hide',
            ]],
        ]);

    // Should not be hidden
    $highlight = PgHyperlight::where('hyperlight_id', 'hl-no-hide')->first();
    expect($highlight->hidden)->toBeFalse();

    // Clean up
    PgHyperlight::where('hyperlight_id', 'hl-no-hide')->delete();
    PgLibrary::where('book', 'no-hide-rights-book')->delete();
});

// =============================================================================
// TIMESTAMP MANIPULATION TESTS
// =============================================================================

test('non-owner cannot update library timestamp', function () {
    $owner = $this->seedUser(['name' => 'ts_owner']);
    $attacker = $this->seedUser(['name' => 'ts_attacker']);

    $originalTimestamp = 1000000;

    $this->seedLibrary([
        'book' => 'timestamp-idor-test',
        'title' => 'Timestamp Test',
        'creator' => $owner->name,
        'visibility' => 'public',
        'timestamp' => $originalTimestamp,
    ]);

    // Attacker tries to update timestamp
    $response = $this->actingAs($attacker)
        ->postJson('/api/db/library/update-timestamp', [
            'book' => 'timestamp-idor-test',
            'timestamp' => 9999999,
        ]);

    // Timestamp should remain unchanged
    $library = PgLibrary::where('book', 'timestamp-idor-test')->first();
    expect($library->timestamp)->toBe($originalTimestamp);

    // Clean up
    PgLibrary::where('book', 'timestamp-idor-test')->delete();
});

// =============================================================================
// ANONYMOUS TOKEN IDOR TESTS
// =============================================================================

test('anonymous user cannot access others private books via token guessing', function () {
    $owner = $this->seedUser();
    $ownerToken = Str::uuid()->toString();

    DB::table('anonymous_sessions')->insert([
        'token' => $ownerToken,
        'created_at' => now(),
        'last_used_at' => now(),
        'ip_address' => '192.168.1.1',
    ]);

    $this->seedLibrary([
        'book' => 'anon-private-book',
        'title' => 'Anonymous Private Book',
        'creator_token' => $ownerToken,
        'visibility' => 'private',
    ]);

    // Different anonymous user with different token tries to access
    $attackerToken = Str::uuid()->toString();
    DB::table('anonymous_sessions')->insert([
        'token' => $attackerToken,
        'created_at' => now(),
        'last_used_at' => now(),
        'ip_address' => '192.168.1.2',
    ]);

    $response = $this->withCookie('anon_token', $attackerToken)
        ->getJson('/api/database-to-indexeddb/books/anon-private-book/data');

    $response->assertStatus(403);

    // Clean up
    PgLibrary::where('book', 'anon-private-book')->delete();
    DB::table('anonymous_sessions')->whereIn('token', [$ownerToken, $attackerToken])->delete();
});
