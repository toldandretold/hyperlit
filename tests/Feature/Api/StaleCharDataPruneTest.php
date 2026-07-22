<?php

/**
 * Incoming-payload charData pruning (App\Services\Annotations\StaleCharDataPruner).
 *
 * Before a hyperlight/hypercite upsert persists a client payload, entries that
 * are PROVABLY impossible against stored node text (charStart >= length) are
 * stripped — a stale client re-syncing its un-pruned copy must not re-introduce
 * dead ranges. Never below one remaining entry.
 *
 * (The STORED-side reconciliation moved to CharDataRecalculator — full range
 * relocation + -1/-1 tombstoning at node-save time; see CharDataRecalcTest.)
 */

use App\Models\PgHyperlight;
use Illuminate\Support\Facades\DB;

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    $admin->table('hyperlights')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('hypercites')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('nodes')->where('book', 'like', 'apitest\_%')->delete();
    $this->cleanupApiFixtures();
});

/** Seed two nodes through the real endpoint: A short (~10 chars), B longer. */
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

test('incoming prune never removes the last remaining entry', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    [$nidA] = seedPrunerNodes($this, $book);

    $this->postJson('/api/db/hyperlights/upsert', ['data' => [[
        'book' => $book,
        'hyperlight_id' => 'HL_solo',
        'node_id' => [$nidA],
        'charData' => [$nidA => ['charStart' => 500, 'charEnd' => 510]],
        'highlightedText' => 'gone words',
        'time_since' => time(),
    ]]])->assertStatus(200);

    $rec = PgHyperlight::where('book', $book)->where('hyperlight_id', 'HL_solo')->first();
    expect($rec->node_id)->toBe([$nidA]);
    expect(array_keys($rec->charData))->toBe([$nidA]);
});
