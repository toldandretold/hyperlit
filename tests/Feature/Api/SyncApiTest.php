<?php

/**
 * Unified + beacon sync endpoints (UnifiedSyncController, BeaconSyncController).
 *
 * unified-sync orchestrates writes across many child controllers inside a single
 * transaction, with each child opening its own — see findings F8 (nested
 * transactions). We pin auth + the input/stale guards here; the orchestration
 * itself is best exercised through the editor save flow.
 */

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── unified-sync ────────────────────────────────────────────────── */

test('POST /api/db/unified-sync requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/unified-sync', ['book' => 'x']), 401);
});

test('POST /api/db/unified-sync 400s without a book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/db/unified-sync', []), 400);
});

test('POST /api/db/unified-sync upserts a library record (happy path; exercises F8 refactor)', function () {
    // Library-only payload: no nodes (so the stale-check is skipped), no deletions
    // (so the post-commit deletion helpers no-op). Covers the transaction + a child
    // upsert + the results envelope after the F8 extract-and-reorder.
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);

    $this->postJson('/api/db/unified-sync', [
        'book'    => $book,
        'library' => ['book' => $book, 'title' => 'Synced Title'],
    ])
        ->assertStatus(200)
        ->assertJson(['success' => true])
        ->assertJsonPath('results.library.success', true);
});

test('POST /api/db/unified-sync self-heals a missing sub-book library row (paste-seeded footnote)', function () {
    // Paste import seeds footnote sub-book nodes client-side without registering
    // the sub-book on the backend. The first edit sync then used to 500 forever:
    // the nodes RLS insert policy requires an owned library row for nodes.book,
    // and the missing row could never be created. SubBookRegistrar now creates it
    // inside the same sync.
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app', 'visibility' => 'private']);
    $subBook = $book.'/Fn123_test';
    $nodeId = $subBook.'_111_aaaa';

    $this->postJson('/api/db/unified-sync', [
        'book'  => $subBook,
        'nodes' => [[
            'book'        => $subBook,
            'startLine'   => 1,
            'chunk_id'    => 0,
            'node_id'     => $nodeId,
            'content'     => '<p data-node-id="'.$nodeId.'">pasted footnote text</p>',
            'hyperlights' => [],
            'hypercites'  => [],
            'footnotes'   => [],
        ]],
    ])
        ->assertStatus(200)
        ->assertJson(['success' => true]);

    $lib = \Illuminate\Support\Facades\DB::table('library')->where('book', $subBook)->first();
    expect($lib)->not->toBeNull();
    expect($lib->type)->toBe('sub_book');
    expect($lib->creator)->toBe($user->name);
    expect($lib->visibility)->toBe('private'); // footnote sub-book inherits parent visibility

    expect(\Illuminate\Support\Facades\DB::table('nodes')->where('book', $subBook)->count())->toBe(1);
});

test('POST /api/db/unified-sync does not register a sub-book under a foreign book', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner); // admin-seeded, owned by someone else
    $this->loginUser();              // attacker: different authenticated user
    $subBook = $book.'/Fn999_evil';

    $this->postJson('/api/db/unified-sync', [
        'book'  => $subBook,
        'nodes' => [[
            'book'      => $subBook,
            'startLine' => 1,
            'chunk_id'  => 0,
            'node_id'   => $subBook.'_222_bbbb',
            'content'   => '<p>not yours</p>',
        ]],
    ]);

    $admin = \Illuminate\Support\Facades\DB::connection('pgsql_admin');
    expect($admin->table('library')->where('book', $subBook)->exists())->toBeFalse();
    expect($admin->table('nodes')->where('book', $subBook)->count())->toBe(0);
});

test('POST /api/db/unified-sync derives plainText from content on the bulk path (embedding source)', function () {
    // The client never sends plainText (not in the PublicNode wire shape). unified-sync
    // routes nodes through bulkTargetedUpsert, which must derive plainText = strip_tags(content)
    // like upsert() does — otherwise plainText lands NULL and QueueBookEmbeddings (which filters
    // `plainText IS NOT NULL AND length >= 20`) never embeds the node.
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);
    $nodeId = $book.'_100_aaaa';

    $this->postJson('/api/db/unified-sync', [
        'book'  => $book,
        'nodes' => [[
            'book'        => $book,
            'startLine'   => 1,
            'chunk_id'    => 0,
            'node_id'     => $nodeId,
            'content'     => '<h1 data-node-id="'.$nodeId.'">The New International Economic Order</h1>',
            'hyperlights' => [],
            'hypercites'  => [],
            'footnotes'   => [],
            // NOTE: no plainText sent — mirrors the real client payload.
        ]],
    ])->assertStatus(200)->assertJson(['success' => true]);

    // Read on the default connection (inside the RefreshDatabase transaction) — the row
    // was written there; pgsql_admin is a separate connection and can't see it yet.
    $node = \Illuminate\Support\Facades\DB::table('nodes')
        ->where('book', $book)->where('node_id', $nodeId)->first();

    expect($node)->not->toBeNull();
    expect($node->plainText)->toBe('The New International Economic Order');
});

/* ─── optimistic-concurrency (base_timestamp) stale guard ─────────── */

test('POST /api/db/unified-sync 409s when base_timestamp is older than the server version', function () {
    // The client loaded the book at version 1000; another device has since advanced the
    // server to 2000. The client's local `timestamp` is bumped to now() on every edit, so
    // the check must key off base_timestamp (the version it loaded), NOT library.timestamp.
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);

    // Establish the server version at 2000 via a library-only sync (no nodes → stale check skipped).
    $this->postJson('/api/db/unified-sync', [
        'book'    => $book,
        'library' => ['book' => $book, 'timestamp' => 2000],
    ])->assertStatus(200);

    $nodeId = $book.'_100_aaaa';
    $this->postJson('/api/db/unified-sync', [
        'book'           => $book,
        'base_timestamp' => 1000,                               // loaded at 1000 (stale)
        'library'        => ['book' => $book, 'timestamp' => 9999], // bumped local ts — must be IGNORED
        'nodes'          => [[
            'book' => $book, 'startLine' => 1, 'chunk_id' => 0, 'node_id' => $nodeId,
            'content' => '<p data-node-id="'.$nodeId.'">stale edit</p>',
            'hyperlights' => [], 'hypercites' => [], 'footnotes' => [],
        ]],
    ])
        ->assertStatus(409)
        ->assertJson(['error' => 'STALE_DATA']);
});

test('POST /api/db/unified-sync succeeds when base_timestamp matches the server version, and returns server_timestamp', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);

    // Establish the server version at 2000.
    $this->postJson('/api/db/unified-sync', [
        'book'    => $book,
        'library' => ['book' => $book, 'timestamp' => 2000],
    ])->assertStatus(200);

    $nodeId = $book.'_100_aaaa';
    $this->postJson('/api/db/unified-sync', [
        'book'           => $book,
        'base_timestamp' => 2000,                                  // up to date
        'library'        => ['book' => $book, 'timestamp' => 2500],
        'nodes'          => [[
            'book' => $book, 'startLine' => 1, 'chunk_id' => 0, 'node_id' => $nodeId,
            'content' => '<p data-node-id="'.$nodeId.'">fresh edit</p>',
            'hyperlights' => [], 'hypercites' => [], 'footnotes' => [],
        ]],
    ])
        ->assertStatus(200)
        ->assertJson(['success' => true])
        ->assertJsonPath('server_timestamp', 2500); // max(existing 2000, sent 2500), returned for the client to re-base
});

/* ─── lost-ACK self-conflict tokens (sync_token / server_sync_token) ── */

test('POST /api/db/unified-sync stores sync_token on the library write and echoes it in the stale 409', function () {
    // The client stamps every POST with a write id. When the sync sets the library
    // timestamp, the id is stored (library.last_sync_token); a later stale 409 echoes
    // it back so the client can prove the "conflicting" version is its OWN write whose
    // response was lost (the network-blip discard-overlay bug).
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);

    $this->postJson('/api/db/unified-sync', [
        'book'       => $book,
        'sync_token' => 'tok-lost-write',
        'library'    => ['book' => $book, 'timestamp' => 2000],
    ])->assertStatus(200);

    expect(\Illuminate\Support\Facades\DB::table('library')->where('book', $book)->value('last_sync_token'))
        ->toBe('tok-lost-write');

    $nodeId = $book.'_100_aaaa';
    $this->postJson('/api/db/unified-sync', [
        'book'           => $book,
        'sync_token'     => 'tok-retry',
        'base_timestamp' => 1000, // lagging base — the lost write's response never advanced it
        'library'        => ['book' => $book, 'timestamp' => 9999],
        'nodes'          => [[
            'book' => $book, 'startLine' => 1, 'chunk_id' => 0, 'node_id' => $nodeId,
            'content' => '<p data-node-id="'.$nodeId.'">edit after the lost write</p>',
            'hyperlights' => [], 'hypercites' => [], 'footnotes' => [],
        ]],
    ])
        ->assertStatus(409)
        ->assertJson(['error' => 'STALE_DATA'])
        ->assertJsonPath('server_sync_token', 'tok-lost-write');
});

test('POST /api/db/unified-sync does NOT re-stamp the token when the existing timestamp is newer', function () {
    // The library upsert never downgrades a newer existing timestamp. The token must
    // only ever label a timestamp the write actually produced — stamping it on someone
    // else's newer version would let a later 409 wrongly self-recover and clobber it.
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);

    $this->postJson('/api/db/unified-sync', [
        'book'       => $book,
        'sync_token' => 'tok-current-version',
        'library'    => ['book' => $book, 'timestamp' => 2000],
    ])->assertStatus(200);

    // A lagging write (older timestamp) is preserved-over, so its token must not stick.
    $this->postJson('/api/db/unified-sync', [
        'book'       => $book,
        'sync_token' => 'tok-lagging-write',
        'library'    => ['book' => $book, 'timestamp' => 1000],
    ])->assertStatus(200);

    $row = \Illuminate\Support\Facades\DB::table('library')->where('book', $book)->first();
    expect($row->timestamp)->toBe(2000);
    expect($row->last_sync_token)->toBe('tok-current-version');
});

/* ─── footnote upsert ─────────────────────────────────────────────── */

test('POST /api/db/footnotes/upsert registers sub-book library rows (paste import path)', function () {
    // Paste import's initial upload syncs footnote records; the sub-book library
    // row must be created alongside (mirrors DbHyperlightController::upsert) so
    // later node syncs for the footnote's sub-book pass the nodes RLS policy.
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app', 'visibility' => 'private']);

    $this->postJson('/api/db/footnotes/upsert', [
        'book' => $book,
        'data' => [
            ['footnoteId' => 'Fn123_test', 'content' => '<p>first note</p>'],
            ['footnoteId' => 'Fn456_test', 'content' => '<p>second note</p>'],
        ],
    ])
        ->assertStatus(200)
        ->assertJson(['success' => true]);

    foreach (['Fn123_test', 'Fn456_test'] as $fnId) {
        $lib = \Illuminate\Support\Facades\DB::table('library')->where('book', $book.'/'.$fnId)->first();
        expect($lib)->not->toBeNull();
        expect($lib->type)->toBe('sub_book');
        expect($lib->creator)->toBe($user->name);
        expect($lib->visibility)->toBe('private');
    }
});

/* ─── beacon sync ─────────────────────────────────────────────────── */

test('POST /api/db/sync/beacon stamps sync_token only when its timestamp becomes the clock', function () {
    // The beacon never sees its response, so its library write MUST be token-labelled
    // for the next session's 409 to self-recover — but only when the beacon's timestamp
    // actually won (the preserved-newer branch must not steal the label).
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['via' => 'app']);

    $beacon = fn (int $ts, string $token) => $this->postJson('/api/db/sync/beacon', [
        'book'       => $book,
        'sync_token' => $token,
        'updates'    => [
            'nodes' => [], 'hyperlights' => [], 'hypercites' => [],
            'library' => ['book' => $book, 'timestamp' => $ts],
        ],
        'deletions'  => ['nodes' => [], 'hyperlights' => []],
    ]);

    $beacon(2000, 'tok-beacon-write')->assertStatus(204); // beacon replies no-content
    expect(\Illuminate\Support\Facades\DB::table('library')->where('book', $book)->value('last_sync_token'))
        ->toBe('tok-beacon-write');

    // Older timestamp → preserved-over → the current version keeps its own label.
    $beacon(1000, 'tok-lagging-beacon')->assertStatus(204);
    $row = \Illuminate\Support\Facades\DB::table('library')->where('book', $book)->first();
    expect($row->timestamp)->toBe(2000);
    expect($row->last_sync_token)->toBe('tok-beacon-write');
});

test('POST /api/db/sync/beacon requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/sync/beacon', ['book' => 'x']), 401);
});

test('POST /api/db/sync/beacon 422s on a malformed payload', function () {
    $this->loginUser();
    // book required + updates/deletions must be arrays — omit them.
    $this->assertApiError($this->postJson('/api/db/sync/beacon', []), 422);
});
