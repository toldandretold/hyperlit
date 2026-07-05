<?php

use App\Services\BookImageStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * PUT /api/books/{book}/images/{filename} (docs/e2ee.md): the lock/publish
 * byte-replace endpoint. Owner-only, row must exist, and the HLENC1 magic guard
 * enforces the book's encryption direction (encrypted ⇒ must be ciphertext;
 * plaintext ⇒ must not be). GET lists rows under RLS.
 */

function uBook(): string
{
    return 'upl_'.Str::lower(Str::random(10));
}

function seedImage(string $book, string $filename = 'pic.png', bool $encrypted = false): void
{
    $store = app(BookImageStore::class);
    $path = $store->path($book, $filename);
    File::ensureDirectoryExists(dirname($path));
    File::put($path, $encrypted ? 'HLENC1'.str_repeat("\x00", 40) : 'plainbytes');
    DB::connection('pgsql_admin')->table('book_images')->insert([
        'id' => (string) Str::uuid(), 'book' => $book, 'filename' => $filename,
        'mime' => 'image/png', 'bytes' => 10, 'encrypted' => $encrypted,
        'created_at' => now(), 'updated_at' => now(),
    ]);
}

function rawPut($test, string $url, string $body)
{
    return $test->call('PUT', $url, [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $body);
}

it('requires ownership and an existing row', function () {
    // A PUBLIC book so a non-owner can SEE it (→ 403 write-denied); on a private
    // book RLS hides the library row entirely and a stranger gets 404 (below).
    $book = uBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    seedImage($book);

    // Guest → 401
    rawPut($this, "/api/books/{$book}/images/pic.png", 'x')->assertStatus(401);

    // Stranger who CAN see the (public) book but isn't owner → 403
    $stranger = $this->seedUser();
    $this->actingAs($stranger);
    rawPut($this, "/api/books/{$book}/images/pic.png", 'x')->assertStatus(403);

    // Owner, missing row → 404
    $this->actingAs($owner);
    rawPut($this, "/api/books/{$book}/images/nope.png", 'x')->assertStatus(404);
});

it('404s a stranger on a PRIVATE book (RLS hides the library row — no existence leak)', function () {
    $book = uBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    seedImage($book);

    $stranger = $this->seedUser();
    $this->actingAs($stranger);
    rawPut($this, "/api/books/{$book}/images/pic.png", 'x')->assertStatus(404);
});

it('enforces the magic guard both directions', function () {
    // Encrypted book: plaintext body rejected, HLENC1 accepted
    $encBook = uBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $encBook, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private', 'encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B']);
    seedImage($encBook, encrypted: false);
    \App\Services\E2ee\EncryptedBookGuard::forget();

    $this->actingAs($owner);
    rawPut($this, "/api/books/{$encBook}/images/pic.png", 'plaintext-bytes')->assertStatus(422);
    rawPut($this, "/api/books/{$encBook}/images/pic.png", 'HLENC1'.str_repeat("\x00", 40))->assertOk();
    // row flipped to encrypted, serving now octet-stream
    expect((bool) DB::connection('pgsql_admin')->table('book_images')->where('book', $encBook)->value('encrypted'))->toBeTrue();

    // Plaintext book: HLENC1 body rejected
    $plainBook = uBook();
    $this->seedLibrary(['book' => $plainBook, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    seedImage($plainBook, encrypted: true);
    \App\Services\E2ee\EncryptedBookGuard::forget();
    rawPut($this, "/api/books/{$plainBook}/images/pic.png", 'HLENC1'.str_repeat("\x00", 40))->assertStatus(422);
    rawPut($this, "/api/books/{$plainBook}/images/pic.png", 'fresh-plaintext')->assertOk();
});

it('lists images under RLS (owner sees, stranger does not)', function () {
    $book = uBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    seedImage($book, 'a.png');
    seedImage($book, 'b.png');

    $this->actingAs($owner)
        ->getJson("/api/books/{$book}/images")
        ->assertOk()
        ->assertJsonPath('success', true)
        ->assertJsonCount(2, 'images');

    $stranger = $this->seedUser();
    $this->actingAs($stranger)
        ->getJson("/api/books/{$book}/images")
        ->assertOk()
        ->assertJsonCount(0, 'images');
});

afterEach(function () {
    foreach (DB::connection('pgsql_admin')->table('book_images')->where('book', 'like', 'upl_%')->pluck('book')->unique() as $b) {
        app(BookImageStore::class)->purgeBook($b);
    }
});
