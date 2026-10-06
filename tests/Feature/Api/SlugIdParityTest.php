<?php

/**
 * Slug/id parity — a book addressed by its vanity slug must behave EXACTLY like
 * the same book addressed by its raw id, for reads AND writes.
 *
 * The seam is BookSlugHelper::resolve(), called at ~25 entry points (reader
 * HTML, the whole DB→IndexedDB read family, likes, reading telemetry, reading
 * position, OG image, …). Before this file, none of those endpoints were ever
 * tested WITH a slug — a controller that forgot to resolve, or a resolve()
 * regression, would ship green and surface as "my book works at /book_123 but
 * not at /my-title" (or worse: a write filed under the slug string, invisible
 * to every id-keyed read). Writes are the scary half, so the like / telemetry /
 * reading-position tests cross-address deliberately: write via slug, read via
 * id, and vice versa — the two spellings must hit ONE row.
 *
 * Also pinned: the reader shell invariant the SPA depends on (<main id> is the
 * RAW id even on a slug URL, with the slug only in data-slug — see the
 * slug-vs-mainid cross-book bug), and that a slug grants no more access than
 * the id (private book: both spellings 403 identically).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    $this->cleanupApiFixtures();
    // nodes rows aren't covered by the shared cleanup (and are admin-committed).
    DB::connection('pgsql_admin')->table('nodes')->where('book', 'like', 'apitest\_%')->delete();
});

/**
 * Seed a public slugged book with a heading + body nodes across two chunks.
 * Direct admin-connection inserts (the trait helpers are protected, so a global
 * Pest helper can't reach them — same pattern as BookCanonicalTest). The
 * creator is a bare name string matching the suite's api_test_ cleanup prefix.
 */
function seedParityBook(array $attrs = []): array
{
    $slug = 'apitest-parity-' . strtolower(Str::random(8));
    $book = 'apitest_' . Str::random(12);

    $admin = DB::connection('pgsql_admin');
    $admin->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'Parity Test Book',
        'author' => 'Test Author',
        'visibility' => 'public',
        'slug' => $slug,
        'creator' => 'api_test_parity_' . Str::random(6),
        'creator_token' => null,
        'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $attrs));
    $rows = [
        ['startLine' => '1', 'chunk_id' => 0, 'type' => 'h1', 'content' => '<h1>Parity Test Book</h1>', 'plainText' => 'Parity Test Book'],
        ['startLine' => '100', 'chunk_id' => 0, 'type' => 'p', 'content' => '<p>First chunk body.</p>', 'plainText' => 'First chunk body.'],
        ['startLine' => '200', 'chunk_id' => 1, 'type' => 'p', 'content' => '<p>Second chunk body.</p>', 'plainText' => 'Second chunk body.'],
    ];
    foreach ($rows as $i => $row) {
        $admin->table('nodes')->insert($row + [
            'book' => $book, 'node_id' => "{$book}_n{$i}",
            'footnotes' => json_encode([]),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    return [$book, $slug];
}

/** Strip per-response stamps (generated_at) so parity compares CONTENT, not clocks. */
function withoutResponseStamps(array $payload): array
{
    unset($payload['generated_at']);
    foreach ($payload as $k => $v) {
        if (is_array($v)) {
            $payload[$k] = withoutResponseStamps($v);
        }
    }

    return $payload;
}

/* ─── reads: same payload whichever spelling the URL carries ──────── */

test('every DB→IndexedDB read returns an identical payload for slug and id', function (string $suffix) {
    [$book, $slug] = seedParityBook();

    // Prime once by id so both compared calls see the same file-cache state
    // (a MISS can schedule a warm; comparing MISS-vs-HIT would flake).
    $this->getJson("/api/database-to-indexeddb/books/{$book}/{$suffix}");

    $byId = $this->getJson("/api/database-to-indexeddb/books/{$book}/{$suffix}")
        ->assertStatus(200)->json();
    $bySlug = $this->getJson("/api/database-to-indexeddb/books/{$slug}/{$suffix}")
        ->assertStatus(200)->json();

    expect(withoutResponseStamps($bySlug))->toEqual(withoutResponseStamps($byId));
})->with([
    'data',
    'initial',
    'headings',
    'data/batch',
    'chunk/0',
    'library',
]);

test('the reader page renders the SAME shell for slug and id URLs: raw id in <main id>, slug in data-slug', function () {
    [$book, $slug] = seedParityBook();

    foreach (["/{$slug}", "/{$book}"] as $variant) {
        $html = $this->get($variant)->assertStatus(200)->getContent();
        // The SPA's book identity comes from <main id> — it must be the RAW id
        // even when the address bar shows the slug (slug-vs-mainid invariant)…
        expect($html)->toContain('id="' . $book . '"');
        // …and the slug must ride along in data-slug on BOTH spellings, or the
        // popstate same-book test misfires and full-reloads on container close.
        expect($html)->toContain('data-slug="' . $slug . '"');
    }
});

test('the OG card serves identical bytes for slug and id', function () {
    [$book, $slug] = seedParityBook();

    $byId = $this->get("/og/{$book}.png")->assertStatus(200);
    $bySlug = $this->get("/og/{$slug}.png")->assertStatus(200);

    expect($bySlug->getContent())->toBe($byId->getContent());
});

/* ─── writes: both spellings land on ONE row ──────────────────────── */

test('a like placed via the slug is visible via the id, and removable via either', function () {
    [$book, $slug] = seedParityBook();
    $this->loginUser();

    $this->postJson("/api/books/{$slug}/like")->assertStatus(200);

    // The row is keyed by the RESOLVED id, never the slug string. (The public
    // `count` reads via pgsql_admin, which can't see this test-transaction row
    // — so parity is asserted on `liked` and the row itself instead.)
    $this->assertDatabaseHas('book_likes', ['book' => $book]);
    $this->assertDatabaseMissing('book_likes', ['book' => $slug]);

    // Readable through the OTHER spelling…
    $this->getJson("/api/books/{$book}/likes")
        ->assertStatus(200)->assertJson(['liked' => true]);

    // …and liking again via the id is the idempotent no-op, not a second row.
    $this->postJson("/api/books/{$book}/like")->assertStatus(200);
    expect(DB::table('book_likes')->where('book', $book)->count())->toBe(1);

    // The unlike crosses spellings too.
    $this->deleteJson("/api/books/{$book}/like")->assertStatus(200);
    $this->getJson("/api/books/{$slug}/likes")
        ->assertStatus(200)->assertJson(['liked' => false]);
    $this->assertDatabaseMissing('book_likes', ['book' => $book]);
});

test('reading telemetry posted via the slug files under the id (never a slug-keyed row)', function () {
    [$book, $slug] = seedParityBook();
    $user = $this->loginUser();

    $this->postJson("/api/database-to-indexeddb/books/{$slug}/read-telemetry", ['chunks' => [0]])
        ->assertStatus(200);

    $this->assertDatabaseHas('book_reads', ['book' => $book, 'user_name' => $user->name]);
    $this->assertDatabaseMissing('book_reads', ['book' => $slug]);

    // A follow-up via the raw id merges into the SAME daily row, not a second one.
    $this->postJson("/api/database-to-indexeddb/books/{$book}/read-telemetry", ['chunks' => [0, 1]])
        ->assertStatus(200);
    expect(DB::table('book_reads')->where('book', $book)->where('user_name', $user->name)->count())->toBe(1);
});

test('a reading position saved via the slug is the one returned via the id, and vice versa', function () {
    [$book, $slug] = seedParityBook();
    $this->loginUser();

    $this->postJson("/api/database-to-indexeddb/books/{$slug}/reading-position", [
        'chunk_id' => 1, 'element_id' => '200',
    ])->assertStatus(200);

    $this->getJson("/api/database-to-indexeddb/books/{$book}/reading-position")
        ->assertStatus(200)
        ->assertJson(['bookmark' => ['chunk_id' => 1, 'element_id' => '200']]);

    // Overwrite through the id, read back through the slug — still one bookmark.
    $this->postJson("/api/database-to-indexeddb/books/{$book}/reading-position", [
        'chunk_id' => 0, 'element_id' => '100',
    ])->assertStatus(200);

    $this->getJson("/api/database-to-indexeddb/books/{$slug}/reading-position")
        ->assertStatus(200)
        ->assertJson(['bookmark' => ['chunk_id' => 0, 'element_id' => '100']]);
});

/* ─── access control: a slug grants nothing the id doesn't ────────── */

test('a PRIVATE book refuses slug and id identically (the slug leaks no access)', function () {
    [$book, $slug] = seedParityBook(['visibility' => 'private']);

    foreach (['data', 'initial', 'data/batch'] as $suffix) {
        $byId = $this->getJson("/api/database-to-indexeddb/books/{$book}/{$suffix}");
        $bySlug = $this->getJson("/api/database-to-indexeddb/books/{$slug}/{$suffix}");
        expect($bySlug->getStatusCode())->toBe($byId->getStatusCode());
        expect($byId->getStatusCode())->toBe(403);
        expect($bySlug->json())->toEqual($byId->json());
    }
});
