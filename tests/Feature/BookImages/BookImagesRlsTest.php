<?php

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * book_images RLS (docs/e2ee.md): image rows are visible/writable to exactly
 * whoever may see/edit the owning book — same policy shape as nodes. This puts
 * image access under the security model the old EPUB public-symlink bypassed.
 *
 * Rows are seeded via the BYPASSRLS admin connection; reads/writes are asserted
 * on the DEFAULT connection (RLS active), scoped by SetDatabaseSessionContext's
 * app.current_token — which actingAs() drives via the request. We assert RLS
 * directly by setting the token, mirroring how the app middleware does it.
 */

/** Unique per test so a committed admin-seeded row can never collide across runs. */
function imgBook(): string
{
    return 'imgrls_'.Str::lower(Str::random(10));
}

function seedImageRow(string $book, string $filename = 'pic.png', array $extra = []): void
{
    DB::connection('pgsql_admin')->table('book_images')->insert(array_merge([
        'id' => (string) Str::uuid(),
        'book' => $book,
        'filename' => $filename,
        'mime' => 'image/png',
        'bytes' => 1234,
        'width' => 100,
        'height' => 80,
        'encrypted' => false,
        'created_at' => now(),
        'updated_at' => now(),
    ], $extra));
}

/**
 * Set the RLS session context the way SetDatabaseSessionContext does: BOTH
 * app.current_user (username) and app.current_token. The owner-branch of the
 * policies joins `users` (whose own RLS needs current_user), so token-only is
 * insufficient for a logged-in owner.
 */
function actAsUser(\App\Models\User $user): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$user->user_token]);
}

/** Anonymous caller: no username, just a token (or none). */
function actAsAnon(?string $token): void
{
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$token ?? '']);
}

function visibleImageCount(string $book): int
{
    return DB::table('book_images')->where('book', $book)->count();
}

it('lets the owner see their private book image rows, but not a stranger', function () {
    $owner = $this->seedUser();
    $this->seedLibrary([
        'book' => $book = imgBook(), 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'private',
    ]);
    seedImageRow($book);

    actAsUser($owner);
    expect(visibleImageCount($book))->toBe(1);

    $stranger = $this->seedUser();
    actAsUser($stranger);
    expect(visibleImageCount($book))->toBe(0);

    // Anonymous (no token) also sees nothing for a private book
    actAsAnon(null);
    expect(visibleImageCount($book))->toBe(0);
});

it('lets anyone see image rows of a PUBLIC book', function () {
    $owner = $this->seedUser();
    $this->seedLibrary([
        'book' => $book = imgBook(), 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'public',
    ]);
    seedImageRow($book);

    $stranger = $this->seedUser();
    actAsUser($stranger);
    expect(visibleImageCount($book))->toBe(1);

    actAsAnon(null); // fully anonymous
    expect(visibleImageCount($book))->toBe(1);
});

it('lets an anonymous creator see their own (creator_token) book image rows', function () {
    $anonToken = (string) Str::uuid();
    $this->seedLibrary([
        'book' => $book = imgBook(), 'creator' => null, 'creator_token' => $anonToken,
        'visibility' => 'private',
    ]);
    seedImageRow($book);

    actAsAnon($anonToken);
    expect(visibleImageCount($book))->toBe(1);

    actAsAnon((string) Str::uuid()); // different anon token
    expect(visibleImageCount($book))->toBe(0);
});

it('lets the owner INSERT an image row for their own book (write policy WITH CHECK passes)', function () {
    // Note: the stranger-WRITE-rejection is asserted at the HTTP layer in
    // BookImageUploadTest (PR-2) — a raw RLS-rejected INSERT aborts the wrapping
    // RefreshDatabase transaction, which savepoints don't cleanly recover here.
    // The SELECT-visibility matrix above is the security-critical gate (it's what
    // the serving route relies on); this covers the write policy's positive path.
    $owner = $this->seedUser();
    $this->seedLibrary([
        'book' => $book = imgBook(), 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'public',
    ]);

    actAsUser($owner);
    DB::table('book_images')->insert([
        'id' => (string) Str::uuid(), 'book' => $book, 'filename' => 'ok.png',
        'mime' => 'image/png', 'bytes' => 1, 'encrypted' => false,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    expect(visibleImageCount($book))->toBe(1);
});
