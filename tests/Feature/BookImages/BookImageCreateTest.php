<?php

use App\Services\BookImageStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * POST /api/books/{book}/images: the editor image upload (drop / toolbar
 * insert — the "Phase III upload"). Raw body; the server mints the filename
 * and returns it with the canonical src. Owner-only, extension allowlist,
 * and the same HLENC1 magic guard as the PUT byte-swap: an encrypted book
 * only accepts ciphertext (with client-supplied dims), a plaintext book only
 * accepts non-magic bytes (dims measured server-side).
 */

function cBook(): string
{
    return 'imgc_'.Str::lower(Str::random(10));
}

/** A real 1x1 PNG so getimagesize can measure the plaintext upload. */
function onePxPng(): string
{
    return base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
}

function rawPost($test, string $url, string $body)
{
    return $test->call('POST', $url, [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $body);
}

function ownedImgAttrs($owner, string $book, array $attrs = []): array
{
    return array_merge([
        'book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'public',
    ], $attrs);
}

it('stores a plaintext upload: mints a filename, measures dims, writes file + row', function () {
    $owner = $this->seedUser();
    $book = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $book));

    $this->actingAs($owner);
    $response = rawPost($this, "/api/books/{$book}/images?name=My%20Photo.PNG", onePxPng())
        ->assertStatus(201)
        ->assertJsonPath('success', true)
        ->assertJsonPath('encrypted', false)
        ->assertJsonPath('width', 1)
        ->assertJsonPath('height', 1);

    $filename = $response->json('filename');
    // Matches the media route's filename regex; slugged from the original name
    expect($filename)->toMatch('/^[a-zA-Z0-9\-_.]+\.png$/')
        ->and($filename)->toContain('my-photo')
        ->and($response->json('src'))->toBe("/{$book}/media/{$filename}");

    expect(File::exists(app(BookImageStore::class)->path($book, $filename)))->toBeTrue();

    $row = DB::connection('pgsql_admin')->table('book_images')
        ->where('book', $book)->where('filename', $filename)->first();
    expect($row)->not->toBeNull()
        ->and((bool) $row->encrypted)->toBeFalse()
        ->and($row->mime)->toBe('image/png')
        ->and($row->width)->toBe(1)
        ->and($row->height)->toBe(1);
});

it('mints distinct filenames for repeat uploads of the same original name', function () {
    $owner = $this->seedUser();
    $book = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $book));
    $this->actingAs($owner);

    $a = rawPost($this, "/api/books/{$book}/images?name=pic.png", onePxPng())->assertStatus(201)->json('filename');
    $b = rawPost($this, "/api/books/{$book}/images?name=pic.png", onePxPng())->assertStatus(201)->json('filename');

    expect($a)->not->toBe($b)
        ->and(DB::connection('pgsql_admin')->table('book_images')->where('book', $book)->count())->toBe(2);
});

it('accepts an HLENC1 blob for an encrypted book with client-supplied dims', function () {
    $owner = $this->seedUser();
    $book = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $book, ['visibility' => 'private', 'encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B']));
    \App\Services\E2ee\EncryptedBookGuard::forget();

    $this->actingAs($owner);
    $response = rawPost($this, "/api/books/{$book}/images?name=secret.jpg&w=640&h=480", 'HLENC1'.str_repeat("\x00", 40))
        ->assertStatus(201)
        ->assertJsonPath('encrypted', true)
        ->assertJsonPath('width', 640)
        ->assertJsonPath('height', 480);

    $row = DB::connection('pgsql_admin')->table('book_images')
        ->where('book', $book)->where('filename', $response->json('filename'))->first();
    expect((bool) $row->encrypted)->toBeTrue()
        ->and($row->mime)->toBe('image/jpeg') // extension map — ciphertext can't be sniffed
        ->and($row->width)->toBe(640);
});

it('enforces the magic guard both directions', function () {
    $owner = $this->seedUser();

    $encBook = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $encBook, ['visibility' => 'private', 'encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B']));
    \App\Services\E2ee\EncryptedBookGuard::forget();
    $this->actingAs($owner);
    rawPost($this, "/api/books/{$encBook}/images?name=pic.png", onePxPng())->assertStatus(422);

    $plainBook = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $plainBook));
    \App\Services\E2ee\EncryptedBookGuard::forget();
    rawPost($this, "/api/books/{$plainBook}/images?name=pic.png", 'HLENC1'.str_repeat("\x00", 40))->assertStatus(422);
});

it('requires ownership (401 guest, 403 stranger on public, 404 stranger on private)', function () {
    $owner = $this->seedUser();
    $public = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $public));
    $private = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $private, ['visibility' => 'private']));

    rawPost($this, "/api/books/{$public}/images?name=pic.png", onePxPng())->assertStatus(401);

    $stranger = $this->seedUser();
    $this->actingAs($stranger);
    rawPost($this, "/api/books/{$public}/images?name=pic.png", onePxPng())->assertStatus(403);
    rawPost($this, "/api/books/{$private}/images?name=pic.png", onePxPng())->assertStatus(404);
});

it('rejects bad names and bodies', function () {
    $owner = $this->seedUser();
    $book = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $book));
    $this->actingAs($owner);

    rawPost($this, "/api/books/{$book}/images", onePxPng())->assertStatus(422);                     // no name
    rawPost($this, "/api/books/{$book}/images?name=evil.php", 'x')->assertStatus(422);              // bad extension
    rawPost($this, "/api/books/{$book}/images?name=noext", 'x')->assertStatus(422);                 // no extension
    rawPost($this, "/api/books/{$book}/images?name=pic.png", '')->assertStatus(422);                // empty body
    expect(DB::connection('pgsql_admin')->table('book_images')->where('book', $book)->count())->toBe(0);
});

it('stores an SVG with null dims', function () {
    $owner = $this->seedUser();
    $book = cBook();
    $this->seedLibrary(ownedImgAttrs($owner, $book));
    $this->actingAs($owner);

    $svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    $response = rawPost($this, "/api/books/{$book}/images?name=diagram.svg", $svg)
        ->assertStatus(201)
        ->assertJsonPath('width', null)
        ->assertJsonPath('height', null);

    $row = DB::connection('pgsql_admin')->table('book_images')
        ->where('book', $book)->where('filename', $response->json('filename'))->first();
    expect($row->mime)->toBe('image/svg+xml');
});

afterEach(function () {
    foreach (DB::connection('pgsql_admin')->table('book_images')->where('book', 'like', 'imgc_%')->pluck('book')->unique() as $b) {
        app(BookImageStore::class)->purgeBook($b);
    }
});
