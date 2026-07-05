<?php

use App\Services\BookImageStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * The /{book}/media/{filename} serving route (docs/e2ee.md): RLS-gated via the
 * book_images row, 404 (never 403) when not visible, correct cache posture.
 * Uses real HTTP requests so SetDatabaseSessionContext sets the token exactly
 * as production does. Each test uses a UNIQUE book id (uniqueBook()) so a
 * committed admin-seeded row can never collide with another test.
 */

function uniqueBook(): string
{
    return 'serve_'.Str::lower(Str::random(10));
}

function putImageFile(string $book, string $filename = 'pic.png', string $bytes = null): void
{
    $path = app(BookImageStore::class)->path($book, $filename);
    File::ensureDirectoryExists(dirname($path));
    File::put($path, $bytes ?? base64_decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    ));
}

function seedServingRow(string $book, string $filename = 'pic.png', array $extra = []): void
{
    DB::connection('pgsql_admin')->table('book_images')->insert(array_merge([
        'id' => (string) Str::uuid(), 'book' => $book, 'filename' => $filename,
        'mime' => 'image/png', 'bytes' => 100, 'encrypted' => false,
        'created_at' => now(), 'updated_at' => now(),
    ], $extra));
}

it('serves a PUBLIC book image to anyone, cacheable (not no-store)', function () {
    $book = uniqueBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    seedServingRow($book);
    putImageFile($book);

    $resp = $this->get("/{$book}/media/pic.png")->assertOk()->assertHeader('Content-Type', 'image/png');
    $cache = $resp->headers->get('Cache-Control');
    expect($cache)->toContain('max-age=3600')->toContain('public')->not->toContain('no-store');
});

it('serves a PRIVATE book image to its owner (no-store, never public) but 404s a stranger', function () {
    $book = uniqueBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    seedServingRow($book);
    putImageFile($book);

    $resp = $this->actingAs($owner)->get("/{$book}/media/pic.png")->assertOk();
    $cache = $resp->headers->get('Cache-Control');
    expect($cache)->toContain('no-store')->not->toContain('public');

    $stranger = $this->seedUser();
    $this->actingAs($stranger)->get("/{$book}/media/pic.png")->assertNotFound();
    $this->get("/{$book}/media/pic.png")->assertNotFound(); // fully anonymous
});

it('404s when the row is absent even if a file exists (row is the source of truth)', function () {
    $book = uniqueBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    putImageFile($book); // file but NO row
    $this->get("/{$book}/media/pic.png")->assertNotFound();
});

it('TRANSITIONAL: serves an un-migrated DOCX image from the legacy media dir (no row)', function () {
    $book = uniqueBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    // Legacy file on disk, NO book_images row
    $legacy = resource_path("markdown/{$book}/media/pic.png");
    File::ensureDirectoryExists(dirname($legacy));
    File::put($legacy, base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'));

    $this->get("/{$book}/media/pic.png")->assertOk();
    File::deleteDirectory(resource_path("markdown/{$book}"));
});

it('TRANSITIONAL: serves an un-migrated EPUB image from the legacy public dir (no row)', function () {
    $book = uniqueBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $legacy = storage_path("app/public/books/{$book}/images/pic.png");
    File::ensureDirectoryExists(dirname($legacy));
    File::put($legacy, base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'));

    $this->get("/{$book}/media/pic.png")->assertOk();
    File::deleteDirectory(storage_path("app/public/books/{$book}"));
});

it('TRANSITIONAL: 404s a stranger on an un-migrated PRIVATE book (fallback still gated)', function () {
    $book = uniqueBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    $legacy = resource_path("markdown/{$book}/media/pic.png");
    File::ensureDirectoryExists(dirname($legacy));
    File::put($legacy, 'x');

    $stranger = $this->seedUser();
    $this->actingAs($stranger)->get("/{$book}/media/pic.png")->assertNotFound();
    // ...but the owner CAN see it via the fallback
    $this->actingAs($owner)->get("/{$book}/media/pic.png")->assertOk();
    File::deleteDirectory(resource_path("markdown/{$book}"));
});

it('streams an encrypted image as octet-stream', function () {
    $book = uniqueBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private', 'encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B']);
    seedServingRow($book, extra: ['encrypted' => true]);
    putImageFile($book, bytes: 'HLENC1'.str_repeat("\x00", 40));

    $this->actingAs($owner)->get("/{$book}/media/pic.png")
        ->assertOk()
        ->assertHeader('Content-Type', 'application/octet-stream');
});
