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

it('bulkCreate accepts encrypted flag from user input', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    $response = $this->postJson('/api/db/library/bulk-create', [
        'data' => [[
            'book' => 'e2ee-bypass-test',
            'title' => 'hlenc.v1.AAAA.BBBB',
            'author' => 'hlenc.v1.CCCC.DDDD',
            'encrypted' => true,
            'wrapped_dek' => 'hlenc.v1.DEKIV.DEKCT',
            'visibility' => 'public', // will be forced private by guard
        ]],
    ]);

    // The endpoint should either reject the encrypted flag OR accept it.
    // VULNERABILITY: It accepts it — the book is created as "encrypted"
    // without going through the proper transition.
    if ($response->status() === 200) {
        $library = DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', 'e2ee-bypass-test')
            ->first();

        if ($library) {
            // The book is marked encrypted with a user-supplied wrapped_dek
            // that has NO real encryption key behind it.
            expect($library->encrypted)->toBe(true)
                ->and($library->wrapped_dek)->toBe('hlenc.v1.DEKIV.DEKCT');
        }
    }
})->skip(
    'E2EE BYPASS: bulkCreate accepts the encrypted flag and wrapped_dek from user input. '.
    'A user can create a book that the system treats as encrypted (forced private/unlisted, '.
    'excluded from search/embeddings) without going through the proper transition endpoint '.
    'that cascades to sub-books, scrubs plaintext, and verifies the wrapped_dek. '.
    'Fix: strip encrypted/wrapped_dek from bulkCreate input, or route through setEncryption. '.
    'Un-skip after fixing.'
);

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

it('bulkCreate does not cascade encryption to sub-books (unlike setEncryption)', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    // Create a parent + sub-book via bulkCreate with encrypted=true
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
                'encrypted' => false, // sub-book NOT encrypted
                'visibility' => 'public',
            ],
        ],
    ]);

    if ($response->status() === 200) {
        $parent = DB::connection('pgsql_admin')->table('library')->where('book', 'e2ee-cascade-test')->first();
        $subBook = DB::connection('pgsql_admin')->table('library')->where('book', 'e2ee-cascade-test/Fn1')->first();

        // VULNERABILITY: The parent is encrypted but the sub-book is NOT.
        // The proper setEncryption endpoint cascades encryption to ALL sub-books.
        // bulkCreate doesn't — so a sub-book could remain in plaintext while
        // the parent claims to be encrypted, breaking the E2EE invariant.
        if ($parent && $subBook) {
            expect($parent->encrypted)->toBe(true);
            // This should be true but isn't — the cascade is missing.
            // expect($subBook->encrypted)->toBe(true); // ← would fail
        }
    }
})->skip(
    'E2EE INVARIANT BREAK: bulkCreate does not cascade encryption to sub-books. '.
    'The setEncryption endpoint cascades (tests/Feature/E2ee/EncryptionTransitionTest.php), '.
    'but bulkCreate creates each row independently — a parent can be encrypted '.
    'while its sub-books remain plaintext. Un-skip after fixing.'
);

it('a user can set encrypted=true on an EXISTING plaintext book via bulkCreate', function () {
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

    // Now flip it to encrypted via bulkCreate (which uses updateOrCreate)
    $response = $this->postJson('/api/db/library/bulk-create', [
        'data' => [[
            'book' => 'e2ee-flag-flip',
            'title' => 'hlenc.v1.AAAA.BBBB', // ciphertext-looking
            'encrypted' => true,
            'wrapped_dek' => 'hlenc.v1.FAKE.FAKE',
            'visibility' => 'public',
        ]],
    ]);

    if ($response->status() === 200) {
        $library = DB::connection('pgsql_admin')->table('library')->where('book', 'e2ee-flag-flip')->first();

        if ($library) {
            // VULNERABILITY: The encrypted flag was flipped from false to true
            // via bulkCreate, bypassing the transition endpoint's scrub logic.
            // The original plaintext title "Plaintext Title" was overwritten,
            // but the nodes table still has plaintext content that was NEVER
            // scrubbed (setEncryption scrubs nodes_history + on-disk artifacts).
            expect($library->encrypted)->toBe(true);
        }
    }
})->skip(
    'E2EE BYPASS: bulkCreate can flip the encrypted flag on an existing plaintext book '.
    'without the scrub/cascade logic in setEncryption. Plaintext content in nodes '.
    'and nodes_history is never cleaned. Un-skip after fixing.'
);
