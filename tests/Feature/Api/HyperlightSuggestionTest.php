<?php

/**
 * Suggested edits on hyperlights (suggested_text + suggestion_status).
 *
 * The sync path (upsert) may only perform CREATOR-side transitions — propose
 * (→ pending) and withdraw (→ null) — and never the resolved states, which are
 * written exclusively by the book-owner-gated resolveSuggestion endpoint. A
 * resolved row is immutable from sync (the accept flow's own re-measure echo
 * must not clobber a verdict), and a payload that doesn't carry the keys must
 * not wipe a pending suggestion (older clients).
 */

use Illuminate\Support\Facades\DB;

afterEach(fn () => $this->cleanupApiFixtures());

function suggestionHlPayload(string $book, string $id, array $extra = []): array
{
    return ['data' => [array_merge([
        'book' => $book,
        'hyperlight_id' => $id,
        'node_id' => [$book.'_100_aaaa'],
        'charData' => [$book.'_100_aaaa' => ['charStart' => 5, 'charEnd' => 40]],
        'highlightedText' => 'the originally highlighted passage here',
        'highlightedHTML' => '<span>the originally highlighted passage here</span>',
        'annotation' => null,
        'startLine' => '100',
    ], $extra)]];
}

/**
 * Rows written by the UPSERT endpoint live inside RefreshDatabase's
 * never-committed transaction, so pgsql_admin cannot see them — read on the
 * DEFAULT connection, whose RLS session vars are whatever the last HTTP
 * request set (the creator in the upsert tests, which branch 1 of the SELECT
 * policy admits).
 */
function suggestionRow(string $book, string $id): ?object
{
    return DB::table('hyperlights')
        ->where('book', $book)->where('hyperlight_id', $id)
        ->first(['suggested_text', 'suggestion_status']);
}

function suggestionNotificationsFor(string $recipient)
{
    return DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $recipient)
        ->where('type', 'suggested_edit')
        ->orderBy('id')
        ->get();
}

/* ─── upsert: creator-side transitions ────────────────────────────── */

test('proposing a suggestion on an existing highlight stores the map and derives pending', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_sugg1'))
        ->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_sugg1', [
        'suggested_text' => [$book.'_100_aaaa' => [
            'before' => 'originally highlighted passage',
            'after' => 'passage highlighted at the origin',
        ]],
        // whatever the client claims, status is DERIVED
        'suggestion_status' => 'accepted',
    ]))->assertStatus(200);

    $row = suggestionRow($book, 'HL_sugg1');
    expect($row->suggestion_status)->toBe('pending');
    $map = json_decode($row->suggested_text, true);
    expect($map[$book.'_100_aaaa']['after'])->toBe('passage highlighted at the origin');
});

test('a suggestion on a NEW row is discarded — suggestions only exist on an existing highlight', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_suggnew', [
        'suggested_text' => [$book.'_100_aaaa' => ['before' => 'a', 'after' => 'b']],
    ]))->assertStatus(200);

    $row = suggestionRow($book, 'HL_suggnew');
    expect($row->suggested_text)->toBeNull();
    expect($row->suggestion_status)->toBeNull();
});

test('a payload WITHOUT the suggestion keys does not wipe a pending suggestion (older clients)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_keep'))->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_keep', [
        'suggested_text' => [$book.'_100_aaaa' => ['before' => 'x', 'after' => 'y']],
    ]))->assertStatus(200);

    // Re-sync of the same record without the keys (an annotation edit, say).
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_keep', [
        'annotation' => 'a note added later',
    ]))->assertStatus(200);

    $row = suggestionRow($book, 'HL_keep');
    expect($row->suggestion_status)->toBe('pending');
    expect(json_decode($row->suggested_text, true))->not->toBeNull();
});

test('sending suggested_text null WITH the key withdraws the suggestion', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_wdraw'))->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_wdraw', [
        'suggested_text' => [$book.'_100_aaaa' => ['before' => 'x', 'after' => 'y']],
    ]))->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_wdraw', [
        'suggested_text' => null,
    ]))->assertStatus(200);

    $row = suggestionRow($book, 'HL_wdraw');
    expect($row->suggested_text)->toBeNull();
    expect($row->suggestion_status)->toBeNull();
});

test('suggestion segment values are sanitized', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_xss'))->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_xss', [
        'suggested_text' => [$book.'_100_aaaa' => [
            'before' => 'plain before',
            'after' => 'bad <script>alert(1)</script> text',
        ]],
    ]))->assertStatus(200);

    $row = suggestionRow($book, 'HL_xss');
    expect($row->suggested_text)->not->toContain('<script');
    expect(json_decode($row->suggested_text, true)[$book.'_100_aaaa']['after'])->toContain('text');
});

/* ─── resolution endpoint ─────────────────────────────────────────── */

function seedPendingSuggestion($test, $owner, string $book, $suggester, string $hlId): void
{
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book,
        'hyperlight_id' => $hlId,
        'sub_book_id' => $book.'/'.$hlId,
        'creator' => $suggester->name,
        'highlightedText' => 'the original passage',
        'suggested_text' => json_encode([$book.'_100_aaaa' => ['before' => 'original', 'after' => 'improved']]),
        'suggestion_status' => 'pending',
        'raw_json' => json_encode([]),
        'hidden' => false,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

test('the book owner can accept, and suggested_text is retained for the before/after render', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_acc1');

    $this->actingAs($owner);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_acc1', 'resolution' => 'accepted',
    ])->assertStatus(200);

    $row = suggestionRow($book, 'HL_acc1');
    expect($row->suggestion_status)->toBe('accepted');
    expect(json_decode($row->suggested_text, true))->not->toBeNull();
});

test('reject and like are recorded the same way', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_rej1');
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_like1');

    $this->actingAs($owner);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_rej1', 'resolution' => 'rejected',
    ])->assertStatus(200);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_like1', 'resolution' => 'liked',
    ])->assertStatus(200);

    expect(suggestionRow($book, 'HL_rej1')->suggestion_status)->toBe('rejected');
    expect(suggestionRow($book, 'HL_like1')->suggestion_status)->toBe('liked');
});

test('the suggester cannot resolve their own suggestion, nor can a stranger', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_perm1');

    $this->actingAs($suggester);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_perm1', 'resolution' => 'accepted',
    ])->assertStatus(403);

    $stranger = $this->apiUser();
    $this->actingAs($stranger);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_perm1', 'resolution' => 'accepted',
    ])->assertStatus(403);

    expect(suggestionRow($book, 'HL_perm1')->suggestion_status)->toBe('pending');
});

test('resolving a non-pending suggestion is a 422 (double-resolve is explicit)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_twice');

    $this->actingAs($owner);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_twice', 'resolution' => 'accepted',
    ])->assertStatus(200);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_twice', 'resolution' => 'rejected',
    ])->assertStatus(422);

    expect(suggestionRow($book, 'HL_twice')->suggestion_status)->toBe('accepted');
});

test('a resolved suggestion is immune to a stale creator echo through upsert', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->loginUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_echo');

    $this->actingAs($owner);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_echo', 'resolution' => 'rejected',
    ])->assertStatus(200);

    // The suggester's client re-syncs its stale record (still carrying pending).
    $this->actingAs($suggester);
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_echo', [
        'suggested_text' => [$book.'_100_aaaa' => ['before' => 'original', 'after' => 'improved']],
        'suggestion_status' => 'pending',
    ]))->assertStatus(200);

    expect(suggestionRow($book, 'HL_echo')->suggestion_status)->toBe('rejected');
});

/* ─── wire rows ───────────────────────────────────────────────────── */

test('the annotations payload and find both carry the suggestion fields', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_wire');
    // The seeded row has no sub-book library row — public by absence.

    $this->actingAs($owner);
    $hl = collect($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hyperlights'))
        ->firstWhere('hyperlight_id', 'HL_wire');
    expect($hl['suggestion_status'])->toBe('pending');
    expect($hl['suggested_text'][$book.'_100_aaaa']['after'])->toBe('improved');

    $found = $this->getJson("/api/db/hyperlights/find/{$book}/HL_wire")
        ->assertStatus(200)->json('hyperlight');
    expect($found['suggestion_status'])->toBe('pending');
    expect($found['suggested_text'][$book.'_100_aaaa']['before'])->toBe('original');
});

/* ─── notifications ───────────────────────────────────────────────── */

test('a suggestion transition notifies the book owner once, and a replay does not re-notify', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'The Owned Book']);
    $actor = $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_note1'))->assertStatus(200);

    $suggestPayload = suggestionHlPayload($book, 'HL_note1', [
        'suggested_text' => [$book.'_100_aaaa' => ['before' => 'orig', 'after' => 'the proposed replacement']],
    ]);
    $this->postJson('/api/db/hyperlights/upsert', $suggestPayload)->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', $suggestPayload)->assertStatus(200);

    $rows = suggestionNotificationsFor($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->actor)->toBe($actor->name);
    expect($rows[0]->subject_id)->toBe('HL_note1');
    $data = json_decode($rows[0]->data, true);
    expect($data['snippet'])->toBe('the proposed replacement');
});

test('a suggestion on a PRIVATE highlight stays silent', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_privsugg', [
        'sub_book_visibility' => 'private',
    ]))->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_privsugg', [
        'suggested_text' => [$book.'_100_aaaa' => ['before' => 'orig', 'after' => 'new']],
    ]))->assertStatus(200);

    expect(suggestionNotificationsFor($owner->name))->toHaveCount(0);
});

test('suggesting on your own book is silent (self-event)', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_selfsugg'))->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_selfsugg', [
        'suggested_text' => [$book.'_100_aaaa' => ['before' => 'orig', 'after' => 'new']],
    ]))->assertStatus(200);

    expect(suggestionNotificationsFor($owner->name))->toHaveCount(0);
});

test('the owner can REVERT an accepted suggestion back to pending — and only from accepted', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_revert1');

    $this->actingAs($owner);
    // pending → pending is not a legal transition (nothing to revert).
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_revert1', 'resolution' => 'pending',
    ])->assertStatus(422);

    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_revert1', 'resolution' => 'accepted',
    ])->assertStatus(200);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_revert1', 'resolution' => 'pending',
    ])->assertStatus(200);

    $row = suggestionRow($book, 'HL_revert1');
    expect($row->suggestion_status)->toBe('pending');
    expect(json_decode($row->suggested_text, true))->not->toBeNull(); // re-decidable
});

test('rejected and liked suggestions can be REOPENED (reconsidered) back to pending', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_reopen1');

    $this->actingAs($owner);
    // Decline → reopen → like → reopen (the full reconsider cycle).
    foreach (['rejected', 'pending', 'liked', 'pending'] as $i => $target) {
        $this->postJson('/api/db/hyperlights/suggestion/resolve', [
            'book' => $book, 'hyperlight_id' => 'HL_reopen1', 'resolution' => $target,
        ])->assertStatus(200);
        expect(suggestionRow($book, 'HL_reopen1')->suggestion_status)->toBe($target);
    }

    // pending → pending is still illegal (nothing resolved to reopen).
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_reopen1', 'resolution' => 'pending',
    ])->assertStatus(422);
});

test('the suggester cannot revert the owner\'s acceptance', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $suggester = $this->apiUser();
    seedPendingSuggestion($this, $owner, $book, $suggester, 'HL_revert2');

    $this->actingAs($owner);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_revert2', 'resolution' => 'accepted',
    ])->assertStatus(200);

    $this->actingAs($suggester);
    $this->postJson('/api/db/hyperlights/suggestion/resolve', [
        'book' => $book, 'hyperlight_id' => 'HL_revert2', 'resolution' => 'pending',
    ])->assertStatus(403);
});

test('a suggestion SUBSUMES the earlier plain-highlight notification (one line, not two)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Owned']);
    $actor = $this->loginUser();

    // Public highlight → the owner gets a `hyperlight` notification.
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_merge'))->assertStatus(200);
    $all = fn () => DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $owner->name)->where('subject_id', 'HL_merge')->get();
    expect($all()->pluck('type')->all())->toBe(['hyperlight']);

    // Now a suggestion lands → the hyperlight notification is retracted, leaving
    // only the suggested_edit one.
    $this->postJson('/api/db/hyperlights/upsert', suggestionHlPayload($book, 'HL_merge', [
        'suggested_text' => [$book.'_100_aaaa' => ['before' => 'orig', 'after' => 'proposed']],
    ]))->assertStatus(200);

    expect($all()->pluck('type')->all())->toBe(['suggested_edit']);
    expect($all())->toHaveCount(1);
});
