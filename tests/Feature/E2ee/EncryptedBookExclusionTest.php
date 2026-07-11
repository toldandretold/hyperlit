<?php

use App\Jobs\GenerateNodeEmbedding;
use App\Services\E2ee\EncryptedBookGuard;
use App\Services\SearchService;
use App\Services\Security\NodeHtmlSanitizer;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;

/**
 * Server-side E2EE exclusions (docs/e2ee.md): encrypted books never reach
 * search / embeddings / plainText, plaintext writes to them are 422'd, and —
 * the opt-in boundary — plain private books keep behaving exactly as before.
 */

beforeEach(function () {
    EncryptedBookGuard::forget();
});

/** Attribute payload for an encrypted library row (seed with $this->seedLibrary(...)). */
function encryptedBookAttrs($user, string $book): array
{
    return [
        'book' => $book,
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'private',
        'listed' => false,
        'encrypted' => true,
        'wrapped_dek' => 'hlenc.v1.DEK.CT',
    ];
}

it('rejects plaintext node writes to an encrypted book (422) but accepts envelopes', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(encryptedBookAttrs($user, 'e2ee_guard'));

    // node_id is GLOBALLY unique in the nodes table — book-prefix it so
    // residue from any other test's committed seeds can never collide.
    $node = [
        'book' => 'e2ee_guard', 'startLine' => 100, 'chunk_id' => 0, 'node_id' => 'e2ee_guard_n1',
    ];

    // Plaintext content → rejected before anything is written.
    // (App writes happen inside this test's transaction — assert on the
    // DEFAULT connection; the admin connection would see stale rows.)
    $this->postJson('/api/db/nodes/targeted-upsert', [
        'data' => [array_merge($node, ['content' => '<p>secret leaking</p>'])],
    ])->assertStatus(422);
    expect(DB::table('nodes')->where('book', 'e2ee_guard')->count())->toBe(0);

    // Ciphertext content → accepted, and plainText stays NULL
    $this->postJson('/api/db/nodes/targeted-upsert', [
        'data' => [array_merge($node, ['content' => 'hlenc.v1.aXY.Y3Q'])],
    ])->assertOk();
    $row = DB::table('nodes')->where('book', 'e2ee_guard')->first();
    expect($row->content)->toBe('hlenc.v1.aXY.Y3Q')
        ->and($row->plainText)->toBeNull();
});

it('rejects plaintext annotation/footnote/reference/library writes to an encrypted book', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(encryptedBookAttrs($user, 'e2ee_guard2'));

    $this->postJson('/api/db/hyperlights/upsert', ['data' => [[
        'book' => 'e2ee_guard2', 'hyperlight_id' => 'hl1', 'node_id' => ['n1'], 'charData' => new stdClass(),
        'annotation' => 'plaintext note',
    ]]])->assertStatus(422);

    $this->postJson('/api/db/footnotes/upsert', ['book' => 'e2ee_guard2', 'data' => [[
        'footnoteId' => 'fn1', 'content' => '<p>plaintext footnote</p>',
    ]]])->assertStatus(422);

    $this->postJson('/api/db/references/upsert', ['book' => 'e2ee_guard2', 'data' => [[
        'referenceId' => 'r1', 'content' => 'plaintext ref',
    ]]])->assertStatus(422);

    $this->postJson('/api/db/library/upsert', ['data' => [
        'book' => 'e2ee_guard2', 'title' => 'plaintext title',
    ]])->assertStatus(422);
});

it('never dispatches embedding jobs for encrypted-book node writes', function () {
    Queue::fake();
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(encryptedBookAttrs($user, 'e2ee_noembed'));

    $this->postJson('/api/db/nodes/targeted-upsert', ['data' => [[
        'book' => 'e2ee_noembed', 'startLine' => 100, 'chunk_id' => 0, 'node_id' => 'e2ee_noembed_n1',
        'content' => 'hlenc.v1.aXY.'.str_repeat('Y3Q', 30),
    ]]])->assertOk();

    Queue::assertNotPushed(GenerateNodeEmbedding::class);
});

it('excludes encrypted books from search while a plain private book keeps its existing behavior', function () {
    $user = $this->seedUser();
    $this->seedLibrary(encryptedBookAttrs($user, 'e2ee_search'));
    // Encrypted books are forced private/unlisted — the locked privacy contract
    // in SearchService (never return private books) excludes them everywhere.
    $encrypted = DB::connection('pgsql_admin')->table('library')->where('book', 'e2ee_search')->first();
    expect($encrypted->visibility)->toBe('private')->and($encrypted->listed)->toBeFalse();

    // Opt-in boundary regression: an ordinary PRIVATE book is untouched by E2EE —
    // flag off, plainText still derived on write (server-searchable content intact).
    $this->seedLibrary([
        'book' => 'plain_private', 'creator' => $user->name, 'creator_token' => $user->user_token,
        'visibility' => 'private',
    ]);
    $this->actingAs($user);
    $this->postJson('/api/db/nodes/targeted-upsert', ['data' => [[
        'book' => 'plain_private', 'startLine' => 100, 'chunk_id' => 0, 'node_id' => 'plain_private_np1',
        'content' => '<p>findable words</p>',
    ]]])->assertOk();
    $row = DB::table('nodes')->where('book', 'plain_private')->first();
    expect($row->plainText)->toBe('findable words');
});

it('the book-data read endpoint round-trips encrypted + wrapped_dek so the client keeps the flag', function () {
    // Regression: getLibrary hand-builds its response and once OMITTED these
    // columns — a pull then reset the client registry to "not encrypted", so
    // the next push sent plaintext into an encrypted row and 422'd. The flag
    // and the DEK blob MUST survive the load round-trip.
    $user = $this->seedUser();
    $this->seedLibrary([
        'book' => 'e2ee_roundtrip',
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'private',
        'listed' => false,
        'encrypted' => true,
        'wrapped_dek' => 'hlenc.v1.DEKIV.DEKCIPHERTEXT',
    ]);
    $this->seedNode(['book' => 'e2ee_roundtrip', 'startLine' => 100, 'content' => 'hlenc.v1.aXY.Y3Q']);

    $this->actingAs($user);
    $this->getJson('/api/database-to-indexeddb/books/e2ee_roundtrip/data')
        ->assertOk()
        ->assertJsonPath('library.encrypted', true)
        ->assertJsonPath('library.wrapped_dek', 'hlenc.v1.DEKIV.DEKCIPHERTEXT');

    // A plain book reports encrypted=false (never null/absent → client treats absent as false anyway,
    // but pin the explicit shape).
    $this->seedLibrary([
        'book' => 'e2ee_plain_rt', 'creator' => $user->name, 'creator_token' => $user->user_token,
        'visibility' => 'private',
    ]);
    $this->seedNode(['book' => 'e2ee_plain_rt', 'startLine' => 100, 'content' => '<p>plain</p>']);
    $this->getJson('/api/database-to-indexeddb/books/e2ee_plain_rt/data')
        ->assertOk()
        ->assertJsonPath('library.encrypted', false)
        ->assertJsonPath('library.wrapped_dek', null);
});

it('NodeHtmlSanitizer passes envelopes through unchanged (characterization)', function () {
    $envelope = 'hlenc.v1.'.str_repeat('aB3-_', 4).'.'.str_repeat('Zz9_-', 40);
    expect(NodeHtmlSanitizer::clean($envelope))->toBe($envelope);
});

it('sub-book creation inherits the parent encryption and rejects plaintext previews', function () {
    $user = $this->seedUser();
    $this->actingAs($user);
    $this->seedLibrary(encryptedBookAttrs($user, 'e2ee_parent'));
    $this->seedHyperlight([
        'book' => 'e2ee_parent', 'hyperlight_id' => 'HL_1', 'node_id' => ['n1'], 'charData' => [],
        'creator' => $user->name,
        'annotation' => 'hlenc.v1.aXY.Y3Q', 'highlightedText' => 'hlenc.v1.aXY.Y3Q', 'highlightedHTML' => 'hlenc.v1.aXY.Y3Q',
    ]);

    $this->postJson('/api/db/sub-books/create', [
        'type' => 'hyperlight', 'parentBook' => 'e2ee_parent', 'itemId' => 'HL_1',
        'previewContent' => '<p>plaintext preview</p>',
    ])->assertStatus(422);

    $this->postJson('/api/db/sub-books/create', [
        'type' => 'hyperlight', 'parentBook' => 'e2ee_parent', 'itemId' => 'HL_1',
        'previewContent' => 'hlenc.v1.aXY.Y3Q',
    ])->assertOk();

    $sub = DB::table('library')->where('book', 'e2ee_parent/HL_1')->first();
    expect($sub)->not->toBeNull()
        ->and($sub->encrypted)->toBeTrue();
});
