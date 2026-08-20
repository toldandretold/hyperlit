<?php

/**
 * Per-highlight privacy: the /api/db/sub-books/visibility endpoint
 * (SubBookController::setVisibility) and the invariants around it.
 *
 * The invariants pinned here:
 *  - Only the HIGHLIGHT's creator (named or anon-token) may flip its annotation
 *    sub-book's visibility — not strangers, not even the parent book's owner.
 *  - The flip creates the sub-book library row when absent (metadata-only, no
 *    node insertion) and updates it in place when present (no duplicates).
 *  - A registrar-minted row owned by someone else is re-owned to the highlight
 *    creator on flip (the read paths key privacy off this row's creator).
 *  - Read-path integration: the bulk pull reports sub_book_visibility, hides a
 *    private-sub-book highlight from others, and still serves it to the creator.
 *  - Clobber regression: a later annotation save (POST /db/sub-books/create)
 *    must NOT reset a private choice back to public.
 *  - Sticky default: an upsert CREATE carrying sub_book_visibility='private'
 *    births the sub-book row private; a later sync UPDATE echoing a stale value
 *    never touches visibility.
 *  - RLS backstop: with the tightened hyperlights_select_policy, a stranger's
 *    raw select under the app connection excludes the private-sub-book row
 *    (this is the assertion that catches a mis-owned SECURITY DEFINER helper).
 *
 * Seeds via pgsql_admin, beforeEach-only admin cleanup — an afterEach admin
 * delete deadlocks against the still-open RefreshDatabase transaction whenever
 * a controller-under-test (sub-books/create, hyperlights/upsert) touched the
 * same library rows through the DEFAULT connection (docs/journal-harvest.md
 * documents the same recipe). Assertions on rows written through the default
 * connection read back through the default connection (the app transaction's
 * writes are invisible to pgsql_admin until rollback); admin-committed rows
 * are asserted via pgsql_admin.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class);

function subVisCleanup(): void
{
    $admin = DB::connection('pgsql_admin');
    $admin->table('hyperlights')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('nodes')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('library')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('users')->where('email', 'like', 'api\_%@test.local')->delete();
}

beforeEach(fn () => subVisCleanup());

afterEach(function () {
    // Only session-var hygiene here — NO admin deletes (see header). The residue of
    // the file's last test is swept by the next run's beforeEach.
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");
});

/** Read a library row's visibility through the DEFAULT connection under $user's RLS context. */
function libVisibilityAs($user, string $book): ?string
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$user->user_token]);

    return DB::table('library')->where('book', $book)->value('visibility');
}

/**
 * Seed a public book (owned by $bookOwner) with one node and one highlight
 * created by $creator (User for named, string token for anon). Returns
 * [$book, $subBookId].
 */
function seedVisibilityFixture($test, $bookOwner, $creator, string $annotation = 'my note'): array
{
    $fn = Closure::bind(function ($bookOwner, $creator, $annotation) {
        $book = 'apitest_' . Str::random(12);
        $nodeId = "{$book}_n1";
        $this->makeBook($bookOwner, ['book' => $book, 'visibility' => 'public']);
        $this->seedNode([
            'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
            'content' => '<p>hello visibility world</p>', 'plainText' => 'hello visibility world', 'type' => 'p',
        ]);
        $this->seedHyperlight([
            'book' => $book, 'hyperlight_id' => 'HL_vis1', 'node_id' => [$nodeId],
            'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 5]],
            'annotation' => $annotation, 'hidden' => false,
            'creator' => $creator instanceof \App\Models\User ? $creator->name : null,
            'creator_token' => is_string($creator) ? $creator : null,
            'sub_book_id' => "{$book}/HL_vis1",
        ]);

        return [$book, "{$book}/HL_vis1"];
    }, $test, get_class($test));

    return $fn($bookOwner, $creator, $annotation);
}

/* ─── authorization + write semantics ────────────────────────────────────── */

test('creator flips own highlight private — row created private, no nodes inserted', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book, $subBookId] = seedVisibilityFixture($this, $owner, $creator);

    $this->actingAs($creator);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(200)->assertJson(['success' => true, 'subBookId' => $subBookId, 'visibility' => 'private']);

    $row = DB::connection('pgsql_admin')->table('library')->where('book', $subBookId)->first();
    expect($row)->not->toBeNull()
        ->and($row->visibility)->toBe('private')
        ->and($row->type)->toBe('sub_book')
        ->and($row->creator)->toBe($creator->name);
    // Metadata-only: the flip must not fabricate annotation nodes.
    expect(DB::connection('pgsql_admin')->table('nodes')->where('book', $subBookId)->count())->toBe(0);
});

test('flip back to public updates the same row (no duplicate)', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book, $subBookId] = seedVisibilityFixture($this, $owner, $creator);

    $this->actingAs($creator);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(200);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'public',
    ])->assertStatus(200);

    $rows = DB::connection('pgsql_admin')->table('library')->where('book', $subBookId)->get();
    expect($rows)->toHaveCount(1)
        ->and($rows[0]->visibility)->toBe('public');
});

test('anonymous creator can flip their own highlight via anon_token', function () {
    $owner = $this->apiUser();
    ['token' => $token] = $this->anonSession();
    [$book, $subBookId] = seedVisibilityFixture($this, $owner, $token);

    // JSON requests strip the cookie jar unless withCredentials() is set
    // (prepareCookiesForJsonRequest returns [] otherwise) — same ceremony as
    // HyperciteGateParityTest's anon assertions.
    $this->withCredentials()->withUnencryptedCookie('anon_token', $token)
        ->postJson('/api/db/sub-books/visibility', [
            'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
        ])->assertStatus(200);

    $row = DB::connection('pgsql_admin')->table('library')->where('book', $subBookId)->first();
    expect($row->visibility)->toBe('private')
        ->and($row->creator_token)->toBe($token);
});

test('a stranger cannot flip someone else\'s highlight', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book] = seedVisibilityFixture($this, $owner, $creator);

    $this->actingAs($this->apiUser());
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(403);
});

test('the book owner (not the highlight creator) cannot flip it', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book] = seedVisibilityFixture($this, $owner, $creator);

    $this->actingAs($owner);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(403);
});

test('a not-yet-synced highlight can still be flipped (grace), footnote-shaped itemId a 422', function () {
    // "Flip private right after highlighting": the hyperlight row hasn't reached
    // Postgres yet (debounced sync). Same grace as SubBookController::create —
    // the caller is authenticated and a brand-new highlight's creator IS the
    // caller, so the flip proceeds and the sub-book row is claimed for them.
    $creator = $this->apiUser();
    $this->actingAs($creator);
    $book = $this->makeBook($creator, ['visibility' => 'public']);

    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_notsynced1', 'visibility' => 'private',
    ])->assertStatus(200);
    $row = DB::connection('pgsql_admin')->table('library')->where('book', "{$book}/HL_notsynced1")->first();
    expect($row->visibility)->toBe('private')
        ->and($row->creator)->toBe($creator->name);

    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'Fn1', 'visibility' => 'private',
    ])->assertStatus(422);
});

test('the grace path cannot claim an existing sub-book row owned by someone else', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    $attacker = $this->apiUser();
    [$book, $subBookId] = seedVisibilityFixture($this, $owner, $creator);
    // Delete the hyperlight row so the endpoint takes the missing-row grace path,
    // with a library row that belongs to $creator already in place.
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => $subBookId, 'creator' => $creator->name, 'visibility' => 'public',
        'type' => 'sub_book', 'listed' => false, 'title' => 'Annotation: HL_vis1',
        'raw_json' => '[]', 'created_at' => now(), 'updated_at' => now(),
    ]);
    DB::connection('pgsql_admin')->table('hyperlights')
        ->where('book', $book)->where('hyperlight_id', 'HL_vis1')->delete();

    $this->actingAs($attacker);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(403);

    $row = DB::connection('pgsql_admin')->table('library')->where('book', $subBookId)->first();
    expect($row->visibility)->toBe('public')
        ->and($row->creator)->toBe($creator->name);
});

test('a registrar-minted row owned by someone else is re-owned to the highlight creator on flip', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book, $subBookId] = seedVisibilityFixture($this, $owner, $creator);
    // Simulate SubBookRegistrar having minted the row with the FOUNDATION owner as creator.
    $this->seedLibrary([
        'book' => $subBookId, 'creator' => $owner->name, 'visibility' => 'public',
        'type' => 'sub_book', 'listed' => false,
    ]);

    $this->actingAs($creator);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(200);

    $row = DB::connection('pgsql_admin')->table('library')->where('book', $subBookId)->first();
    expect($row->visibility)->toBe('private')
        ->and($row->creator)->toBe($creator->name);
});

test('a NESTED highlight (highlight-in-a-highlight) flips via the level-2 sub-book id', function () {
    // The parent "book" is itself an annotation sub-book (book_x/HL_parent); the
    // nested highlight's sub-book id takes the level-2 shape
    // foundation/2/HL_parent/HL_child (SubBookIdHelper mirrors the client).
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    $foundation = 'apitest_' . Str::random(12);
    $parentSubBook = "{$foundation}/HL_parenthl";
    $this->makeBook($owner, ['book' => $foundation, 'visibility' => 'public']);
    $this->makeBook($creator, ['book' => $parentSubBook, 'visibility' => 'public', 'type' => 'sub_book']);
    $nodeId = "{$parentSubBook}_n1";
    $this->seedNode([
        'book' => $parentSubBook, 'startLine' => 1, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>annotation body text</p>', 'plainText' => 'annotation body text', 'type' => 'p',
    ]);
    $nestedSubBookId = "{$foundation}/2/HL_parenthl/HL_nested1";
    $this->seedHyperlight([
        'book' => $parentSubBook, 'hyperlight_id' => 'HL_nested1', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 5]],
        'annotation' => 'nested note', 'hidden' => false,
        'creator' => $creator->name, 'sub_book_id' => $nestedSubBookId,
    ]);

    $this->actingAs($creator);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $parentSubBook, 'itemId' => 'HL_nested1', 'visibility' => 'private',
    ])->assertStatus(200)->assertJson(['subBookId' => $nestedSubBookId]);

    $row = DB::connection('pgsql_admin')->table('library')->where('book', $nestedSubBookId)->first();
    expect($row)->not->toBeNull()
        ->and($row->visibility)->toBe('private');

    // The sub-book's annotation pull hides the nested highlight from guests.
    $this->app['auth']->forgetGuards();
    $gate = 'gate=' . urlencode(json_encode(['mode' => 'all']));
    $rows = $this->getJson('/api/database-to-indexeddb/books/' . urlencode($parentSubBook) . "/annotations?{$gate}")
        ->assertStatus(200)->json('hyperlights') ?? [];
    expect(array_column($rows, 'hyperlight_id'))->not->toContain('HL_nested1');
});

/* ─── read-path integration ──────────────────────────────────────────────── */

test('bulk pull reports sub_book_visibility and the creator keeps a privatized highlight', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book] = seedVisibilityFixture($this, $owner, $creator);
    $gate = 'gate=' . urlencode(json_encode(['mode' => 'all']));

    // Guest baseline: served, flagged 'public'.
    $rows = $this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?{$gate}")
        ->assertStatus(200)->json('hyperlights') ?? [];
    $baseline = collect($rows)->firstWhere('hyperlight_id', 'HL_vis1');
    expect($baseline)->not->toBeNull()
        ->and($baseline['sub_book_visibility'])->toBe('public');

    // Creator flips private, then still receives it, flagged 'private'.
    $this->actingAs($creator);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(200);

    $rows = $this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?{$gate}")
        ->assertStatus(200)->json('hyperlights') ?? [];
    $mine = collect($rows)->firstWhere('hyperlight_id', 'HL_vis1');
    expect($mine)->not->toBeNull()
        ->and($mine['sub_book_visibility'])->toBe('private');
    $this->getJson("/api/db/hyperlights/find/{$book}/HL_vis1")->assertStatus(200)
        ->assertJsonPath('hyperlight.sub_book_visibility', 'private');
});

test('a guest\'s bulk pull omits a private-sub-book highlight (and find 404s)', function () {
    // Seeded directly (not via the endpoint) so the whole test runs as a guest —
    // actingAs() cannot be reverted mid-test.
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book, $subBookId] = seedVisibilityFixture($this, $owner, $creator);
    $this->seedLibrary([
        'book' => $subBookId, 'creator' => $creator->name, 'visibility' => 'private',
        'type' => 'sub_book', 'listed' => false,
    ]);

    $gate = 'gate=' . urlencode(json_encode(['mode' => 'all']));
    $rows = $this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?{$gate}")
        ->assertStatus(200)->json('hyperlights') ?? [];
    expect(array_column($rows, 'hyperlight_id'))->not->toContain('HL_vis1');
    $this->getJson("/api/db/hyperlights/find/{$book}/HL_vis1")->assertStatus(404);
});

test('round trip: flip private hides from guests, flip BACK to public restores them', function () {
    // The creator is ANONYMOUS (cookie-scoped auth) so the same test can act as
    // both creator (cookie attached) and guest (cookie withheld) — actingAs()
    // cannot be reverted mid-test, but cookie state can.
    $owner = $this->apiUser();
    ['token' => $token] = $this->anonSession();
    [$book] = seedVisibilityFixture($this, $owner, $token);

    $gate = 'gate=' . urlencode(json_encode(['mode' => 'all']));
    $guestIds = fn () => array_column(
        $this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?{$gate}")
            ->assertStatus(200)->json('hyperlights') ?? [],
        'hyperlight_id'
    );
    $flip = function (string $visibility) use ($book, $token) {
        $this->withCredentials()->withUnencryptedCookie('anon_token', $token)
            ->postJson('/api/db/sub-books/visibility', [
                'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => $visibility,
            ])->assertStatus(200);
        // withCredentials()/withUnencryptedCookie() PERSIST on the TestCase across
        // requests — reset both so the next read is a genuine guest again.
        $this->withCredentials = false;
        $this->unencryptedCookies = [];
    };

    expect($guestIds())->toContain('HL_vis1');       // baseline: public → guests see it

    // NB: read through the DEFAULT connection — the endpoint's SECURITY DEFINER
    // bump executes inside this test's app transaction, invisible to pgsql_admin
    // until commit. The book is public, so RLS permits the read.
    $tsBefore = (int) DB::table('library')->where('book', $book)->value('annotations_updated_at');

    $flip('private');
    expect($guestIds())->not->toContain('HL_vis1');  // private → hidden from guests

    $flip('public');
    expect($guestIds())->toContain('HL_vis1');       // back to public → RESTORED for guests
    $this->getJson("/api/db/hyperlights/find/{$book}/HL_vis1")->assertStatus(200)
        ->assertJsonPath('hyperlight.sub_book_visibility', 'public');

    // Each flip must bump the PARENT book's annotations_updated_at so cached
    // clients re-sync and actually see the highlight (dis)appear.
    $tsAfter = (int) DB::table('library')->where('book', $book)->value('annotations_updated_at');
    expect($tsAfter)->toBeGreaterThan($tsBefore);
});

test('an annotation-less public highlight is hidden from guests by the DEFAULT gate, not by privacy', function () {
    // Pins the manual-QA trap: "made it public again but guests still can't see it"
    // — when the highlight has no annotation text, the default hyperlight gate
    // (hideNoAnnotation:true for strangers) hides it REGARDLESS of visibility.
    // gate=all proves the privacy layer itself is serving it.
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book] = seedVisibilityFixture($this, $owner, $creator, '');

    // Guest under the DEFAULT gate (no gate param): hidden — that's the gate.
    $rows = $this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights') ?? [];
    expect(array_column($rows, 'hyperlight_id'))->not->toContain('HL_vis1');

    // Same guest with the gate off: served, and privacy reports 'public'.
    $gate = 'gate=' . urlencode(json_encode(['mode' => 'all']));
    $rows = $this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?{$gate}")
        ->assertStatus(200)->json('hyperlights') ?? [];
    $row = collect($rows)->firstWhere('hyperlight_id', 'HL_vis1');
    expect($row)->not->toBeNull()
        ->and($row['sub_book_visibility'])->toBe('public');
});

/* ─── clobber + sticky-default seams ─────────────────────────────────────── */

test('a later annotation save (sub-books/create) does not reset a private choice', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    [$book, $subBookId] = seedVisibilityFixture($this, $owner, $creator);

    $this->actingAs($creator);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(200);

    $this->postJson('/api/db/sub-books/create', [
        'type' => 'hyperlight', 'parentBook' => $book, 'itemId' => 'HL_vis1',
        'previewContent' => 'my annotation text',
    ])->assertStatus(200);

    // sub-books/create wrote through the DEFAULT connection (inside the test's
    // RefreshDatabase transaction), so read back through it — pgsql_admin still
    // sees the pre-update committed version either way.
    expect(libVisibilityAs($creator, $subBookId))->toBe('private');
});

test('upsert CREATE honors the sticky default; a later sync UPDATE never touches visibility', function () {
    $creator = $this->apiUser();
    $this->actingAs($creator);
    $book = $this->makeBook($creator, ['visibility' => 'public']);
    $subBookId = "{$book}/HL_sticky1";

    $item = [
        'book' => $book, 'hyperlight_id' => 'HL_sticky1', 'node_id' => ["{$book}_n1"],
        'charData' => ["{$book}_n1" => ['charStart' => 0, 'charEnd' => 3]],
        'annotation' => '', 'highlightedText' => 'abc', 'highlightedHTML' => 'abc',
        'sub_book_visibility' => 'private',
    ];
    $this->postJson('/api/db/hyperlights/upsert', ['data' => [$item]])->assertStatus(200);

    // upsert's firstOrCreate ran on the DEFAULT connection — assert through it.
    expect(libVisibilityAs($creator, $subBookId))->toBe('private');

    // Simulate a flip made elsewhere (same connection — the row is transaction-local),
    // then re-sync the stale 'private' echo: the UPDATE path must not clobber it.
    DB::table('library')->where('book', $subBookId)->update(['visibility' => 'public']);
    $this->postJson('/api/db/hyperlights/upsert', ['data' => [$item]])->assertStatus(200);

    expect(libVisibilityAs($creator, $subBookId))->toBe('public');
});

/* ─── RLS backstop (tightened hyperlights_select_policy) ─────────────────── */

test('RLS: a stranger\'s raw select excludes the private-sub-book row, the creator\'s includes it', function () {
    $owner = $this->apiUser();
    $creator = $this->apiUser();
    $stranger = $this->apiUser();
    [$book, $subBookId] = seedVisibilityFixture($this, $owner, $creator);
    $this->actingAs($creator);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_vis1', 'visibility' => 'private',
    ])->assertStatus(200);

    // Stranger context on the DEFAULT (RLS-enforced) connection: the parent book is
    // public, but the tightened policy's private-sub-book guard must exclude the row.
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$stranger->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$stranger->user_token]);
    $ids = DB::table('hyperlights')->where('book', $book)->pluck('hyperlight_id')->all();
    expect($ids)->not->toContain('HL_vis1');

    // Creator context: the creator clause admits it.
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$creator->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$creator->user_token]);
    $ids = DB::table('hyperlights')->where('book', $book)->pluck('hyperlight_id')->all();
    expect($ids)->toContain('HL_vis1');
});
