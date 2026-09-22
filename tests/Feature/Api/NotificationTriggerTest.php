<?php

/**
 * Notification WRITE side (App\Services\Notifications\NotificationWriter),
 * exercised through the real endpoints that trigger it:
 *
 *  - hyperlight created  → DbHyperlightController::upsert (new-record branch)
 *  - hypercite PAIRED    → DbHyperciteController::upsert (citedIN grew;
 *                          creation with empty citedIN stays silent — a
 *                          `single` is invisible to the owner by design)
 *  - book liked          → BookLikeController::toggle (insert actually landed)
 *
 * Rows are inserted via pgsql_admin inside DB::afterCommit, so they COMMIT and
 * escape RefreshDatabase — cleanupApiFixtures deletes them by recipient.
 */

use App\Services\Connections\ConnectionRefresher;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    // The hypercite upsert's afterCommit connection-score recompute runs on
    // pgsql_admin. Inside a test, RefreshDatabase's never-committing wrapper
    // still holds the library row lock updateAnnotationsTimestamp took on the
    // default connection, so the admin UPDATE would wait on it FOREVER (the
    // cross-connection wedge the afterCommit deferral fixes in prod, where the
    // commit actually happens). The recompute is not under test here — stub it.
    $this->app->instance(ConnectionRefresher::class, Mockery::mock(ConnectionRefresher::class, function ($mock) {
        $mock->shouldReceive('refresh')->andReturn([]);
    }));
});

// cleanupApiFixtures defers internally (past the rollback) and clears the
// admin-seeded hyperlights/hypercites too — see InteractsWithApi.
afterEach(fn () => $this->cleanupApiFixtures());

function notificationsFor(string $recipient)
{
    return DB::connection('pgsql_admin')->table('notifications')
        ->where('recipient', $recipient)
        ->orderBy('id')
        ->get();
}

function hyperlightPayload(string $book, string $id, array $extra = []): array
{
    return ['data' => [array_merge([
        'book' => $book,
        'hyperlight_id' => $id,
        'node_id' => [$book.'_100_aaaa'],
        'charData' => [],
        'highlightedText' => 'a highlighted passage of real substance',
        'highlightedHTML' => '<span>a highlighted passage of real substance</span>',
        'annotation' => null,
        'startLine' => '100',
    ], $extra)]];
}

function hypercitePayload(string $book, string $id, array $citedIN, string $status): array
{
    return ['data' => [[
        'book' => $book,
        'hyperciteId' => $id,
        'node_id' => [$book.'_100_aaaa'],
        'charData' => [],
        'hypercitedText' => 'a cited passage',
        'hypercitedHTML' => '<u>a cited passage</u>',
        'relationshipStatus' => $status,
        'citedIN' => $citedIN,
    ]]];
}

/* ─── hyperlight created ──────────────────────────────────────────── */

test('highlighting another user\'s book notifies the owner', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'The Owned Book']);
    $actor = $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', hyperlightPayload($book, 'hyperlight_n1'))
        ->assertStatus(200);

    $rows = notificationsFor($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->type)->toBe('hyperlight');
    expect($rows[0]->actor)->toBe($actor->name);
    expect($rows[0]->book)->toBe($book);
    expect($rows[0]->subject_id)->toBe('hyperlight_n1');
    expect($rows[0]->read_at)->toBeNull();
    $data = json_decode($rows[0]->data, true);
    expect($data['context_label'])->toBe('your book “The Owned Book”');
    expect($data['snippet'])->toBe('a highlighted passage of real substance');
});

test('highlighting your own book is silent', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    $this->postJson('/api/db/hyperlights/upsert', hyperlightPayload($book, 'hyperlight_self'))
        ->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(0);
});

test('an anonymous highlighter notifies with a NULL actor ("Someone")', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    ['token' => $token] = $this->anonSession();

    // JSON requests strip the cookie jar unless withCredentials() is set —
    // same ceremony as SubBookVisibilityApiTest's anon assertions.
    $this->withCredentials()->withUnencryptedCookie('anon_token', $token)
        ->postJson('/api/db/hyperlights/upsert', hyperlightPayload($book, 'hyperlight_anon'))
        ->assertStatus(200);

    $rows = notificationsFor($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->actor)->toBeNull();
});

test('a replayed hyperlight upsert does not re-notify (offline-flush replay)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $payload = hyperlightPayload($book, 'hyperlight_replay');
    $this->postJson('/api/db/hyperlights/upsert', $payload)->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', $payload)->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(1);
});

test('updating an existing hyperlight (annotation edit) does not re-notify', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', hyperlightPayload($book, 'hyperlight_edit'))
        ->assertStatus(200);
    $this->postJson('/api/db/hyperlights/upsert', hyperlightPayload($book, 'hyperlight_edit', [
        'annotation' => 'now with a note',
    ]))->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(1);
});

test('highlighting a HIGHLIGHT (sub-book) notifies the sub-book\'s creator with a chain label', function () {
    // A's book; B made a highlight on it (so B owns the HL sub-book); C now
    // highlights INSIDE B's highlight → B is the recipient, not A.
    $a = $this->apiUser();
    $rootBook = $this->makeBook($a, ['visibility' => 'public', 'title' => 'Root Title']);
    $b = $this->apiUser();
    $subBook = $rootBook.'/HL_abc123';
    $this->makeBook($b, ['book' => $subBook, 'visibility' => 'public', 'type' => 'sub_book', 'title' => 'Annotation: HL_abc123']);
    $c = $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', hyperlightPayload($subBook, 'hyperlight_nested'))
        ->assertStatus(200);

    $rows = notificationsFor($b->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->actor)->toBe($c->name);
    expect($rows[0]->book)->toBe($subBook);
    expect($rows[0]->root_book)->toBe($rootBook);
    $data = json_decode($rows[0]->data, true);
    expect($data['context_label'])->toBe('a highlight in your book “Root Title”');
    expect(notificationsFor($a->name))->toHaveCount(0);
});

test('a book owned by an anonymous session gets no notification (v1: logged-in recipients only)', function () {
    $anonToken = '00000000-0000-4000-8000-00000000abcd';
    DB::connection('pgsql_admin')->table('anonymous_sessions')->insert([
        'token' => $anonToken, 'created_at' => now(), 'last_used_at' => now(),
    ]);
    $book = $this->makeBook($anonToken, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', hyperlightPayload($book, 'hyperlight_anonowner'))
        ->assertStatus(200);

    expect(DB::connection('pgsql_admin')->table('notifications')->where('book', $book)->count())->toBe(0);

    DB::connection('pgsql_admin')->table('anonymous_sessions')->where('token', $anonToken)->delete();
});

test('a PRIVATE highlight stays silent — private activity is never reported to the owner', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', hyperlightPayload($book, 'hyperlight_priv', [
        'sub_book_visibility' => 'private',
    ]))->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(0);
    // The highlight itself DID save (only the notification is suppressed) —
    // and its sub-book landed private, which is what makes it private activity.
    // Default connection: the row lives inside the test transaction (invisible
    // to pgsql_admin), and RLS shows the creator their own row.
    $sub = DB::table('library')
        ->where('book', $book.'/hyperlight_priv')->first();
    expect($sub)->not->toBeNull();
    expect($sub->visibility)->toBe('private');
});

test('a sticky-private highlight born through UNIFIED-SYNC is silent (the user create path)', function () {
    // The shipped client sends new highlights through /api/db/unified-sync with
    // sub_book_visibility from the sticky default — NOT direct /upsert. Prove
    // the field survives unified-sync and suppresses the notification in ONE
    // create sync (no public notification is ever written).
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/unified-sync', [
        'book' => $book,
        'hyperlights' => [[
            'book' => $book,
            'hyperlight_id' => 'HL_sticky',
            'node_id' => [$book.'_100_aaaa'],
            'charData' => [],
            'highlightedText' => 'born private via the sticky default',
            'sub_book_visibility' => 'private',
        ]],
    ])->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(0);
    // And the sub-book row landed private, so the highlight is actually private.
    $sub = DB::table('library')->where('book', $book.'/HL_sticky')->first();
    expect($sub?->visibility)->toBe('private');
});

test('flipping a private highlight to PUBLIC notifies the owner (the mirror of retraction)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->apiUser();

    // A private highlight (silent) — highlight row + private sub-book, no notification yet.
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book, 'hyperlight_id' => 'HL_topublic', 'sub_book_id' => $book.'/HL_topublic',
        'creator' => $reader->name, 'highlightedText' => 'was private, now public',
        'raw_json' => json_encode([]), 'hidden' => false, 'created_at' => now(), 'updated_at' => now(),
    ]);
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => $book.'/HL_topublic', 'creator' => $reader->name, 'visibility' => 'private',
        'listed' => false, 'title' => 'Annotation: HL_topublic', 'type' => 'sub_book',
        'raw_json' => json_encode([]), 'created_at' => now(), 'updated_at' => now(),
    ]);
    expect(notificationsFor($owner->name))->toHaveCount(0);

    // The reader flips it public — now the owner should hear about it.
    $this->actingAs($reader);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_topublic', 'visibility' => 'public',
    ])->assertStatus(200);

    $rows = notificationsFor($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->type)->toBe('hyperlight');
    expect($rows[0]->actor)->toBe($reader->name);
    expect($rows[0]->subject_id)->toBe('HL_topublic');
});

test('a public→public visibility no-op does not notify', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $reader = $this->apiUser();
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book, 'hyperlight_id' => 'HL_noop', 'sub_book_id' => $book.'/HL_noop',
        'creator' => $reader->name, 'raw_json' => json_encode([]), 'hidden' => false,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => $book.'/HL_noop', 'creator' => $reader->name, 'visibility' => 'public',
        'listed' => false, 'title' => 'Annotation: HL_noop', 'type' => 'sub_book',
        'raw_json' => json_encode([]), 'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->actingAs($reader);
    $this->postJson('/api/db/sub-books/visibility', [
        'parentBook' => $book, 'itemId' => 'HL_noop', 'visibility' => 'public',
    ])->assertStatus(200);

    // Was already public (its create sync would have notified, not this flip).
    expect(notificationsFor($owner->name))->toHaveCount(0);
});

/* ─── hypercite paired ────────────────────────────────────────────── */

function seedHypercite(string $book, string $id, string $creator, array $citedIN, string $status): void
{
    DB::connection('pgsql_admin')->table('hypercites')->insert([
        'book' => $book,
        'hyperciteId' => $id,
        'creator' => $creator,
        'citedIN' => json_encode($citedIN),
        'relationshipStatus' => $status,
        'hypercitedText' => 'a cited passage',
        'raw_json' => json_encode([]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

test('pairing a hypercite (single→couple) notifies the cited book\'s owner with the citing ref', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Cited Book']);
    $actor = $this->loginUser();
    $citing = $this->makeBook($actor, ['visibility' => 'public']); // pairing only notifies from PUBLIC citing books
    seedHypercite($book, 'hypercite_p1', $actor->name, [], 'single');

    $this->postJson('/api/db/hypercites/upsert',
        hypercitePayload($book, 'hypercite_p1', ["/{$citing}#hypercite_x"], 'couple'))
        ->assertStatus(200);

    $rows = notificationsFor($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->type)->toBe('hypercite_paired');
    expect($rows[0]->actor)->toBe($actor->name);
    expect($rows[0]->subject_id)->toBe('hypercite_p1');
    expect($rows[0]->citing_ref)->toBe("/{$citing}#hypercite_x");
});

test('every ADDITIONAL citation notifies too (couple→poly), and a replay does not', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->loginUser();
    $citingA = $this->makeBook($actor, ['visibility' => 'public']);
    $citingB = $this->makeBook($actor, ['visibility' => 'public']);
    seedHypercite($book, 'hypercite_p2', $actor->name, [], 'single');

    $first = ["/{$citingA}#hypercite_x"];
    $this->postJson('/api/db/hypercites/upsert',
        hypercitePayload($book, 'hypercite_p2', $first, 'couple'))->assertStatus(200);

    $both = ["/{$citingA}#hypercite_x", "/{$citingB}#hypercite_y"];
    $this->postJson('/api/db/hypercites/upsert',
        hypercitePayload($book, 'hypercite_p2', $both, 'poly'))->assertStatus(200);

    // Replay of the same payload — no new refs, no new rows.
    $this->postJson('/api/db/hypercites/upsert',
        hypercitePayload($book, 'hypercite_p2', $both, 'poly'))->assertStatus(200);

    $rows = notificationsFor($owner->name);
    expect($rows)->toHaveCount(2);
    expect($rows[1]->citing_ref)->toBe("/{$citingB}#hypercite_y");
});

test('a hypercite paired from a PRIVATE (or unknown) citing book stays silent — the book id itself is a leak', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $actor = $this->loginUser();
    $privateCiting = $this->makeBook($actor, ['visibility' => 'private']);
    seedHypercite($book, 'hypercite_priv', $actor->name, [], 'single');

    $this->postJson('/api/db/hypercites/upsert', hypercitePayload($book, 'hypercite_priv', [
        "/{$privateCiting}#hypercite_x",   // private book
        '/never_synced_book#hypercite_y',  // no library row at all
    ], 'poly'))->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(0);
});

// The publish/hide FAN-OUT is exercised at the NotificationWriter level, not
// through /api/db/library/upsert: that endpoint wraps in DB::transaction, so
// its afterCommit (where the wiring lives) is nested and never fires under
// RefreshDatabase's never-committing wrapper. The end-to-end wiring (a real
// book-publish firing this) is covered by the e2e suite, which commits for real.
test('citingBookPublished fans out the suppressed pairings to the cited owners', function () {
    $b = $this->apiUser();
    $citedBook = $this->makeBook($b, ['visibility' => 'public', 'title' => 'Cited Work']);
    $a = $this->apiUser();
    $citingBook = $this->makeBook($a, ['visibility' => 'private']);

    // The hypercite row lives on the CITED book; citedIN points at A's private book.
    seedHypercite($citedBook, 'hypercite_fan', $a->name, ["/{$citingBook}#hypercite_z"], 'couple');

    \App\Services\Notifications\NotificationWriter::citingBookPublished($citingBook, $a->name);

    $rows = notificationsFor($b->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->type)->toBe('hypercite_paired');
    expect($rows[0]->actor)->toBe($a->name);       // the publisher
    expect($rows[0]->citing_ref)->toBe("/{$citingBook}#hypercite_z");
});

test('citingBookPublished self-suppresses when the publisher owns the cited book too', function () {
    $a = $this->apiUser();
    $citedBook = $this->makeBook($a, ['visibility' => 'public']);   // A owns BOTH
    $citingBook = $this->makeBook($a, ['visibility' => 'private']);
    seedHypercite($citedBook, 'hypercite_self', $a->name, ["/{$citingBook}#hypercite_s"], 'couple');

    \App\Services\Notifications\NotificationWriter::citingBookPublished($citingBook, $a->name);

    expect(notificationsFor($a->name))->toHaveCount(0);
});

test('citingBookPublished does not false-match a book whose id is a prefix of another', function () {
    $b = $this->apiUser();
    $citedBook = $this->makeBook($b, ['visibility' => 'public']);
    $a = $this->apiUser();
    // Two books, one id a prefix of the other (the LIKE-escape / rootBook check).
    $citing = $this->makeBook($a, ['book' => 'apitest_pfx', 'visibility' => 'private']);
    $other = $this->makeBook($a, ['book' => 'apitest_pfxLONGER', 'visibility' => 'private']);
    seedHypercite($citedBook, 'hypercite_other', $a->name, ["/{$other}#hypercite_o"], 'couple');

    // Publishing the SHORTER-id book must not notify for a cite into the LONGER one.
    \App\Services\Notifications\NotificationWriter::citingBookPublished($citing, $a->name);

    expect(notificationsFor($b->name))->toHaveCount(0);
});

test('citingBookHidden retracts the pairing notifications that name the now-hidden book', function () {
    $b = $this->apiUser();
    $citedBook = $this->makeBook($b, ['visibility' => 'public']);
    $a = $this->apiUser();
    $citingBook = $this->makeBook($a, ['visibility' => 'public']);
    seedHypercite($citedBook, 'hypercite_hide', $a->name, ["/{$citingBook}#hypercite_w"], 'couple');

    DB::connection('pgsql_admin')->table('notifications')->insert([
        'recipient' => $b->name, 'actor' => $a->name, 'type' => 'hypercite_paired',
        'book' => $citedBook, 'root_book' => $citedBook, 'subject_id' => 'hypercite_hide',
        'citing_ref' => "/{$citingBook}#hypercite_w",
        'data' => json_encode(['context_label' => 'your book']), 'created_at' => now(),
    ]);
    expect(notificationsFor($b->name))->toHaveCount(1);

    \App\Services\Notifications\NotificationWriter::citingBookHidden($citingBook);

    expect(notificationsFor($b->name))->toHaveCount(0);
});

test('creating a hypercite with empty citedIN is silent (singles are invisible to the owner)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $this->loginUser();

    $this->postJson('/api/db/hypercites/upsert',
        hypercitePayload($book, 'hypercite_new', [], 'single'))->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(0);
});

test('pairing your own hypercite on your own book is silent', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    seedHypercite($book, 'hypercite_self', $owner->name, [], 'single');

    $this->postJson('/api/db/hypercites/upsert',
        hypercitePayload($book, 'hypercite_self', ['/my_other_book#hypercite_z'], 'couple'))
        ->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(0);
});

/* ─── book liked ──────────────────────────────────────────────────── */

test('liking a book notifies the owner once, even when re-liked', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Likeable']);
    $actor = $this->loginUser();

    $this->postJson("/api/books/{$book}/like")->assertStatus(200);
    $this->postJson("/api/books/{$book}/like")->assertStatus(200); // idempotent re-like

    $rows = notificationsFor($owner->name);
    expect($rows)->toHaveCount(1);
    expect($rows[0]->type)->toBe('like');
    expect($rows[0]->actor)->toBe($actor->name);
    expect($rows[0]->subject_id)->toBeNull();
    $data = json_decode($rows[0]->data, true);
    expect($data['context_label'])->toBe('your book “Likeable”');
});

test('liking your own book and unliking are both silent', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    $this->postJson("/api/books/{$book}/like")->assertStatus(200);
    $this->deleteJson("/api/books/{$book}/like")->assertStatus(200);

    expect(notificationsFor($owner->name))->toHaveCount(0);
});
