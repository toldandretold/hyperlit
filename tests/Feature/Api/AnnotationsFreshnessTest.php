<?php

/**
 * annotations_updated_at is the reader-freshness signal: a reader re-fetches
 * another user's annotations only when the server's value differs from its
 * cached one. Two guarantees are pinned here:
 *
 *  1. The SECURITY DEFINER bump is STRICTLY MONOTONIC — GREATEST(existing+1, ts)
 *     — so a lower-clock write can never LOWER it (the non-monotonic plain-SET
 *     was how a reader's cached value sat above the server's forever, masking
 *     others' highlights until a full IndexedDB wipe; 2026-09-21).
 *  2. Every hyperlight WRITE path (upsert/bulkCreate/delete/hide) bumps it
 *     server-side. It used to rely entirely on the client's Date.now() library
 *     sync — a client clock driving a cross-client freshness gate.
 */

use Illuminate\Support\Facades\DB;

afterEach(fn () => $this->cleanupApiFixtures());

function annotationsTs(string $book): int
{
    // Read on the DEFAULT connection: the write paths bump the value inside the
    // test's (uncommitted) default transaction, which a separate pgsql_admin
    // connection cannot see. The default connection sees committed rows plus its
    // own uncommitted changes.
    return (int) DB::table('library')->where('book', $book)->value('annotations_updated_at');
}

test('update_annotations_timestamp is strictly monotonic — never lowers, always advances', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'annotations_updated_at' => 5000]);

    // A LOWER incoming value must not lower the stored one; it advances by ≥1.
    DB::select('SELECT update_annotations_timestamp(?, ?)', [$book, 3000]);
    expect(annotationsTs($book))->toBe(5001);

    // A HIGHER value wins.
    DB::select('SELECT update_annotations_timestamp(?, ?)', [$book, 9000]);
    expect(annotationsTs($book))->toBe(9000);

    // The SAME value still strictly advances (so a reader always sees a change).
    DB::select('SELECT update_annotations_timestamp(?, ?)', [$book, 9000]);
    expect(annotationsTs($book))->toBe(9001);
});

test('a hyperlight upsert bumps annotations_updated_at server-side (no client clock needed)', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'annotations_updated_at' => 1000]);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/upsert', ['data' => [[
        'book' => $book,
        'hyperlight_id' => 'HL_fresh1',
        'node_id' => [$book.'_100_aaaa'],
        'charData' => [],
        'highlightedText' => 'a highlight',
        // NOTE: no annotations_updated_at sent — the server owns it now.
    ]]])->assertStatus(200);

    expect(annotationsTs($book))->toBeGreaterThan(1000);
});

test('a hyperlight bulkCreate bumps annotations_updated_at server-side', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'annotations_updated_at' => 1000]);
    $this->loginUser();

    $this->postJson('/api/db/hyperlights/bulk-create', ['data' => [[
        'book' => $book,
        'hyperlight_id' => 'HL_bulkfresh',
        'node_id' => json_encode([$book.'_100_aaaa']),
        'charData' => json_encode(new stdClass()),
        'highlightedText' => 'a highlight',
    ]]])->assertStatus(200);

    expect(annotationsTs($book))->toBeGreaterThan(1000);
});

test('a hyperlight delete bumps annotations_updated_at so readers drop it', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'annotations_updated_at' => 1000]);
    $user = $this->loginUser();
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book, 'hyperlight_id' => 'HL_del', 'creator' => $user->name,
        'raw_json' => json_encode([]), 'hidden' => false, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->postJson('/api/db/hyperlights/delete', ['data' => [[
        'book' => $book, 'hyperlight_id' => 'HL_del',
    ]]])->assertStatus(200);

    expect(annotationsTs($book))->toBeGreaterThan(1000);
});

test('a hyperlight hide (owner moderation) bumps annotations_updated_at', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['via' => 'app', 'visibility' => 'public', 'annotations_updated_at' => 1000]);
    $reader = $this->apiUser();
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book, 'hyperlight_id' => 'HL_hidden', 'creator' => $reader->name,
        'raw_json' => json_encode([]), 'hidden' => false, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->postJson('/api/db/hyperlights/hide', ['data' => [[
        'book' => $book, 'hyperlight_id' => 'HL_hidden',
    ]]])->assertStatus(200);

    expect(annotationsTs($book))->toBeGreaterThan(1000);
});
