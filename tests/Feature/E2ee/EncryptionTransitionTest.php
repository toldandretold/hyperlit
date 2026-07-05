<?php

use App\Models\PgLibrary;
use App\Services\BookImageStore;
use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * POST /api/db/library/{book}/encryption (docs/e2ee.md): the encrypt/publish
 * transitions and the invariants they must pin (forced private/unlisted/
 * slug-less, sub-book cascade, plainText/embedding scrub).
 */

beforeEach(function () {
    EncryptedBookGuard::forget();
});

/** Attribute payload for an owned library row (seed with $this->seedLibrary(...)). */
function ownedBookAttrs($user, string $book, array $attrs = []): array
{
    return array_merge([
        'book' => $book,
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'public',
        'listed' => true,
    ], $attrs);
}

it('requires auth and ownership', function () {
    $owner = $this->seedUser();
    $this->seedLibrary(ownedBookAttrs($owner, 'e2ee_own1'));

    $this->postJson('/api/db/library/e2ee_own1/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B'])
        ->assertStatus(401);

    $other = $this->seedUser();
    $this->actingAs($other);
    $this->postJson('/api/db/library/e2ee_own1/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B'])
        ->assertStatus(403);
});

it('encrypt forces private/unlisted/null-slug, cascades to sub-books, and scrubs plainText + embeddings', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_lock', ['slug' => 'my-public-slug']));
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_lock/Fn1', ['visibility' => 'public', 'type' => 'sub_book']));
    $this->seedNode(['book' => 'e2ee_lock', 'startLine' => 100, 'content' => '<p>hello</p>', 'plainText' => 'hello']);
    $this->seedNode(['book' => 'e2ee_lock/Fn1', 'startLine' => 100, 'content' => '<p>foot</p>', 'plainText' => 'foot']);

    // Plaintext RESIDUE the scrub must also remove: a temporal-history row
    // holding an old plaintext version, and conversion artifacts on disk.
    DB::connection('pgsql_admin')->table('nodes_history')->insert([
        'book' => 'e2ee_lock', 'chunk_id' => 0, 'startLine' => 100, 'history_id' => 999999901,
        'content' => '<p>old plaintext version</p>', 'plainText' => 'old plaintext version',
        'raw_json' => json_encode([]),
    ]);
    $artifactDir = resource_path('markdown/e2ee_lock');
    @mkdir($artifactDir, 0755, true);
    file_put_contents($artifactDir.'/main-text.md', 'plaintext source material');

    $response = $this->postJson('/api/db/library/e2ee_lock/encryption', [
        'encrypted' => true,
        'wrapped_dek' => 'hlenc.v1.DEKIV.DEKCT',
    ])->assertOk()->assertJsonPath('encrypted', true)->assertJsonPath('visibility', 'private');

    // Transition returns the full tree (root first) for the client's pull+re-push
    expect($response->json('tree'))->toContain('e2ee_lock')->toContain('e2ee_lock/Fn1')
        ->and($response->json('tree.0'))->toBe('e2ee_lock');

    // Residue gone: temporal history rows + on-disk conversion artifacts
    expect(DB::connection('pgsql_admin')->table('nodes_history')->where('book', 'e2ee_lock')->count())->toBe(0)
        ->and(is_dir($artifactDir))->toBeFalse();

    // Assert via the DEFAULT connection: the endpoint wrote inside this test's
    // uncommitted transaction — the admin connection would see stale rows (and
    // an admin WRITE would deadlock on the row lock; see the RLS test-harness
    // deadlock recipe).
    $parent = DB::table('library')->where('book', 'e2ee_lock')->first();
    expect($parent->encrypted)->toBeTrue()
        ->and($parent->visibility)->toBe('private')
        ->and($parent->listed)->toBeFalse()
        ->and($parent->slug)->toBeNull()
        ->and($parent->wrapped_dek)->toBe('hlenc.v1.DEKIV.DEKCT');

    $sub = DB::table('library')->where('book', 'e2ee_lock/Fn1')->first();
    expect($sub->encrypted)->toBeTrue()->and($sub->visibility)->toBe('private');

    expect(DB::table('nodes')->where('book', 'e2ee_lock')->value('plainText'))->toBeNull();
    expect(DB::table('nodes')->where('book', 'e2ee_lock/Fn1')->value('plainText'))->toBeNull();
});

it('publish defers clearing the wrapped DEK until finalize (no data-loss window)', function () {
    // Clearing the only copy of the DEK before the client confirms every
    // ciphertext (content + image bytes) is decrypted would make a failed
    // decrypt PERMANENT loss — so the flag flips off but the key survives until
    // the client re-POSTs finalize=true.
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_defer'));
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_defer/Fn1', ['type' => 'sub_book']));
    $this->postJson('/api/db/library/e2ee_defer/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.KEEP.ME'])
        ->assertOk();

    // Phase 1: flag off, DEK RETAINED (recoverable if the client decrypt fails)
    EncryptedBookGuard::forget();
    $this->postJson('/api/db/library/e2ee_defer/encryption', ['encrypted' => false])
        ->assertOk()->assertJsonPath('encrypted', false);
    expect(DB::table('library')->where('book', 'e2ee_defer')->value('encrypted'))->toBeFalse();
    expect(DB::table('library')->where('book', 'e2ee_defer')->value('wrapped_dek'))->toBe('hlenc.v1.KEEP.ME');

    // Phase 2: finalize → NOW the DEK is cleared on the whole tree
    EncryptedBookGuard::forget();
    $this->postJson('/api/db/library/e2ee_defer/encryption', ['encrypted' => false, 'finalize' => true])
        ->assertOk();
    expect(DB::table('library')->where('book', 'e2ee_defer')->value('wrapped_dek'))->toBeNull();
    expect(DB::table('library')->where('book', 'e2ee_defer/Fn1')->value('wrapped_dek'))->toBeNull();
});

it('rejects transitions addressed to a sub-book', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_subaddr'));
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_subaddr/Fn1', ['type' => 'sub_book']));

    $this->postJson('/api/db/library/e2ee_subaddr/Fn1/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B'])
        ->assertStatus(422);
});

it('while encrypted: set-slug 422s and a visibility write is pinned back to private', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_pinned'));
    $this->postJson('/api/db/library/e2ee_pinned/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B'])
        ->assertOk();

    $this->postJson('/api/db/library/set-slug', ['book' => 'e2ee_pinned', 'slug' => 'sneaky-slug'])
        ->assertStatus(422);

    // The PgLibrary saving hook pins the invariants even on a direct model write.
    // Default connection throughout — the row is locked by this test's transaction.
    EncryptedBookGuard::forget();
    $record = PgLibrary::where('book', 'e2ee_pinned')->first();
    $record->visibility = 'public';
    $record->listed = true;
    $record->slug = 'sneaky';
    $record->save();
    $fresh = DB::table('library')->where('book', 'e2ee_pinned')->first();
    expect($fresh->visibility)->toBe('private')
        ->and($fresh->listed)->toBeFalse()
        ->and($fresh->slug)->toBeNull();
});

it('publish clears the flags + wrapped DEK on the whole tree and plainText regenerates on the next save', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_pub'));
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_pub/Fn1', ['type' => 'sub_book']));
    $this->postJson('/api/db/library/e2ee_pub/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B'])
        ->assertOk();

    // finalize=true is the client's second phase (after the ciphertext is fully
    // decrypted) — it flips the flag AND clears the DEK in one call here.
    $this->postJson('/api/db/library/e2ee_pub/encryption', ['encrypted' => false, 'finalize' => true])
        ->assertOk()->assertJsonPath('encrypted', false);

    // Default-connection reads: the transition wrote inside this test's transaction.
    expect(DB::table('library')->where('book', 'e2ee_pub')->value('encrypted'))->toBeFalse();
    expect(DB::table('library')->where('book', 'e2ee_pub')->value('wrapped_dek'))->toBeNull();
    expect(DB::table('library')->where('book', 'e2ee_pub/Fn1')->value('encrypted'))->toBeFalse();

    // Next node write derives plainText again (PgNode hook no longer suppressed)
    EncryptedBookGuard::forget();
    $this->postJson('/api/db/nodes/targeted-upsert', [
        'data' => [[
            'book' => 'e2ee_pub', 'startLine' => 100, 'chunk_id' => 0,
            'node_id' => 'n_pub_1', 'content' => '<p>republished words</p>',
        ]],
    ])->assertOk();
    expect(DB::table('nodes')->where('book', 'e2ee_pub')->where('startLine', 100)->value('plainText'))
        ->toBe('republished words');
});

it('encrypt migrates an un-migrated book\'s legacy images into the store instead of destroying them', function () {
    // Correctness proof (docs/e2ee.md): the encrypt scrub deletes the legacy
    // image dirs; without migrate-on-encrypt this would delete the ONLY copies.
    $user = $this->seedUser();
    $this->actingAs($user);
    $book = 'e2ee_legimg';
    $this->seedLibrary(ownedBookAttrs($user, $book));

    // A legacy DOCX-style image on disk with NO book_images row + a node using it
    $legacy = resource_path("markdown/{$book}/media/pic.png");
    File::ensureDirectoryExists(dirname($legacy));
    File::put($legacy, base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'));
    $this->seedNode(['book' => $book, 'startLine' => 100, 'content' => '<p><img src="/'.$book.'/media/pic.png"></p>']);

    $this->postJson("/api/db/library/{$book}/encryption", ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B'])
        ->assertOk();

    // Image NOT lost: moved into the private store + registered as a row
    $store = app(BookImageStore::class);
    expect(File::exists($store->path($book, 'pic.png')))->toBeTrue();
    expect(DB::connection('pgsql_admin')->table('book_images')->where('book', $book)->count())->toBe(1);
    // Legacy dir gone (scrub ran, but the file survived the migration)
    expect(File::isDirectory(resource_path("markdown/{$book}")))->toBeFalse();

    $store->purgeBook($book);
});

it('encrypt is idempotent for resume: re-locking without a new wrapped_dek keeps the existing one', function () {
    // A big-tree lock that died partway leaves the book flagged encrypted; the
    // client re-runs Lock to FINISH it — reusing the existing DEK, sending none.
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_resume'));

    // Fresh encrypt sets the DEK
    $this->postJson('/api/db/library/e2ee_resume/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.ORIG.DEK'])
        ->assertOk();
    expect(DB::table('library')->where('book', 'e2ee_resume')->value('wrapped_dek'))->toBe('hlenc.v1.ORIG.DEK');

    // Resume: encrypt again with NO wrapped_dek → still OK, existing DEK preserved
    EncryptedBookGuard::forget();
    $this->postJson('/api/db/library/e2ee_resume/encryption', ['encrypted' => true])
        ->assertOk()
        ->assertJsonPath('encrypted', true);
    expect(DB::table('library')->where('book', 'e2ee_resume')->value('wrapped_dek'))->toBe('hlenc.v1.ORIG.DEK');
});

it('encrypt NEVER rotates a stored wrapped DEK — even mid-unfinished-publish with a new dek offered', function () {
    // The trap: book stuck mid-publish (flag off, DEK retained, image blobs
    // still ciphertext under DEK1). A re-lock that minted+stored DEK2 would
    // orphan that ciphertext PERMANENTLY. The server must keep DEK1.
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_norot'));

    $this->postJson('/api/db/library/e2ee_norot/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.DEK.ONE'])
        ->assertOk();

    // Unfinished publish: flag off, DEK retained
    EncryptedBookGuard::forget();
    $this->postJson('/api/db/library/e2ee_norot/encryption', ['encrypted' => false])->assertOk();
    expect(DB::table('library')->where('book', 'e2ee_norot')->value('wrapped_dek'))->toBe('hlenc.v1.DEK.ONE');

    // Re-lock offering a DIFFERENT dek → accepted, but DEK1 is kept
    EncryptedBookGuard::forget();
    $this->postJson('/api/db/library/e2ee_norot/encryption', ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.DEK.TWO'])
        ->assertOk();
    expect(DB::table('library')->where('book', 'e2ee_norot')->value('wrapped_dek'))->toBe('hlenc.v1.DEK.ONE');

    // Re-lock with NO dek while flag is off but DEK stored (resume) → also fine
    EncryptedBookGuard::forget();
    $this->postJson('/api/db/library/e2ee_norot/encryption', ['encrypted' => false])->assertOk();
    EncryptedBookGuard::forget();
    $this->postJson('/api/db/library/e2ee_norot/encryption', ['encrypted' => true])->assertOk();
    expect(DB::table('library')->where('book', 'e2ee_norot')->value('wrapped_dek'))->toBe('hlenc.v1.DEK.ONE');
});

it('encrypt requires a wrapped_dek', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_nodek'));

    $this->postJson('/api/db/library/e2ee_nodek/encryption', ['encrypted' => true])
        ->assertStatus(422);
});
