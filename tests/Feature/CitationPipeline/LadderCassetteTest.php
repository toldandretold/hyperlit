<?php

/**
 * The characterisation harness has to be trustworthy before it can be used to justify a refactor
 * of the wave ladder, so its two load-bearing properties are pinned here.
 *
 * 1. A REPLAY MISS IS LOUD. The whole value of the golden is that "the ladder asked a question it
 *    did not ask before" is a FINDING. A cassette that silently returned an empty result on a miss
 *    would convert every such change into a passing diff, which is worse than having no harness —
 *    it would launder a behaviour change as a green run.
 *
 * 2. RE-BATCHING DOES NOT MISS. The wave extraction will certainly change how citations are grouped
 *    into batch calls — that is most of what moving a wave into its own class does. The batch APIs
 *    are keyed by referenceId in and out (`WorksApi::searchBatch`), so the cassette stores one entry
 *    per KEY. If it stored one per CALL, the first re-batch would invalidate the entire recording at
 *    exactly the moment it is needed.
 */

use App\Services\CitationPipeline\Testing\LadderCassette;

function tmpCassettePath(): string
{
    return sys_get_temp_dir() . '/ladder-cassette-' . bin2hex(random_bytes(6)) . '.json';
}

// ── Per-key batching ─────────────────────────────────────────────────────────

test('a recording made in one batch replays through any other batching', function () {
    $recorder = LadderCassette::recording();

    // Recorded as ONE call over three references...
    $recorder->throughBatch('OpenAlex::searchBatch', ['r1' => 'Marx', 'r2' => 'Cox', 'r3' => 'Amin'], [], ['limit' => 5],
        fn () => ['r1' => ['id' => 'W1'], 'r2' => ['id' => 'W2'], 'r3' => ['id' => 'W3']]);

    $path = tmpCassettePath();
    $recorder->save($path);

    // ...and replayed as THREE separate calls, the way a per-wave class would issue them.
    $replayer = LadderCassette::replaying($path);
    $never = fn () => throw new RuntimeException('replay must not call the real service');

    expect($replayer->throughBatch('OpenAlex::searchBatch', ['r2' => 'Cox'], [], ['limit' => 5], $never))
        ->toBe(['r2' => ['id' => 'W2']])
        ->and($replayer->throughBatch('OpenAlex::searchBatch', ['r3' => 'Amin', 'r1' => 'Marx'], [], ['limit' => 5], $never))
        ->toBe(['r3' => ['id' => 'W3'], 'r1' => ['id' => 'W1']])
        ->and($replayer->stats()['misses'])->toBe(0);

    unlink($path);
});

test('a reference that found nothing replays as absent, not as a null candidate', function () {
    // The live batch omits a no-hit key entirely. A present-but-null entry would reach the scoring
    // code as if it were a candidate, which is a fabricated match.
    $recorder = LadderCassette::recording();
    $recorder->throughBatch('OpenAlex::searchBatch', ['hit' => 'a', 'nohit' => 'b'], [], [],
        fn () => ['hit' => ['id' => 'W1']]);

    $path = tmpCassettePath();
    $recorder->save($path);

    $result = LadderCassette::replaying($path)->throughBatch(
        'OpenAlex::searchBatch', ['hit' => 'a', 'nohit' => 'b'], [], [],
        fn () => throw new RuntimeException('must not call through')
    );

    expect($result)->toBe(['hit' => ['id' => 'W1']])
        ->and($result)->not->toHaveKey('nohit');

    unlink($path);
});

test('a per-key argument is part of the key — the same title with a year filter is a new question', function () {
    $recorder = LadderCassette::recording();
    $recorder->throughBatch('OpenAlex::searchBatch', ['r1' => 'Capital'], ['r1' => 1867], [],
        fn () => ['r1' => ['id' => 'W-filtered']]);

    $path = tmpCassettePath();
    $recorder->save($path);

    // Same reference, same title, NO year filter — Phase B's retry. A different question.
    expect(fn () => LadderCassette::replaying($path)->throughBatch(
        'OpenAlex::searchBatch', ['r1' => 'Capital'], [], [], fn () => ['r1' => null]
    ))->toThrow(RuntimeException::class);

    unlink($path);
});

// ── Misses are loud ──────────────────────────────────────────────────────────

test('a scalar miss throws rather than inventing a result', function () {
    $path = tmpCassettePath();
    LadderCassette::recording()->save($path);

    expect(fn () => LadderCassette::replaying($path)->through('WebTextAcquirer::acquire', ['https://x.test'], fn () => []))
        ->toThrow(RuntimeException::class, 'Cassette miss');

    unlink($path);
});

test('lenient mode collects every batch miss instead of stopping at the first', function () {
    // During the extraction you want the FULL list of what changed, not a one-at-a-time crawl.
    $path = tmpCassettePath();
    LadderCassette::recording()->save($path);

    $replayer = LadderCassette::replaying($path, strict: false);
    $result = $replayer->throughBatch('OpenAlex::searchBatch', ['a' => 1, 'b' => 2, 'c' => 3], [], [],
        fn () => throw new RuntimeException('must not call through'));

    expect($result)->toBe([])
        ->and($replayer->misses())->toHaveCount(3)
        ->and(array_column($replayer->misses(), 'key'))->toBe(['a', 'b', 'c']);

    unlink($path);
});

// ── Keying ───────────────────────────────────────────────────────────────────

test('argument order in a keyed map does not change the key, but content does', function () {
    // Batch APIs are keyed maps; a re-batch reorders them and that is not a different question.
    expect(LadderCassette::keyFor('m', [['b' => 2, 'a' => 1]]))
        ->toBe(LadderCassette::keyFor('m', [['a' => 1, 'b' => 2]]))
        ->and(LadderCassette::keyFor('m', [['a' => 1]]))
        ->not->toBe(LadderCassette::keyFor('m', [['a' => 2]]));
});

test('a list argument keeps its order significant', function () {
    // Unlike a keyed map, a positional list can carry meaning in its order.
    expect(LadderCassette::keyFor('m', [[1, 2]]))->not->toBe(LadderCassette::keyFor('m', [[2, 1]]));
});

test('replaying refuses a cassette from a different format version', function () {
    $path = tmpCassettePath();
    file_put_contents($path, json_encode(['version' => 99, 'entries' => []]));

    expect(fn () => LadderCassette::replaying($path))->toThrow(RuntimeException::class, 'version');

    unlink($path);
});

test('a saved cassette is key-sorted so a re-record diffs as a change, not a reshuffle', function () {
    $recorder = LadderCassette::recording();
    foreach (['zebra', 'alpha', 'middle'] as $u) {
        $recorder->through('WebTextAcquirer::acquire', [$u], fn () => ['text' => $u]);
    }

    $path = tmpCassettePath();
    $recorder->save($path);

    $keys = array_keys(json_decode((string) file_get_contents($path), true)['entries']);
    $sorted = $keys;
    sort($sorted);

    expect($keys)->toBe($sorted);

    unlink($path);
});
