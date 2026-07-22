<?php

/**
 * Save-time stale charData reconciliation (App\Services\Annotations\StaleCharDataPruner).
 *
 * A hyperlight/hypercite stores per-node character ranges. When a node edit makes a
 * range provably impossible (charStart beyond the node's text), the CLIENT can't clean
 * it — a mark absent from its DOM is ambiguous (gates, hidden anon highlights, display
 * toggles). The SERVER reconciles at save time instead. These tests pin the two seams:
 *
 *  - node save (targeted-upsert) prunes STORED records referencing the saved nodes
 *  - hyperlight upsert strips impossible entries from INCOMING payloads (a stale
 *    client copy must not re-introduce a pruned fossil)
 *
 * and the safety rule: a record is never pruned to zero entries.
 */

use App\Models\PgHypercite;
use App\Models\PgHyperlight;
use Illuminate\Support\Facades\DB;

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    // Annotations + nodes seeded/committed outside the default-connection test
    // transaction (admin seeds, pruner admin writes) — clear them explicitly.
    $admin->table('hyperlights')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('hypercites')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('nodes')->where('book', 'like', 'apitest\_%')->delete();
    $this->cleanupApiFixtures();
});

/**
 * Seed two nodes through the real endpoint: A is short (~10 chars), B holds the
 * validly-highlighted phrase. Returns [$nidA, $nidB].
 */
function seedPrunerNodes($test, string $book): array
{
    $nidA = $book.'_100_aaaa';
    $nidB = $book.'_200_bbbb';
    $test->postJson('/api/db/nodes/targeted-upsert', ['data' => [
        ['book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nidA,
            'content' => '<p data-node-id="'.$nidA.'">short text</p>'],
        ['book' => $book, 'startLine' => 200, 'chunk_id' => 0, 'node_id' => $nidB,
            'content' => '<p data-node-id="'.$nidB.'">the phrase from below lives right here</p>'],
    ]])->assertStatus(200);

    return [$nidA, $nidB];
}

function seedHyperlight(string $book, string $id, array $nodeIds, array $charData, string $creator): void
{
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book,
        'hyperlight_id' => $id,
        'sub_book_id' => $book.'/'.$id,
        'node_id' => json_encode($nodeIds),
        'charData' => json_encode($charData),
        'highlightedText' => 'from below',
        'creator' => $creator,
        'time_since' => time(),
        'raw_json' => json_encode(['node_id' => $nodeIds, 'charData' => $charData, 'hyperlight_id' => $id]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

test('node save prunes a stored hyperlight entry made impossible by the new content', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    [$nidA, $nidB] = seedPrunerNodes($this, $book);

    // Fossil: entry for node A points past its 10-char text; entry for B is valid.
    seedHyperlight($book, 'HL_stale1', [$nidA, $nidB], [
        $nidA => ['charStart' => 500, 'charEnd' => 510],
        $nidB => ['charStart' => 11, 'charEnd' => 21],
    ], $user->name);

    // Re-save node A (any content shorter than charStart 500) → prune fires.
    $this->postJson('/api/db/nodes/targeted-upsert', ['data' => [
        ['book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nidA,
            'content' => '<p data-node-id="'.$nidA.'">short text edited</p>'],
    ]])->assertStatus(200);

    $rec = PgHyperlight::on('pgsql_admin')->where('book', $book)->where('hyperlight_id', 'HL_stale1')->first();
    expect($rec->node_id)->toBe([$nidB]);
    // toEqual: jsonb normalizes key order inside entries (charEnd before charStart)
    expect($rec->charData)->toEqual([$nidB => ['charStart' => 11, 'charEnd' => 21]]);
    // raw_json mirror — the read API returns it, a stale copy there would resurrect the fossil
    expect($rec->raw_json['node_id'])->toBe([$nidB]);
    expect(array_keys($rec->raw_json['charData']))->toBe([$nidB]);
});

test('a record is never pruned to zero entries (single-node impossible entry survives)', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    [$nidA] = seedPrunerNodes($this, $book);

    seedHyperlight($book, 'HL_solo', [$nidA], [
        $nidA => ['charStart' => 500, 'charEnd' => 510],
    ], $user->name);

    $this->postJson('/api/db/nodes/targeted-upsert', ['data' => [
        ['book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nidA,
            'content' => '<p data-node-id="'.$nidA.'">short text edited</p>'],
    ]])->assertStatus(200);

    // Untouched: undo restoring the original text can still resurrect this highlight.
    $rec = PgHyperlight::on('pgsql_admin')->where('book', $book)->where('hyperlight_id', 'HL_solo')->first();
    expect($rec->node_id)->toBe([$nidA]);
    expect(array_keys($rec->charData))->toBe([$nidA]);
});

test('hyperlight upsert strips impossible entries from the incoming payload', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    [$nidA, $nidB] = seedPrunerNodes($this, $book);

    // A stale client re-syncs its un-pruned copy: entry A impossible, entry B valid.
    $this->postJson('/api/db/hyperlights/upsert', ['data' => [[
        'book' => $book,
        'hyperlight_id' => 'HL_incoming',
        'node_id' => [$nidA, $nidB],
        'charData' => [
            $nidA => ['charStart' => 500, 'charEnd' => 510],
            $nidB => ['charStart' => 11, 'charEnd' => 21],
        ],
        'highlightedText' => 'from below',
        'time_since' => time(),
    ]]])->assertStatus(200);

    // Read via the DEFAULT connection: the endpoint wrote inside the test's
    // RefreshDatabase transaction, invisible to the admin connection.
    $rec = PgHyperlight::where('book', $book)->where('hyperlight_id', 'HL_incoming')->first();
    expect($rec->node_id)->toBe([$nidB]);
    expect(array_keys($rec->charData))->toBe([$nidB]);
    expect($rec->raw_json['node_id'])->toBe([$nidB]);
});

test('node save prunes a stored hypercite entry the same way', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    [$nidA, $nidB] = seedPrunerNodes($this, $book);

    DB::connection('pgsql_admin')->table('hypercites')->insert([
        'book' => $book,
        'hyperciteId' => 'hypercite_stale1',
        'node_id' => json_encode([$nidA, $nidB]),
        'charData' => json_encode([
            $nidA => ['charStart' => 500, 'charEnd' => 510],
            $nidB => ['charStart' => 11, 'charEnd' => 21],
        ]),
        'hypercitedText' => 'from below',
        'relationshipStatus' => 'single',
        'citedIN' => json_encode([]),
        'creator' => $user->name,
        'time_since' => time(),
        'raw_json' => json_encode(['node_id' => [$nidA, $nidB], 'hyperciteId' => 'hypercite_stale1']),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $this->postJson('/api/db/nodes/targeted-upsert', ['data' => [
        ['book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nidA,
            'content' => '<p data-node-id="'.$nidA.'">short text edited</p>'],
    ]])->assertStatus(200);

    $rec = PgHypercite::on('pgsql_admin')->where('book', $book)->where('hyperciteId', 'hypercite_stale1')->first();
    expect($rec->node_id)->toBe([$nidB]);
    expect(array_keys($rec->charData))->toBe([$nidB]);
});

test('entries for nodes the pruner cannot judge are left alone (unknown node, valid ranges)', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    [$nidA, $nidB] = seedPrunerNodes($this, $book);
    $ghost = $book.'_999_gggg'; // never written to nodes — must not be judged

    seedHyperlight($book, 'HL_mixed', [$nidA, $nidB, $ghost], [
        $nidA => ['charStart' => 2, 'charEnd' => 8],      // valid for 10-char node
        $nidB => ['charStart' => 11, 'charEnd' => 21],    // valid
        $ghost => ['charStart' => 9999, 'charEnd' => 10000], // unknown node → not judged
    ], $user->name);

    $this->postJson('/api/db/nodes/targeted-upsert', ['data' => [
        ['book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nidA,
            'content' => '<p data-node-id="'.$nidA.'">short text</p>'],
    ]])->assertStatus(200);

    $rec = PgHyperlight::on('pgsql_admin')->where('book', $book)->where('hyperlight_id', 'HL_mixed')->first();
    expect($rec->node_id)->toBe([$nidA, $nidB, $ghost]);
});
