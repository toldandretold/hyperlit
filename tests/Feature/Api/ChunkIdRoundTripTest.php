<?php

/**
 * Layer 3 of the chunkID coverage (see tests/javascript/divEditor/chunkOverflow.fractional.test.js
 * and indexedDB/chunkId.roundtrip.test.js for the front-end legs): the Postgres round-trip.
 *
 * A fractional chunk_id (e.g. 4.5, minted by the editor's fractional indexing) reaches PG via the
 * sync endpoint and must come back UNCHANGED — decimals are stripped only by explicit renumbering
 * tools (php artisan nodes:renumber / the front-end depth-3 renumber), NEVER by a silent read cast.
 *
 * This asserts:
 *   1. STORAGE is lossless — `nodes.chunk_id` is `double precision`, so 4.5 stays 4.5.
 *   2. READ-BACK preserves decimals for BOTH chunk_id and startLine (`(float)` casts), so a
 *      fractional chunk and its integer neighbour stay DISTINCT (no collapse/collision on reload).
 *   3. A decimal chunk is fetchable ON DEMAND by id (route + getSingleChunk float path).
 *   4. A reading position inside a decimal chunk round-trips (user_reading_positions is now
 *      double precision).
 *
 * Lives under tests/Feature/Api/ to inherit InteractsWithApi (RLS-aware user/book helpers) +
 * the afterEach fixture cleanup, per tests/Pest.php.
 */

use Illuminate\Support\Facades\DB;

afterEach(fn () => $this->cleanupApiFixtures());

test('decimal chunk_id + startLine survive the full PG round-trip (no truncation, no collision)', function () {
    $owner = $this->loginUser();
    // PUBLIC so the (public, token-less) load endpoint can read the nodes back under RLS. Owner
    // still owns the book, so the author-gated upsert write is authorised.
    $book  = $this->makeBook($owner, ['visibility' => 'public']);

    // Three nodes spanning a fractional chunk: chunk 4, the inserted chunk 4.5, and chunk 5 —
    // startLine mirrors chunk_id so we watch BOTH fields independently.
    $payload = [
        'book' => $book,
        'data' => [
            ['book' => $book, 'node_id' => 'n4',  'startLine' => 4,   'chunk_id' => 4,   'content' => '<p>four</p>'],
            ['book' => $book, 'node_id' => 'n45', 'startLine' => 4.5, 'chunk_id' => 4.5, 'content' => '<p>four-and-a-half</p>'],
            ['book' => $book, 'node_id' => 'n5',  'startLine' => 5,   'chunk_id' => 5,   'content' => '<p>five</p>'],
        ],
    ];

    $this->postJson('/api/db/nodes/upsert', $payload)->assertStatus(200);

    // (1) STORAGE — PG kept the decimal.
    $mid = DB::table('nodes')->where('book', $book)->where('node_id', 'n45')->first();
    expect((float) $mid->chunk_id)->toBe(4.5);
    expect((float) $mid->startLine)->toBe(4.5);

    // (2) READ-BACK — the SPA load endpoint returns { nodes: [ {chunk_id, startLine, ...} ], ... }.
    $nodes = $this->getJson("/api/database-to-indexeddb/books/{$book}/data")
        ->assertStatus(200)
        ->json('nodes');

    $byNodeId = collect($nodes)->keyBy('node_id');
    expect($byNodeId)->toHaveKeys(['n4', 'n45', 'n5']);

    // chunk_id AND startLine preserve the decimal (both cast (float) now) ...
    expect($byNodeId['n45']['chunk_id'])->toBe(4.5);
    expect($byNodeId['n45']['startLine'])->toBe(4.5);
    // ... integer chunks still come back as clean integers (PHP json-encodes 4.0 as 4) ...
    expect($byNodeId['n4']['chunk_id'])->toBe(4);
    expect($byNodeId['n5']['chunk_id'])->toBe(5);
    // ... and the fractional chunk stays DISTINCT from its integer neighbour — no collision.
    expect($byNodeId['n45']['chunk_id'])->not->toBe($byNodeId['n4']['chunk_id']);
});

test('a decimal chunk is fetchable on demand by id (route + getSingleChunk float path)', function () {
    $owner = $this->loginUser();
    $book  = $this->makeBook($owner, ['visibility' => 'public']);

    $this->postJson('/api/db/nodes/upsert', [
        'book' => $book,
        'data' => [
            ['book' => $book, 'node_id' => 'n4',  'startLine' => 4,   'chunk_id' => 4,   'content' => '<p>four</p>'],
            ['book' => $book, 'node_id' => 'n45', 'startLine' => 4.5, 'chunk_id' => 4.5, 'content' => '<p>frac</p>'],
        ],
    ])->assertStatus(200);

    // The route now accepts a decimal chunkId (was constrained to [0-9]+ → 404 on "4.5").
    $resp = $this->getJson("/api/database-to-indexeddb/books/{$book}/chunk/4.5")
        ->assertStatus(200)
        ->json();

    $returnedIds = collect($resp['nodes'])->pluck('node_id')->all();
    expect($returnedIds)->toContain('n45');   // the fractional chunk's node ...
    expect($returnedIds)->not->toContain('n4'); // ... and ONLY it (not the integer-4 chunk)
});

test('a reading position inside a decimal chunk round-trips (user_reading_positions is double precision)', function () {
    $owner = $this->loginUser(); // saveReadingPosition needs a user identity
    $book  = $this->makeBook($owner, ['visibility' => 'public']);

    $this->postJson("/api/database-to-indexeddb/books/{$book}/reading-position", ['chunk_id' => 4.5])
        ->assertStatus(200)
        ->assertJson(['success' => true]);

    $this->getJson("/api/database-to-indexeddb/books/{$book}/reading-position")
        ->assertStatus(200)
        ->assertJsonPath('bookmark.chunk_id', 4.5); // NOT 4 — the column + casts preserve the decimal
});
