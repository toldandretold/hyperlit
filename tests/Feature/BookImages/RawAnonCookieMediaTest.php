<?php

use App\Services\BookImageStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * The anon_token cookie exists in TWO transport forms (App\Support\AnonToken):
 * ENCRYPTED when minted through Sanctum's stateful stack (hyperlit.test /
 * hyperlit.io), RAW when minted on any other host (LAN-IP phone dev — the api
 * group has no EncryptCookies). Web routes decrypt-or-null inbound, which
 * silently stripped raw cookies and 404'd every private-book image on iPhone
 * (2026-09). These tests pin BOTH forms serving media for an anon creator.
 */

function rawAnonBook(): array
{
    $book = 'rawanon_'.Str::lower(Str::random(8));
    $token = (string) Str::uuid();

    return [$book, $token];
}

/** Library attrs for an anon-creator private book (seed with $this->seedLibrary). */
function anonBookAttrs(string $book, string $token): array
{
    return [
        'book' => $book, 'creator' => null, 'creator_token' => $token,
        'visibility' => 'private',
    ];
}

function seedAnonImage(string $book): void
{
    $store = app(BookImageStore::class);
    $path = $store->path($book, 'pic.png');
    File::ensureDirectoryExists(dirname($path));
    File::put($path, base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='));
    DB::connection('pgsql_admin')->table('book_images')->insert([
        'id' => (string) Str::uuid(), 'book' => $book, 'filename' => 'pic.png',
        'mime' => 'image/png', 'bytes' => 70, 'width' => 1, 'height' => 1,
        'encrypted' => false, 'created_at' => now(), 'updated_at' => now(),
    ]);
}

it('serves media to the anon creator with an ENCRYPTED cookie (stateful hosts)', function () {
    [$book, $token] = rawAnonBook();
    $this->seedLibrary(anonBookAttrs($book, $token));
    seedAnonImage($book);

    $this->withCookie('anon_token', $token) // test cookies are encrypted by default
        ->get("/{$book}/media/pic.png")
        ->assertOk()
        ->assertHeader('Content-Type', 'image/png');
});

it('serves media to the anon creator with a RAW cookie (non-stateful hosts, the iPhone bug)', function () {
    [$book, $token] = rawAnonBook();
    $this->seedLibrary(anonBookAttrs($book, $token));
    seedAnonImage($book);

    // Simulate the phone: EncryptCookies nulls the unencrypted request cookie,
    // and the raw transport value is only reachable via the PHP superglobal.
    $_COOKIE['anon_token'] = $token;
    try {
        $this->withUnencryptedCookie('anon_token', $token)
            ->get("/{$book}/media/pic.png")
            ->assertOk()
            ->assertHeader('Content-Type', 'image/png');
    } finally {
        unset($_COOKIE['anon_token']);
    }
});

it('still 404s a stranger and rejects a non-UUID raw cookie', function () {
    [$book, $token] = rawAnonBook();
    $this->seedLibrary(anonBookAttrs($book, $token));
    seedAnonImage($book);

    // No cookie at all → 404 (no existence leak)
    $this->get("/{$book}/media/pic.png")->assertNotFound();

    // A raw value that isn't UUID-shaped (e.g. an encrypted blob or garbage)
    // must NOT be accepted by the fallback.
    $_COOKIE['anon_token'] = 'not-a-uuid-just-garbage-value-here!!';
    try {
        $this->withUnencryptedCookie('anon_token', 'not-a-uuid-just-garbage-value-here!!')
            ->get("/{$book}/media/pic.png")
            ->assertNotFound();
    } finally {
        unset($_COOKIE['anon_token']);
    }

    // The WRONG (other user's) raw UUID must not grant access either.
    $otherToken = (string) Str::uuid();
    $_COOKIE['anon_token'] = $otherToken;
    try {
        $this->withUnencryptedCookie('anon_token', $otherToken)
            ->get("/{$book}/media/pic.png")
            ->assertNotFound();
    } finally {
        unset($_COOKIE['anon_token']);
    }
});

afterEach(function () {
    foreach (DB::connection('pgsql_admin')->table('book_images')->where('book', 'like', 'rawanon_%')->pluck('book')->unique() as $b) {
        app(BookImageStore::class)->purgeBook($b);
    }
});
