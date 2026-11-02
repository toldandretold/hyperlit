<?php

use App\Mcp\TokenAbilities;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/**
 * The v2 toolset over the real /mcp endpoint: search split (semantic_search /
 * fulltext search_text), audio estimate→confirm, lifecycle (visibility, slug,
 * delete, stats, like), social reads (notifications, reading position, feed,
 * citation graph). Same harness rules as McpServerTest.
 */

beforeEach(function () {
    Queue::fake();
});

function v2Token(User $user, array $abilities): string
{
    return $user->createToken('mcp v2', $abilities, now()->addYear())->plainTextToken;
}

function v2Call($test, string $token, string $tool, array $arguments = [])
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call',
        'params' => ['name' => $tool, 'arguments' => $arguments],
    ], ['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json, text/event-stream']);
}

function v2Text($response): string
{
    return (string) ($response->json('result.content.0.text') ?? '');
}

function v2Json($response): array
{
    return json_decode(v2Text($response), true) ?: [];
}

function v2ReadAs(User $user, callable $query)
{
    // BOTH vars: library's private-row SELECT policy matches app.current_token
    // against users.user_token, and the default connection retains whatever
    // the LAST /mcp request's middleware set — a read after a stranger's call
    // would otherwise see the stranger's visibility.
    DB::statement("select set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("select set_config('app.current_token', ?, false)", [(string) $user->user_token]);

    return $query();
}

function v2SeedBook($test, User $owner, string $visibility = 'private', array $extra = []): string
{
    $book = 'book_mcpv2_'.Str::random(6);
    (function () use ($book, $owner, $visibility, $extra): void {
        $this->seedLibrary(array_merge([
            'book' => $book,
            'title' => 'V2 Fixture',
            'visibility' => $visibility,
            'creator' => $owner->name,
            'has_nodes' => true,
        ], $extra));
        $this->seedNode([
            'book' => $book,
            'startLine' => 100,
            'chunk_id' => 0,
            'node_id' => $book.'_1_aaa',
            'content' => '<p id="100" data-node-id="'.$book.'_1_aaa">Rivers of capital flow uphill to power.</p>',
            'plainText' => 'Rivers of capital flow uphill to power.',
        ]);
    })->call($test);

    return $book;
}

// ─── search split ───────────────────────────────────────────────────────────

test('search_text is fulltext and finds exact words', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user, 'public');
    // A unique token per run: fixture residue from aborted earlier runs is
    // admin-committed and searchable, so a shared word caps out the limit.
    $word = 'uphillw'.Str::lower(Str::random(6));
    (function () use ($book, $word): void {
        $this->seedNode([
            'book' => $book, 'startLine' => 150, 'chunk_id' => 0,
            'node_id' => $book.'_15_ccc',
            'content' => '<p id="150" data-node-id="'.$book.'_15_ccc">Water flows '.$word.' to power.</p>',
            'plainText' => 'Water flows '.$word.' to power.',
        ]);
    })->call($this);

    $response = v2Call($this, v2Token($user, [TokenAbilities::READ]), 'search_text', [
        'query' => $word,
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = v2Json($response);
    expect($out['mode'])->toBe('fulltext');
    expect(json_encode($out['results']))->toContain($book);
});

test('semantic_search is hidden from a token without the read ability', function () {
    $user = $this->seedUser();

    $denied = v2Call($this, v2Token($user, [TokenAbilities::IMPORT]), 'semantic_search', [
        'query' => 'the political economy of anything',
    ]);
    // Ability-sized listing: hidden ⇒ tool-not-found at the protocol layer.
    expect($denied->json('error.code'))->toBe(-32602);
});

// ─── audio: estimate → confirm ──────────────────────────────────────────────

test('create_audiobook without confirm returns the estimate and queues nothing', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user);

    $response = v2Call($this, v2Token($user, [TokenAbilities::SPEND]), 'create_audiobook', [
        'book' => $book,
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = v2Json($response);
    expect($out)->toHaveKey('estimated_cost_usd');
    expect($out['generating'])->toBeFalse();
    expect($out['next'])->toContain('confirm');
    Queue::assertNothingPushed();
});

test('create_audiobook is hidden from a token without the spend ability', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user);

    $response = v2Call($this, v2Token($user, [TokenAbilities::READ, TokenAbilities::WRITE]), 'create_audiobook', [
        'book' => $book, 'confirm' => true,
    ]);
    // Ability-sized listing: hidden ⇒ tool-not-found at the protocol layer.
    expect($response->json('error.code'))->toBe(-32602);
});

test('get_audiobook_status reports narration state and URLs without auth drama', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user);

    $response = v2Call($this, v2Token($user, [TokenAbilities::READ]), 'get_audiobook_status', [
        'book' => $book,
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = v2Json($response);
    expect($out['narration']['has_audio'])->toBeFalse();
    expect($out['m4b_download_url'])->toContain($book.'/audiobook.m4b');
});

// ─── billing read ───────────────────────────────────────────────────────────

test('get_credit_balance returns balance and tier for a read token', function () {
    $user = $this->seedUser();

    $response = v2Call($this, v2Token($user, [TokenAbilities::READ]), 'get_credit_balance');
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = v2Json($response);
    expect($out)->toHaveKeys(['balance', 'tier_multiplier']);
});

// ─── lifecycle ──────────────────────────────────────────────────────────────

test('set_book_visibility flips an owned book private and refuses a stranger', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user, 'public');

    $response = v2Call($this, v2Token($user, [TokenAbilities::WRITE]), 'set_book_visibility', [
        'book' => $book, 'visibility' => 'private',
    ]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $vis = v2ReadAs($user, fn () => DB::table('library')->where('book', $book)->value('visibility'));
    expect($vis)->toBe('private');

    $stranger = $this->seedUser();
    $denied = v2Call($this, v2Token($stranger, [TokenAbilities::WRITE]), 'set_book_visibility', [
        'book' => $book, 'visibility' => 'public',
    ]);
    // Non-owner upsert is refused (or silently not applied) — visibility must not change.
    $vis = v2ReadAs($user, fn () => DB::table('library')->where('book', $book)->value('visibility'));
    expect($vis)->toBe('private');
});

test('delete_book demands confirm and the exact stored title', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user);
    $token = v2Token($user, [TokenAbilities::WRITE]);

    $wrongTitle = v2Call($this, $token, 'delete_book', [
        'book' => $book, 'confirm' => true, 'title_confirmation' => 'Not The Title',
    ]);
    expect($wrongTitle->json('result.isError'))->toBeTrue();
    expect(v2Text($wrongTitle))->toContain('does not match');
    expect(v2ReadAs($user, fn () => DB::table('library')->where('book', $book)->exists()))->toBeTrue();

    $noConfirm = v2Call($this, $token, 'delete_book', [
        'book' => $book, 'confirm' => false, 'title_confirmation' => 'V2 Fixture',
    ]);
    expect($noConfirm->json('result.isError'))->toBeTrue();
    expect(v2ReadAs($user, fn () => DB::table('library')->where('book', $book)->exists()))->toBeTrue();
});

test('like_book likes and unlikes; modify_shelf refuses the Likes shelf', function () {
    $user = $this->seedUser();
    $owner = $this->seedUser();
    $book = v2SeedBook($this, $owner, 'public');
    $token = v2Token($user, [TokenAbilities::ANNOTATE]);

    $like = v2Call($this, $token, 'like_book', ['book' => $book]);
    expect($like->json('result.isError'))->not->toBeTrue();

    $unlike = v2Call($this, $token, 'like_book', ['book' => $book, 'action' => 'unlike']);
    expect($unlike->json('result.isError'))->not->toBeTrue();

    // The single-writer guard: direct membership writes on the likes-kind
    // shelf the LIKE itself auto-created must refuse and point at like_book.
    $likesShelfId = v2ReadAs($user, fn () => DB::table('shelves')
        ->where('creator', $user->name)->where('kind', 'likes')->value('id'));
    expect($likesShelfId)->not->toBeNull();

    $blocked = v2Call($this, $token, 'modify_shelf', [
        'action' => 'add_book', 'shelf_id' => (string) $likesShelfId, 'book' => $book,
    ]);
    expect($blocked->json('result.isError'))->toBeTrue();
    expect(v2Text($blocked))->toContain('like_book');
});

// ─── social reads ───────────────────────────────────────────────────────────

test('list_notifications and mark_notifications_read are RLS-scoped to the token user', function () {
    $user = $this->seedUser();
    $token = v2Token($user, [TokenAbilities::READ, TokenAbilities::ANNOTATE]);

    // RLS only lets NotificationWriter (admin) insert, so seed via admin —
    // which COMMITS outside the test transaction and therefore needs cleanup.
    // That cleanup DELETE can block forever on the row locks markRead's
    // in-transaction UPDATE holds (the cross-connection wedge class from
    // SeedsRlsFixtures::cleanupRlsFixtures), so it runs under a short
    // lock_timeout and a skipped delete just orphans a row owned by this
    // test's throwaway rls_test_* user.
    $admin = DB::connection('pgsql_admin');
    $admin->table('notifications')->insert([
        'recipient' => $user->name,
        'actor' => 'someone',
        'type' => 'hypercite_paired',
        'book' => 'book_x',
        'root_book' => 'book_x',
        'data' => json_encode(['book' => 'book_x']),
        'created_at' => now(),
    ]);

    try {
        $list = v2Call($this, $token, 'list_notifications');
        expect($list->json('result.isError'))->not->toBeTrue();
        $out = v2Json($list);
        expect($out['total'])->toBeGreaterThanOrEqual(1);
        expect($out['unread_count'])->toBeGreaterThanOrEqual(1);

        $mark = v2Call($this, $token, 'mark_notifications_read');
        expect($mark->json('result.isError'))->not->toBeTrue();

        $after = v2Json(v2Call($this, $token, 'list_notifications'));
        expect($after['unread_count'])->toBe(0);
    } finally {
        try {
            $admin->statement("SET lock_timeout = '250ms'");
            $admin->table('notifications')->where('recipient', $user->name)->delete();
        } catch (\Throwable) {
            // Row locked by the still-open test transaction — leave it; the
            // recipient is a per-run random user, so the residue is inert.
        } finally {
            $admin->statement('SET lock_timeout = 0');
        }
    }
});

test('reading position round-trips through a node id', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user);
    $token = v2Token($user, [TokenAbilities::READ, TokenAbilities::ANNOTATE]);

    $set = v2Call($this, $token, 'set_reading_position', [
        'book' => $book, 'node_id' => $book.'_1_aaa',
    ]);
    expect($set->json('result.isError'))->not->toBeTrue();

    $get = v2Json(v2Call($this, $token, 'get_reading_position', ['book' => $book]));
    expect((string) ($get['bookmark']['element_id'] ?? ''))->toBe('100');
});

test('get_citation_graph requires focus and returns a bounded graph', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user, 'public');
    $token = v2Token($user, [TokenAbilities::READ]);

    $response = v2Call($this, $token, 'get_citation_graph', ['focus' => $book]);
    expect($response->json('result.isError'))->not->toBeTrue();
    $out = v2Json($response);
    expect($out['focus'])->toBe($book);
    expect($out)->toHaveKeys(['nodes', 'edges', 'truncated']);
});

test('list_feed returns ranked public books per sort', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user, 'public', [
        'hypercite_connections' => 7, 'reference_connections' => 3, 'total_highlights' => 5,
    ]);
    $token = v2Token($user, [TokenAbilities::READ]);

    foreach (['recent', 'connected', 'lit'] as $sort) {
        $out = v2Json(v2Call($this, $token, 'list_feed', ['sort' => $sort, 'limit' => 50]));
        expect($out['sort'])->toBe($sort);
        expect(collect($out['books'])->pluck('book'))->toContain($book);
    }
});

// ─── read_book footnotes ────────────────────────────────────────────────────

test('read_book include_footnotes returns the definitions for returned nodes', function () {
    $user = $this->seedUser();
    $book = v2SeedBook($this, $user);
    (function () use ($book): void {
        $this->seedNode([
            'book' => $book,
            'startLine' => 200,
            'chunk_id' => 0,
            'node_id' => $book.'_2_bbb',
            'content' => '<p id="200" data-node-id="'.$book.'_2_bbb">A claim with a note.<sup fn-count-id="1">1</sup></p>',
            'plainText' => 'A claim with a note.1',
            'footnotes' => json_encode(['Fn1_'.$book]),
        ]);
    })->call($this);
    DB::connection('pgsql_admin')->table('footnotes')->insert([
        'book' => $book,
        'footnoteId' => 'Fn1_'.$book,
        'content' => '<p>The footnote definition text.</p>',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    try {
        $out = v2Json(v2Call($this, v2Token($user, [TokenAbilities::READ]), 'read_book', [
            'book' => $book, 'include_footnotes' => true,
        ]));
        $withFn = collect($out['nodes'])->firstWhere('node_id', $book.'_2_bbb');
        expect($withFn['footnote_ids'] ?? [])->toContain('Fn1_'.$book);
        expect($out['footnotes']['Fn1_'.$book] ?? '')->toContain('footnote definition');
    } finally {
        DB::connection('pgsql_admin')->table('footnotes')->where('book', $book)->delete();
    }
});
