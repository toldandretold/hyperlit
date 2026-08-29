<?php

/**
 * MatchLocations — the one place that projects a candidate's ranked location
 * list onto the top-level match_* mirror columns, and decides whether a
 * reviewer's chosen location is still the same place after a re-detect.
 */

use App\Services\Hypercites\MatchLocations;

function mlLocation(string $nodeId, int $start, int $end, string $method = 'exact', float $score = 1.0): array
{
    return [
        'node_ids'           => [$nodeId],
        'char_data'          => [$nodeId => ['charStart' => $start, 'charEnd' => $end]],
        'method'             => $method,
        'score'              => $score,
        'cited_content_hash' => sha1($nodeId),
    ];
}

test('mirror projects the chosen location onto the columns every reader already uses', function () {
    $locations = [mlLocation('body', 10, 40), mlLocation('front', 3, 33, 'normalized', 0.95)];

    $mirror = MatchLocations::mirror($locations, 1);

    expect($mirror['match_location_index'])->toBe(1);
    expect(json_decode($mirror['match_node_ids'], true))->toBe(['front']);
    expect(json_decode($mirror['match_char_data'], true))->toBe(['front' => ['charStart' => 3, 'charEnd' => 33]]);
    expect($mirror['match_method'])->toBe('normalized');
    expect($mirror['match_score'])->toBe(0.95);
    // The stale guard travels WITH the location — mint checks the node set that
    // was actually selected, not the one detection happened to rank first.
    expect($mirror['cited_content_hash'])->toBe(sha1('front'));
});

test('an out-of-range index falls back to the top location rather than throwing', function () {
    // A re-detect can shorten the list under a stored pick. A candidate showing
    // the wrong-but-valid location beats one that 500s on read.
    $mirror = MatchLocations::mirror([mlLocation('a', 0, 10)], 5);

    expect($mirror['match_location_index'])->toBe(0);
    expect(json_decode($mirror['match_node_ids'], true))->toBe(['a']);
});

test('an empty list nulls the mirror', function () {
    $mirror = MatchLocations::mirror([], 0);

    expect($mirror['match_node_ids'])->toBeNull();
    expect($mirror['match_char_data'])->toBeNull();
    expect($mirror['match_method'])->toBeNull();
    expect($mirror['cited_content_hash'])->toBeNull();
    expect($mirror['match_location_index'])->toBe(0);
});

test('a location that came back through jsonb is still recognised as the same place', function () {
    // THE trap this class exists to absorb. Postgres jsonb does not preserve
    // object key order — it stores keys sorted by length then bytewise, so a
    // span written {charStart, charEnd} reads back {charEnd, charStart}. PHP's
    // === on arrays IS order-sensitive, so a naive comparison reports "moved"
    // about a location that never moved and silently drops the reviewer's pick
    // on the next detect.
    $fresh = mlLocation('n1', 12, 40);
    $fromPostgres = [
        'node_ids'  => ['n1'],
        'char_data' => ['n1' => ['charEnd' => 40, 'charStart' => 12]], // key order flipped
        'method'    => 'exact',
        'score'     => 1.0,
    ];

    expect($fresh['char_data'] === $fromPostgres['char_data'])->toBeFalse(); // the premise
    expect(MatchLocations::isSamePlace($fresh, $fromPostgres))->toBeTrue();
});

test('sameness is about the PLACE, not the score or the method', function () {
    // A reconvert can tidy the cited text so a normalized hit becomes exact.
    // The reviewer's verdict was about where the passage is.
    $before = mlLocation('n1', 12, 40, 'normalized', 0.95);
    $after = mlLocation('n1', 12, 40, 'exact', 1.0);

    expect(MatchLocations::isSamePlace($before, $after))->toBeTrue();
});

test('a different span in the same node is a different place', function () {
    expect(MatchLocations::isSamePlace(mlLocation('n1', 12, 40), mlLocation('n1', 90, 118)))->toBeFalse();
    expect(MatchLocations::isSamePlace(mlLocation('n1', 12, 40), mlLocation('n2', 12, 40)))->toBeFalse();
});

test('node order within a cross-node location is data, not incidental', function () {
    $forward = ['node_ids' => ['n1', 'n2'], 'char_data' => []];
    $reversed = ['node_ids' => ['n2', 'n1'], 'char_data' => []];

    expect(MatchLocations::isSamePlace($forward, $reversed))->toBeFalse();
});

test('indexOfPlace finds the chosen location wherever ranking moved it', function () {
    $chosen = mlLocation('front', 3, 33);
    $reranked = [mlLocation('body', 10, 40), mlLocation('other', 1, 31), $chosen];

    expect(MatchLocations::indexOfPlace($reranked, $chosen))->toBe(2);
    expect(MatchLocations::indexOfPlace($reranked, mlLocation('gone', 0, 30)))->toBeNull();
});

test('decode tolerates null, a json string, and an already-decoded array', function () {
    expect(MatchLocations::decode(null))->toBe([]);
    expect(MatchLocations::decode('not json'))->toBe([]);
    expect(MatchLocations::decode('[{"node_ids":["a"]}]'))->toBe([['node_ids' => ['a']]]);
    expect(MatchLocations::decode([['node_ids' => ['a']]]))->toBe([['node_ids' => ['a']]]);
});
