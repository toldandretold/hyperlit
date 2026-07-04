<?php

use App\Models\PgLibrary;
use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;

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

    $this->postJson('/api/db/library/e2ee_pub/encryption', ['encrypted' => false])
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

it('encrypt requires a wrapped_dek', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(ownedBookAttrs($user, 'e2ee_nodek'));

    $this->postJson('/api/db/library/e2ee_nodek/encryption', ['encrypted' => true])
        ->assertStatus(422);
});
