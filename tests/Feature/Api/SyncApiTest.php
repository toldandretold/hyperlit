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

test('POST /api/db/sync/beacon requires an author', function () {
    $this->assertApiError($this->postJson('/api/db/sync/beacon', ['book' => 'x']), 401);
});

test('POST /api/db/sync/beacon 422s on a malformed payload', function () {
    $this->loginUser();
    // book required + updates/deletions must be arrays — omit them.
    $this->assertApiError($this->postJson('/api/db/sync/beacon', []), 422);
});
