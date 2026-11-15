<?php

/**
 * A shelf and the books on it have SEPARATE visibilities, and the shelf's two
 * renders have to be honest about the difference.
 *
 *   - The VISITOR render (`shelf_{id}_{sort}_pub`) holds only what a visitor
 *     can open. A non-public member used to ride along as a locked card — a
 *     dead end for the reader, and (because the published /a/ page always
 *     asked for the `_pub` render) for the shelf's own owner too.
 *   - The OWNER render shows every member, a non-public one wearing the
 *     Library's padlock (`libraryCard-private`), and marks the cards the
 *     owner wrote (`libraryCard-own`) — the card menu offers "Make public /
 *     private" only on those.
 *   - Making a shelf public reports how many members did NOT become public
 *     with it (`non_public_books`), and `POST /api/shelves/{id}/publish-books`
 *     is the "yes, make them all public" answer: the owner's own unencrypted
 *     books only, each through the ordinary library upsert.
 *   - Making a shelf PRIVATE is the mirror: it reports the owner's books that
 *     are still public (`public_books`), and `POST …/unpublish-books` hides them.
 *   - Both bulk endpoints work a CHUNK per call and hand back a `next` cursor
 *     (a whole vault-drop shelf in one request was a silent 12 seconds).
 *   - A cached render carries the VERSION of the card markup that built it: a
 *     render cached before the padlock existed was served, padlock-less, until
 *     something happened to flush the shelf.
 *   - A visibility-only upsert (the card menu, MCP) keeps the rest of
 *     `raw_json` — it used to REPLACE it with the three fields it was sent.
 *
 * Fixtures are admin-committed (the render reads via pgsql_admin) and swept in
 * beforeEach, not afterEach: the bulk publish updates a seeded row on the
 * DEFAULT connection, which holds its lock until RefreshDatabase rolls back.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function shVisDb()
{
    return DB::connection('pgsql_admin');
}

function shVisCleanup(): void
{
    $ids = shVisDb()->table('shelves')->where('name', 'LIKE', 'ShVis %')->pluck('id');
    foreach ($ids as $id) {
        shVisDb()->table('nodes')->where('book', 'LIKE', 'shelf_' . $id . '_%')->delete();
        shVisDb()->table('library')->where('book', 'LIKE', 'shelf_' . $id . '_%')->delete();
    }
    if ($ids->isNotEmpty()) {
        shVisDb()->table('shelf_items')->whereIn('shelf_id', $ids)->delete();
        shVisDb()->table('shelves')->whereIn('id', $ids)->delete();
    }
    shVisDb()->table('nodes')->where('book', 'LIKE', 'shvis\_%')->delete();
    shVisDb()->table('library')->where('book', 'LIKE', 'shvis\_%')->delete();
}

beforeEach(fn () => shVisCleanup());
afterEach(fn () => $this->cleanupApiFixtures());

function shVisBook(string $creator, string $title, string $visibility = 'public', bool $encrypted = false): string
{
    $book = 'shvis_' . Str::lower(Str::random(10));
    shVisDb()->table('library')->insert([
        'book' => $book, 'title' => $title, 'visibility' => $visibility, 'has_nodes' => true,
        'encrypted' => $encrypted,
        'creator' => $creator, 'timestamp' => 1000, 'raw_json' => '{}',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    shVisDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $book . '_n1', 'chunk_id' => 0, 'startLine' => 100,
        'content' => '<p id="100" data-node-id="' . $book . '_n1">Body of ' . e($title) . '.</p>',
        'plainText' => 'Body of ' . $title . '.', 'type' => 'p', 'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

function shVisShelf(string $creator, array $books, string $visibility = 'public'): string
{
    $id = (string) Str::uuid();
    shVisDb()->table('shelves')->insert([
        'id' => $id, 'creator' => $creator, 'name' => 'ShVis Shelf ' . Str::lower(Str::random(5)),
        'slug' => 'shvis-' . Str::lower(Str::random(6)), 'visibility' => $visibility, 'default_sort' => 'title',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    foreach ($books as $book) {
        shVisDb()->table('shelf_items')->insert(['shelf_id' => $id, 'book' => $book, 'added_at' => now()]);
    }

    return $id;
}

/** @return array<string, string> card HTML keyed by the member book it is for */
function shVisCards(string $syntheticBook): array
{
    $cards = [];
    foreach (shVisDb()->table('nodes')->where('book', $syntheticBook)->orderBy('startLine')->pluck('content') as $html) {
        if (preg_match('/data-book="([^"]+)"/', $html, $m)) {
            $cards[$m[1]] = $html;
        }
    }

    return $cards;
}

/* ─── the two renders ─────────────────────────────────────────────── */

test('the visitor render holds only public members — nothing is ever a locked card', function () {
    $owner = $this->apiUser();
    $public = shVisBook($owner->name, 'ShVis Alpha Public');
    $private = shVisBook($owner->name, 'ShVis Bravo Private', 'private');
    $shelf = shVisShelf($owner->name, [$public, $private]);

    $synthetic = $this->getJson("/api/public/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId');
    expect($synthetic)->toEndWith('_pub');

    $cards = shVisCards($synthetic);
    expect(array_keys($cards))->toBe([$public]);

    $html = implode('', shVisDb()->table('nodes')->where('book', $synthetic)->pluck('content')->all());
    expect($html)->not->toContain('ShVis Bravo Private')
        ->not->toContain('libraryCard-locked')
        ->not->toContain('libraryCard-private');
});

test('the owner render shows every member, padlocks the non-public ones and marks the owner\'s own', function () {
    $other = $this->apiUser();
    $owner = $this->loginUser();
    $public = shVisBook($owner->name, 'ShVis Alpha Public');
    $private = shVisBook($owner->name, 'ShVis Bravo Private', 'private');
    $theirs = shVisBook($other->name, 'ShVis Charlie Theirs');
    $shelf = shVisShelf($owner->name, [$public, $private, $theirs]);

    $cards = shVisCards($this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId'));
    expect(array_keys($cards))->toBe([$public, $private, $theirs]);

    // The owner can open their private book: a real link, the Library's padlock, no lock-out.
    expect($cards[$private])->toContain('libraryCard-private')
        ->toContain('private-icon')
        ->toContain('href="/' . $private . '"')
        ->not->toContain('libraryCard-locked');
    expect($cards[$public])->not->toContain('libraryCard-private')->not->toContain('private-icon');

    // Only the owner's own books may have their visibility changed from the card menu.
    expect($cards[$public])->toContain('libraryCard-own');
    expect($cards[$private])->toContain('libraryCard-own');
    expect($cards[$theirs])->not->toContain('libraryCard-own');
});

/* ─── making the shelf public ─────────────────────────────────────── */

test('making a shelf public reports the members that did not become public with it, and drops its renders', function () {
    $other = $this->apiUser();
    $owner = $this->loginUser();
    $public = shVisBook($owner->name, 'ShVis Alpha Public');
    $own1 = shVisBook($owner->name, 'ShVis Bravo Private', 'private');
    $own2 = shVisBook($owner->name, 'ShVis Delta Private', 'private');
    $encrypted = shVisBook($owner->name, 'ShVis Echo Encrypted', 'private', true);
    $theirs = shVisBook($other->name, 'ShVis Foxtrot Theirs', 'private');
    $shelf = shVisShelf($owner->name, [$public, $own1, $own2, $encrypted, $theirs], 'private');

    $synthetic = $this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId');
    expect(shVisDb()->table('nodes')->where('book', $synthetic)->exists())->toBeTrue();

    $this->patchJson("/api/shelves/{$shelf}", ['visibility' => 'public'])
        ->assertOk()
        ->assertJson(['success' => true, 'non_public_books' => ['own' => 2, 'encrypted' => 1, 'others' => 1]]);

    // The cached render carried the SHELF's old visibility — gone, to rebuild on next view.
    expect(shVisDb()->table('nodes')->where('book', $synthetic)->exists())->toBeFalse();

    // Only the transition INTO public asks the question.
    $this->patchJson("/api/shelves/{$shelf}", ['visibility' => 'public'])->assertOk()->assertJsonMissingPath('non_public_books');
    $this->patchJson("/api/shelves/{$shelf}", ['default_sort' => 'recent'])->assertOk()->assertJsonMissingPath('non_public_books');
    $this->patchJson("/api/shelves/{$shelf}", ['visibility' => 'private'])->assertOk()->assertJsonMissingPath('non_public_books');
});

test('a shelf made private drops the public render a visitor could still read by id', function () {
    $owner = $this->loginUser();
    $public = shVisBook($owner->name, 'ShVis Alpha Public');
    $shelf = shVisShelf($owner->name, [$public]);

    $pub = $this->getJson("/api/public/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId');
    expect(shVisDb()->table('nodes')->where('book', $pub)->exists())->toBeTrue();

    $this->patchJson("/api/shelves/{$shelf}", ['visibility' => 'private'])->assertOk();

    expect(shVisDb()->table('nodes')->where('book', $pub)->exists())->toBeFalse();
});

/* ─── "make all books within this shelf public" ───────────────────── */

test('publish-books is the shelf owner\'s only', function () {
    $owner = $this->apiUser();
    $private = shVisBook($owner->name, 'ShVis Bravo Private', 'private');
    $shelf = shVisShelf($owner->name, [$private]);

    $this->assertApiError($this->postJson("/api/shelves/{$shelf}/publish-books"), 401);

    $this->loginUser();   // someone else
    $this->assertApiError($this->postJson("/api/shelves/{$shelf}/publish-books"), 404);

    expect(shVisDb()->table('library')->where('book', $private)->value('visibility'))->toBe('private');
});

test('publish-books publishes the owner\'s own books and leaves encrypted and other people\'s alone', function () {
    config(['publishing.verified_email_required_after' => null]);
    $other = $this->apiUser();
    $owner = $this->loginUser();
    $own1 = shVisBook($owner->name, 'ShVis Bravo Private', 'private');
    $own2 = shVisBook($owner->name, 'ShVis Delta Private', 'private');
    $already = shVisBook($owner->name, 'ShVis Alpha Public');
    $encrypted = shVisBook($owner->name, 'ShVis Echo Encrypted', 'private', true);
    $theirs = shVisBook($other->name, 'ShVis Foxtrot Theirs', 'private');
    $shelf = shVisShelf($owner->name, [$own1, $own2, $already, $encrypted, $theirs]);

    $this->postJson("/api/shelves/{$shelf}/publish-books")
        ->assertOk()
        ->assertExactJson([
            'success' => true,
            'published' => 2,
            'failed' => 0,
            'skipped' => ['not_owned' => 1, 'encrypted' => 1],
            'publish_denied' => null,
            'remaining' => 0,
            'next' => null,
        ]);

    // Read back on the DEFAULT connection (the writes sit in the test transaction).
    $now = DB::table('library')->whereIn('book', [$own1, $own2, $already, $encrypted])->pluck('visibility', 'book');
    expect($now[$own1])->toBe('public')
        ->and($now[$own2])->toBe('public')
        ->and($now[$already])->toBe('public')
        ->and($now[$encrypted])->toBe('private');
    expect(shVisDb()->table('library')->where('book', $theirs)->value('visibility'))->toBe('private');
});

test('publish-books with nothing of the owner\'s to publish is a counted no-op', function () {
    $other = $this->apiUser();
    $owner = $this->loginUser();
    $theirs = shVisBook($other->name, 'ShVis Foxtrot Theirs', 'private');
    $shelf = shVisShelf($owner->name, [$theirs]);

    $this->postJson("/api/shelves/{$shelf}/publish-books")
        ->assertOk()
        ->assertJson(['success' => true, 'published' => 0, 'failed' => 0, 'skipped' => ['not_owned' => 1, 'encrypted' => 0]]);
});

test('publish-books says WHY when the publish gate refuses, and publishes nothing', function () {
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    $owner = $this->loginUser(['email_verified_at' => null, 'created_at' => now()]);
    $private = shVisBook($owner->name, 'ShVis Bravo Private', 'private');
    $shelf = shVisShelf($owner->name, [$private]);

    $this->postJson("/api/shelves/{$shelf}/publish-books")
        ->assertOk()
        ->assertJson(['success' => false, 'published' => 0, 'publish_denied' => 'unverified_email']);

    expect(shVisDb()->table('library')->where('book', $private)->value('visibility'))->toBe('private');
});

/* ─── the bulk change works a chunk per call ──────────────────────── */

test('publish-books handles `limit` books per call and resumes from its own cursor', function () {
    config(['publishing.verified_email_required_after' => null]);
    $owner = $this->loginUser();
    $books = [
        shVisBook($owner->name, 'ShVis Bravo Private', 'private'),
        shVisBook($owner->name, 'ShVis Delta Private', 'private'),
        shVisBook($owner->name, 'ShVis Golf Private', 'private'),
    ];
    $shelf = shVisShelf($owner->name, $books);
    sort($books, SORT_STRING);   // the cursor walks book ids, not shelf order

    $first = $this->postJson("/api/shelves/{$shelf}/publish-books", ['limit' => 1])->assertOk()->json();
    expect($first['published'])->toBe(1)
        ->and($first['remaining'])->toBe(2)
        ->and($first['next'])->toBe($books[0]);

    $second = $this->postJson("/api/shelves/{$shelf}/publish-books", ['limit' => 1, 'after' => $first['next']])->assertOk()->json();
    expect($second['published'])->toBe(1)
        ->and($second['remaining'])->toBe(1)
        ->and($second['next'])->toBe($books[1]);

    $third = $this->postJson("/api/shelves/{$shelf}/publish-books", ['limit' => 1, 'after' => $second['next']])->assertOk()->json();
    expect($third['published'])->toBe(1)
        ->and($third['remaining'])->toBe(0)
        ->and($third['next'])->toBeNull();

    expect(DB::table('library')->whereIn('book', $books)->where('visibility', 'public')->count())->toBe(3);
});

test('a `limit` larger than the chunk is clamped, never honoured', function () {
    config(['publishing.verified_email_required_after' => null]);
    $owner = $this->loginUser();
    $books = [];
    $count = \App\Http\Controllers\ShelfController::BULK_VISIBILITY_CHUNK + 2;
    for ($i = 0; $i < $count; $i++) {
        $books[] = shVisBook($owner->name, 'ShVis Bulk ' . $i, 'private');
    }
    $shelf = shVisShelf($owner->name, $books);

    $json = $this->postJson("/api/shelves/{$shelf}/publish-books", ['limit' => 5000])->assertOk()->json();
    expect($json['published'])->toBe(\App\Http\Controllers\ShelfController::BULK_VISIBILITY_CHUNK)
        ->and($json['remaining'])->toBe(2)
        ->and($json['next'])->not->toBeNull();
});

test('a book that will not change is passed by the cursor, not retried forever', function () {
    config(['publishing.verified_email_required_after' => null]);
    $owner = $this->loginUser();
    $books = [
        shVisBook($owner->name, 'ShVis Bravo Private', 'private'),
        shVisBook($owner->name, 'ShVis Delta Private', 'private'),
    ];
    $shelf = shVisShelf($owner->name, $books);
    sort($books, SORT_STRING);
    // A library clock far ahead of now: the upsert reads the write as stale and no-ops.
    shVisDb()->table('library')->where('book', $books[0])->update(['timestamp' => 9999999999999]);

    $first = $this->postJson("/api/shelves/{$shelf}/publish-books", ['limit' => 1])->assertOk()->json();
    expect($first['published'])->toBe(0)
        ->and($first['failed'])->toBe(1)
        ->and($first['next'])->toBe($books[0]);

    $second = $this->postJson("/api/shelves/{$shelf}/publish-books", ['limit' => 1, 'after' => $first['next']])->assertOk()->json();
    expect($second['published'])->toBe(1)
        ->and($second['failed'])->toBe(0)
        ->and($second['next'])->toBeNull();
});

test('a bulk change leaves no cached render of the shelf behind', function () {
    config(['publishing.verified_email_required_after' => null]);
    $owner = $this->loginUser();
    $private = shVisBook($owner->name, 'ShVis Bravo Private', 'private');
    $shelf = shVisShelf($owner->name, [$private]);

    $ownerRender = $this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId');
    $visitorRender = $this->getJson("/api/public/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId');

    $this->postJson("/api/shelves/{$shelf}/publish-books")->assertOk()->assertJson(['published' => 1]);

    expect(shVisDb()->table('nodes')->whereIn('book', [$ownerRender, $visitorRender])->exists())->toBeFalse();
    expect(shVisDb()->table('library')->whereIn('book', [$ownerRender, $visitorRender])->exists())->toBeFalse();
});

/* ─── making the shelf private: the mirror ────────────────────────── */

test('making a shelf private reports the owner\'s books that are still public', function () {
    $other = $this->apiUser();
    $owner = $this->loginUser();
    $own1 = shVisBook($owner->name, 'ShVis Alpha Public');
    $own2 = shVisBook($owner->name, 'ShVis Bravo Public');
    $hidden = shVisBook($owner->name, 'ShVis Delta Private', 'private');
    $theirs = shVisBook($other->name, 'ShVis Foxtrot Theirs');
    $shelf = shVisShelf($owner->name, [$own1, $own2, $hidden, $theirs]);

    $this->patchJson("/api/shelves/{$shelf}", ['visibility' => 'private'])
        ->assertOk()
        ->assertJson(['success' => true, 'public_books' => ['own' => 2, 'others' => 1]])
        ->assertJsonMissingPath('non_public_books');

    // Only the transition INTO private asks.
    $this->patchJson("/api/shelves/{$shelf}", ['visibility' => 'private'])->assertOk()->assertJsonMissingPath('public_books');
    $this->patchJson("/api/shelves/{$shelf}", ['visibility' => 'public'])->assertOk()->assertJsonMissingPath('public_books');
});

test('unpublish-books is the shelf owner\'s only', function () {
    $owner = $this->apiUser();
    $public = shVisBook($owner->name, 'ShVis Alpha Public');
    $shelf = shVisShelf($owner->name, [$public], 'private');

    $this->assertApiError($this->postJson("/api/shelves/{$shelf}/unpublish-books"), 401);

    $this->loginUser();   // someone else
    $this->assertApiError($this->postJson("/api/shelves/{$shelf}/unpublish-books"), 404);

    expect(shVisDb()->table('library')->where('book', $public)->value('visibility'))->toBe('public');
});

test('unpublish-books hides the owner\'s own public books and leaves other people\'s alone', function () {
    $other = $this->apiUser();
    $owner = $this->loginUser();
    $own1 = shVisBook($owner->name, 'ShVis Alpha Public');
    $own2 = shVisBook($owner->name, 'ShVis Bravo Public');
    $already = shVisBook($owner->name, 'ShVis Delta Private', 'private');
    $theirs = shVisBook($other->name, 'ShVis Foxtrot Theirs');
    $shelf = shVisShelf($owner->name, [$own1, $own2, $already, $theirs], 'private');

    $this->postJson("/api/shelves/{$shelf}/unpublish-books")
        ->assertOk()
        ->assertExactJson([
            'success' => true,
            'unpublished' => 2,
            'failed' => 0,
            'skipped' => ['not_owned' => 1],
            'remaining' => 0,
            'next' => null,
        ]);

    $now = DB::table('library')->whereIn('book', [$own1, $own2, $already])->pluck('visibility', 'book');
    expect($now[$own1])->toBe('private')
        ->and($now[$own2])->toBe('private')
        ->and($now[$already])->toBe('private');
    expect(shVisDb()->table('library')->where('book', $theirs)->value('visibility'))->toBe('public');
});

test('unpublish-books needs no publish gate and is chunked like its mirror', function () {
    // An account the publish gate would refuse can still HIDE its own books.
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    $owner = $this->loginUser(['email_verified_at' => null, 'created_at' => now()]);
    $books = [shVisBook($owner->name, 'ShVis Alpha Public'), shVisBook($owner->name, 'ShVis Bravo Public')];
    $shelf = shVisShelf($owner->name, $books, 'private');
    sort($books, SORT_STRING);

    $first = $this->postJson("/api/shelves/{$shelf}/unpublish-books", ['limit' => 1])->assertOk()->json();
    expect($first['unpublished'])->toBe(1)->and($first['remaining'])->toBe(1)->and($first['next'])->toBe($books[0]);

    $second = $this->postJson("/api/shelves/{$shelf}/unpublish-books", ['limit' => 1, 'after' => $first['next']])->assertOk()->json();
    expect($second['unpublished'])->toBe(1)->and($second['next'])->toBeNull();
});

test('unpublish-books with nothing of the owner\'s public is a counted no-op', function () {
    $other = $this->apiUser();
    $owner = $this->loginUser();
    $theirs = shVisBook($other->name, 'ShVis Foxtrot Theirs');
    $shelf = shVisShelf($owner->name, [$theirs], 'private');

    $this->postJson("/api/shelves/{$shelf}/unpublish-books")
        ->assertOk()
        ->assertJson(['success' => true, 'unpublished' => 0, 'failed' => 0, 'skipped' => ['not_owned' => 1], 'next' => null]);
});

/* ─── a cached render knows which markup built it ─────────────────── */

test('a render cached by older card markup is rebuilt, and the rebuild is one a client refetches', function () {
    $owner = $this->loginUser();
    $private = shVisBook($owner->name, 'ShVis Bravo Private', 'private');
    $shelf = shVisShelf($owner->name, [$private]);

    $synthetic = $this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId');
    $meta = json_decode((string) shVisDb()->table('library')->where('book', $synthetic)->value('raw_json'), true);
    expect($meta['v'] ?? null)->toBe(\App\Http\Controllers\ShelfController::RENDER_VERSION);

    // What prod holds on deploy day: a render from before the padlock, with
    // no version on its row, that no shelf mutation has flushed.
    shVisDb()->table('nodes')->where('book', $synthetic)->update(['content' => '<div class="libraryCard">cached by old code</div>']);
    shVisDb()->table('library')->where('book', $synthetic)->update([
        'raw_json' => json_encode(['type' => 'shelf', 'shelf_id' => $shelf, 'sort' => 'title']),
        'timestamp' => 1000,
    ]);

    expect($this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId'))->toBe($synthetic);

    $cards = shVisCards($synthetic);
    expect($cards[$private] ?? '')->toContain('libraryCard-private')->toContain('private-icon');
    // A NEW timestamp is the only thing that makes an open client drop its
    // IndexedDB copy of the cards and fetch these.
    expect((int) shVisDb()->table('library')->where('book', $synthetic)->value('timestamp'))->toBeGreaterThan(1000);
});

test('a render of the current version stays a cache hit', function () {
    $owner = $this->loginUser();
    $shelf = shVisShelf($owner->name, [shVisBook($owner->name, 'ShVis Alpha Public')]);

    $synthetic = $this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk()->json('bookId');
    shVisDb()->table('nodes')->where('book', $synthetic)->update(['content' => '<div class="libraryCard">still cached</div>']);
    $before = shVisDb()->table('library')->where('book', $synthetic)->value('timestamp');

    $this->getJson("/api/shelves/{$shelf}/render?sort=title")->assertOk();

    expect(shVisDb()->table('nodes')->where('book', $synthetic)->value('content'))->toContain('still cached');
    expect(shVisDb()->table('library')->where('book', $synthetic)->value('timestamp'))->toBe($before);
});

/* ─── the card menu's write ───────────────────────────────────────── */

test('a visibility-only upsert keeps the rest of raw_json', function () {
    config(['publishing.verified_email_required_after' => null]);
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, [
        'via' => 'app',
        'title' => 'ShVis Raw Json',
        'raw_json' => json_encode(['book' => 'placeholder', 'title' => 'ShVis Raw Json', 'bibtex' => '@book{keepme}', 'custom_field' => 'keepme']),
    ]);

    $json = $this->postJson('/api/db/library/upsert', ['data' => [
        'book' => $book, 'visibility' => 'public', 'timestamp' => 2000,
    ]])->assertOk()->json();
    expect($json['library']['visibility'])->toBe('public');

    $raw = DB::table('library')->where('book', $book)->value('raw_json');
    $raw = is_string($raw) ? json_decode($raw, true) : (array) $raw;
    expect($raw['custom_field'] ?? null)->toBe('keepme')
        ->and($raw['bibtex'] ?? null)->toBe('@book{keepme}')
        ->and($raw['visibility'] ?? null)->toBe('public');
});
