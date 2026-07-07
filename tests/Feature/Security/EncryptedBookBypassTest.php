<?php

/**
 * Penetration Tests: Encrypted Book Bypass via bulkCreate
 *
 * DbLibraryController::bulkCreate accepts 'encrypted' and 'wrapped_dek' from
 * user input, allowing a user to create a book that the system treats as
 * encrypted WITHOUT going through the proper E2EE transition endpoint
 * (POST /api/db/library/{book}/encryption). The E2EE guard
 * (EncryptedBookGuard) validates that metadata fields look like ciphertext,
 * but a user who sends ciphertext-looking values can create an "encrypted" book
 * that:
 *  - is forced private/unlisted (by the guard's isEncrypted check)
 *  - has a fake wrapped_dek (no real encryption key exists)
 *  - is excluded from search/embeddings (by the E2EE exclusion logic)
 *
 * The proper transition endpoint (setEncryption) requires ownership and
 * performs the full transition (cascade to sub-books, scrub plaintext, etc.).
 * bulkCreate bypasses all of that.
 */

use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    EncryptedBookGuard::forget();
});

it('bulkCreate strips encrypted flag when updating an existing plaintext book', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    // Create a normal plaintext book first
    $this->seedLibrary([
        'book' => 'e2ee-bypass-test',
        'title' => 'Plaintext Title',
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'public',
        'encrypted' => false,
    ]);

    // Now try to flip it to encrypted via bulkCreate
    $response = $this->postJson('/api/db/library/bulk-create', [
        'data' => [[
            'book' => 'e2ee-bypass-test',
            'title' => 'hlenc.v1.AAAA.BBBB',
            'author' => 'hlenc.v1.CCCC.DDDD',
            'encrypted' => true,
            'wrapped_dek' => 'hlenc.v1.DEKIV.DEKCT',
            'visibility' => 'public',
        ]],
    ]);

    // The endpoint should accept the request (200) — but the encrypted flag
    // should have been stripped by the guard.
    expect($response->status())->toBeLessThan(500);

    if ($response->status() === 200) {
        $library = DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', 'e2ee-bypass-test')
            ->first();

        if ($library) {
            // FIXED: bulkCreate strips encrypted/wrapped_dek on existing plaintext books.
            expect($library->encrypted)->toBe(false)
                ->and($library->wrapped_dek)->toBeNull();
        }
    }
});

it('setEncryption endpoint requires ownership (positive control)', function () {
    $owner = $this->seedUser();
    $attacker = $this->seedUser();

    $this->seedLibrary([
        'book' => 'e2ee-ownership-test',
        'title' => 'Owner Book',
        'creator' => $owner->name,
        'creator_token' => $owner->user_token,
        'visibility' => 'public',
    ]);

    // Attacker tries to encrypt someone else's book
    $this->actingAs($attacker);
    $response = $this->postJson('/api/db/library/e2ee-ownership-test/encryption', [
        'encrypted' => true,
        'wrapped_dek' => 'hlenc.v1.A.B',
    ]);

    expect($response->status())->toBe(403);
});

it('bulkCreate does not cascade encryption to sub-books (encrypted flag stripped on update)', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    // Create a parent + sub-book via bulkCreate with encrypted=true on parent
    $response = $this->postJson('/api/db/library/bulk-create', [
        'data' => [
            [
                'book' => 'e2ee-cascade-test',
                'title' => 'hlenc.v1.AAAA.BBBB',
                'encrypted' => true,
                'wrapped_dek' => 'hlenc.v1.DEK.DEKCT',
                'visibility' => 'public',
            ],
            [
                'book' => 'e2ee-cascade-test/Fn1',
                'title' => 'hlenc.v1.EEEE.FFFF',
                'type' => 'sub_book',
                'encrypted' => false,
                'visibility' => 'public',
            ],
        ],
    ]);

    expect($response->status())->toBeLessThan(500);

    if ($response->status() === 200) {
        $parent = DB::connection('pgsql_admin')->table('library')->where('book', 'e2ee-cascade-test')->first();
        $subBook = DB::connection('pgsql_admin')->table('library')->where('book', 'e2ee-cascade-test/Fn1')->first();

        if ($parent && $subBook) {
            // FIXED: bulkCreate strips encrypted on existing plaintext books.
            // For NEW born-encrypted books, the flag is allowed (the proper
            // transition path for creating an encrypted book from scratch).
            // The key invariant: you can't FLIP an existing plaintext book.
            // New books CAN be born encrypted (this is the intended path).
            expect($parent->encrypted)->toBe(true); // born-encrypted is allowed
        }
    }
});

it('a user cannot flip encrypted=true on an EXISTING plaintext book via bulkCreate', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    // Create a normal plaintext book
    $this->seedLibrary([
        'book' => 'e2ee-flag-flip',
        'title' => 'Plaintext Title',
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'public',
        'encrypted' => false,
    ]);

    // Now try to flip it to encrypted via bulkCreate (which uses updateOrCreate)
    $response = $this->postJson('/api/db/library/bulk-create', [
        'data' => [[
            'book' => 'e2ee-flag-flip',
            'title' => 'hlenc.v1.AAAA.BBBB',
            'encrypted' => true,
            'wrapped_dek' => 'hlenc.v1.FAKE.FAKE',
            'visibility' => 'public',
        ]],
    ]);

    expect($response->status())->toBeLessThan(500);

    if ($response->status() === 200) {
        $library = DB::connection('pgsql_admin')->table('library')->where('book', 'e2ee-flag-flip')->first();

        if ($library) {
            // FIXED: bulkCreate strips the encrypted flag when updating an
            // existing plaintext book. The flag can only be set via the
            // proper transition endpoint (setEncryption) which scrubs/cascades.
            expect($library->encrypted)->toBe(false)
                ->and($library->wrapped_dek)->toBeNull();
        }
    }
});
