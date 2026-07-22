<?php

/**
 * Save-time annotation range recalculation (App\Services\Annotations\CharDataRecalculator).
 *
 * The client only re-measures marks RENDERED in its DOM — annotations that
 * aren't rendered (other users', gated, hidden, unloaded chunks) go stale on
 * every edit. So on every node save the SERVER relocates each hyperlight/
 * hypercite range against the new content:
 *  - text moved (edits elsewhere in the node) → range REWRITTEN to the new offsets
 *  - text deleted → entry TOMBSTONED at charStart/charEnd = -1 (deterministic
 *    ghost marker, entry never removed — the record keeps its node anchor)
 *  - tombstoned text restored (undo) → range RESURRECTED
 * Exercised end-to-end through POST /api/db/nodes/targeted-upsert.
 */

use App\Models\PgHypercite;
use App\Models\PgHyperlight;
use Illuminate\Support\Facades\DB;

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    $admin->table('hyperlights')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('hypercites')->where('book', 'like', 'apitest\_%')->delete();
    $admin->table('nodes')->where('book', 'like', 'apitest\_%')->delete();
    $this->cleanupApiFixtures();
});

// "The quick brown fox jumps over the lazy dog" — "brown fox" = chars 10..19
const RECALC_TEXT = 'The quick brown fox jumps over the lazy dog';
const RECALC_HL = 'brown fox';

function saveNode($test, string $book, string $nodeId, string $text, int $startLine = 100): void
{
    $test->postJson('/api/db/nodes/targeted-upsert', ['data' => [[
        'book' => $book, 'startLine' => $startLine, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p data-node-id="'.$nodeId.'">'.$text.'</p>',
    ]]])->assertStatus(200);
}

function seedRecalcHyperlight(string $book, string $id, array $charData, string $text = RECALC_HL): void
{
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book,
        'hyperlight_id' => $id,
        'sub_book_id' => $book.'/'.$id,
        'node_id' => json_encode(array_keys($charData)),
        'charData' => json_encode($charData),
        'highlightedText' => $text,
        'creator' => 'someone_else_entirely', // NOT the editor — RLS would hide it from an owner-scoped write
        'time_since' => time(),
        'raw_json' => json_encode(['node_id' => array_keys($charData), 'charData' => $charData]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

function readHyperlight(string $book, string $id): PgHyperlight
{
    return PgHyperlight::on('pgsql_admin')->where('book', $book)->where('hyperlight_id', $id)->firstOrFail();
}

test('an edit that shifts text REWRITES the range to the new offsets', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid = $book.'_100_aaaa';
    saveNode($this, $book, $nid, RECALC_TEXT);
    seedRecalcHyperlight($book, 'HL_shift', [$nid => ['charStart' => 10, 'charEnd' => 19]]);

    // Insert "PREFIX " (7 chars) before everything — the highlight moves to 17..26.
    saveNode($this, $book, $nid, 'PREFIX '.RECALC_TEXT);

    $rec = readHyperlight($book, 'HL_shift');
    expect($rec->charData[$nid])->toEqual(['charStart' => 17, 'charEnd' => 26]);
    expect($rec->raw_json['charData'][$nid])->toEqual(['charStart' => 17, 'charEnd' => 26]);
});

test('mid-node deletion of the highlighted text TOMBSTONES the entry at -1/-1', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid = $book.'_100_aaaa';
    saveNode($this, $book, $nid, RECALC_TEXT);
    seedRecalcHyperlight($book, 'HL_dead', [$nid => ['charStart' => 10, 'charEnd' => 19]]);

    // Delete "brown fox " from the middle — the node stays longer than charStart.
    saveNode($this, $book, $nid, 'The quick jumps over the lazy dog');

    $rec = readHyperlight($book, 'HL_dead');
    expect($rec->charData[$nid])->toEqual(['charStart' => -1, 'charEnd' => -1]);
    // The entry is never REMOVED — the record keeps its node anchor for the ghost.
    expect($rec->node_id)->toBe([$nid]);
    expect($rec->raw_json['charData'][$nid])->toEqual(['charStart' => -1, 'charEnd' => -1]);
});

test('restoring the text RESURRECTS a tombstoned entry with a fresh range', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid = $book.'_100_aaaa';
    saveNode($this, $book, $nid, RECALC_TEXT);
    seedRecalcHyperlight($book, 'HL_undo', [$nid => ['charStart' => -1, 'charEnd' => -1]]);

    // The text is present again (undo) — the tombstone resurrects at 10..19.
    saveNode($this, $book, $nid, RECALC_TEXT);

    $rec = readHyperlight($book, 'HL_undo');
    expect($rec->charData[$nid])->toEqual(['charStart' => 10, 'charEnd' => 19]);
});

test('multi-node highlight: only the edited node\'s entry is tombstoned', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nidA = $book.'_100_aaaa';
    $nidB = $book.'_200_bbbb';
    saveNode($this, $book, $nidA, RECALC_TEXT, 100);
    saveNode($this, $book, $nidB, 'and the brown fox continues here', 200);
    seedRecalcHyperlight($book, 'HL_multi', [
        $nidA => ['charStart' => 10, 'charEnd' => 19],
        $nidB => ['charStart' => 8, 'charEnd' => 17],
    ]);

    // Delete the phrase from node A only; node B is not part of this save.
    saveNode($this, $book, $nidA, 'The quick jumps over the lazy dog', 100);

    $rec = readHyperlight($book, 'HL_multi');
    expect($rec->charData[$nidA])->toEqual(['charStart' => -1, 'charEnd' => -1]);
    expect($rec->charData[$nidB])->toEqual(['charStart' => 8, 'charEnd' => 17]);
});

test('repeated phrases relocate to the occurrence NEAREST the old position', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid = $book.'_100_aaaa';
    // "one fish two fish red fish" — "fish" at 4, 13, 22; highlight the middle one.
    saveNode($this, $book, $nid, 'one fish two fish red fish');
    seedRecalcHyperlight($book, 'HL_near', [$nid => ['charStart' => 13, 'charEnd' => 17]], 'fish');

    // "X " shifts everything by 2 — occurrences now 6, 15, 24; nearest to 13 is 15.
    saveNode($this, $book, $nid, 'X one fish two fish red fish');

    $rec = readHyperlight($book, 'HL_near');
    expect($rec->charData[$nid])->toEqual(['charStart' => 15, 'charEnd' => 19]);
});

test('hypercite ranges are recalculated the same way (shift + tombstone)', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid = $book.'_100_aaaa';
    saveNode($this, $book, $nid, RECALC_TEXT);
    DB::connection('pgsql_admin')->table('hypercites')->insert([
        'book' => $book,
        'hyperciteId' => 'hypercite_rc1',
        'node_id' => json_encode([$nid]),
        'charData' => json_encode([$nid => ['charStart' => 10, 'charEnd' => 19]]),
        'hypercitedText' => RECALC_HL,
        'relationshipStatus' => 'single',
        'citedIN' => json_encode([]),
        'creator' => 'someone_else_entirely',
        'time_since' => time(),
        'raw_json' => json_encode(['node_id' => [$nid], 'charData' => [$nid => ['charStart' => 10, 'charEnd' => 19]]]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    saveNode($this, $book, $nid, 'PREFIX '.RECALC_TEXT);
    $rec = PgHypercite::on('pgsql_admin')->where('book', $book)->where('hyperciteId', 'hypercite_rc1')->firstOrFail();
    expect($rec->charData[$nid])->toEqual(['charStart' => 17, 'charEnd' => 26]);

    saveNode($this, $book, $nid, 'The quick jumps over the lazy dog');
    $rec = PgHypercite::on('pgsql_admin')->where('book', $book)->where('hyperciteId', 'hypercite_rc1')->firstOrFail();
    expect($rec->charData[$nid])->toEqual(['charStart' => -1, 'charEnd' => -1]);
});

test('annotations on nodes NOT in the save are left untouched', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nidA = $book.'_100_aaaa';
    $nidOther = $book.'_300_cccc'; // never saved in the edit request
    saveNode($this, $book, $nidA, RECALC_TEXT, 100);
    seedRecalcHyperlight($book, 'HL_other', [$nidOther => ['charStart' => 5, 'charEnd' => 9]]);

    saveNode($this, $book, $nidA, 'PREFIX '.RECALC_TEXT, 100);

    $rec = readHyperlight($book, 'HL_other');
    expect($rec->charData[$nidOther])->toEqual(['charStart' => 5, 'charEnd' => 9]);
});

test('renumbering a node refreshes the stored startLine on its single-node hyperlights', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid = $book.'_100_aaaa';
    saveNode($this, $book, $nid, RECALC_TEXT, 100);
    seedRecalcHyperlight($book, 'HL_renum', [$nid => ['charStart' => 10, 'charEnd' => 19]]);

    // Same node_id, same content, NEW startLine — a renumber. The unrendered
    // highlight's stored startLine would drift forever without the refresh.
    saveNode($this, $book, $nid, RECALC_TEXT, 550);

    $rec = readHyperlight($book, 'HL_renum');
    expect((string) $rec->startLine)->toBe('550');
    expect($rec->raw_json['startLine'])->toBe('550');
    // Ranges untouched — the text didn't change.
    expect($rec->charData[$nid])->toEqual(['charStart' => 10, 'charEnd' => 19]);
});

test('hyperlight upsert persists the ghost anchor into its dedicated column', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid = $book.'_100_aaaa';
    $anchor = $book.'_050_zzzz';
    saveNode($this, $book, $nid, RECALC_TEXT);

    // Tombstone update from the client: carries _ghost_anchor_node (IDB field name).
    $this->postJson('/api/db/hyperlights/upsert', ['data' => [[
        'book' => $book,
        'hyperlight_id' => 'HL_anchor',
        'node_id' => [$nid],
        'charData' => [$nid => ['charStart' => -1, 'charEnd' => -1]],
        'highlightedText' => RECALC_HL,
        '_ghost_anchor_node' => $anchor,
        'time_since' => time(),
    ]]])->assertStatus(200);

    $rec = PgHyperlight::where('book', $book)->where('hyperlight_id', 'HL_anchor')->first();
    expect($rec->ghost_anchor_node)->toBe($anchor);

    // A later payload WITHOUT the key must not wipe the stored anchor.
    $this->postJson('/api/db/hyperlights/upsert', ['data' => [[
        'book' => $book,
        'hyperlight_id' => 'HL_anchor',
        'node_id' => [$nid],
        'charData' => [$nid => ['charStart' => -1, 'charEnd' => -1]],
        'highlightedText' => RECALC_HL,
        'annotation' => 'note added later',
        'time_since' => time(),
    ]]])->assertStatus(200);

    $rec = PgHyperlight::where('book', $book)->where('hyperlight_id', 'HL_anchor')->first();
    expect($rec->ghost_anchor_node)->toBe($anchor);
});

test('deleting the anchor node RE-ANCHORS ghosts server-side to the surviving predecessor', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid25 = $book.'_025_aaaa';
    $nid50 = $book.'_050_bbbb';
    $nid100 = $book.'_100_cccc';
    saveNode($this, $book, $nid25, 'paragraph twenty five', 25);
    saveNode($this, $book, $nid50, 'paragraph fifty', 50);
    saveNode($this, $book, $nid100, 'paragraph one hundred', 100);

    // A ghost anchored to node 50 (its own node long gone).
    DB::connection('pgsql_admin')->table('hyperlights')->insert([
        'book' => $book,
        'hyperlight_id' => 'HL_reanchor',
        'sub_book_id' => $book.'/HL_reanchor',
        'ghost_anchor_node' => $nid50,
        'node_id' => json_encode([$book.'_075_gone']),
        'charData' => json_encode([$book.'_075_gone' => ['charStart' => -1, 'charEnd' => -1]]),
        'highlightedText' => 'ghosted words',
        'creator' => 'someone_else_entirely',
        'time_since' => time(),
        'raw_json' => json_encode([]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // Delete node 50 — the anchor must walk up to node 25's node_id.
    $this->postJson('/api/db/nodes/targeted-upsert', ['data' => [[
        'book' => $book, 'startLine' => 50, '_action' => 'delete',
    ]]])->assertStatus(200);

    $rec = PgHyperlight::on('pgsql_admin')->where('book', $book)->where('hyperlight_id', 'HL_reanchor')->firstOrFail();
    expect($rec->ghost_anchor_node)->toBe($nid25);

    // Delete node 25 — nothing precedes it: anchor cleared, never dangling.
    $this->postJson('/api/db/nodes/targeted-upsert', ['data' => [[
        'book' => $book, 'startLine' => 25, '_action' => 'delete',
    ]]])->assertStatus(200);

    $rec = PgHyperlight::on('pgsql_admin')->where('book', $book)->where('hyperlight_id', 'HL_reanchor')->firstOrFail();
    expect($rec->ghost_anchor_node)->toBeNull();
});

test('entity offsets: text after &nbsp; still relocates correctly', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $nid = $book.'_100_aaaa';
    // textContent coordinates: "A B brown fox tail" — "brown fox" at 4..13
    saveNode($this, $book, $nid, 'A&nbsp;B brown fox tail');
    seedRecalcHyperlight($book, 'HL_ent', [$nid => ['charStart' => 4, 'charEnd' => 13]]);

    // Prepend "Z " (2 chars in textContent) → 6..15.
    saveNode($this, $book, $nid, 'Z A&nbsp;B brown fox tail');

    $rec = readHyperlight($book, 'HL_ent');
    expect($rec->charData[$nid])->toEqual(['charStart' => 6, 'charEnd' => 15]);
});
