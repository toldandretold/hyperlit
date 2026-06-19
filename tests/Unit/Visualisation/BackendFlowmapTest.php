<?php

/**
 * No-drift gate for the backend tier of the full-stack data-flow map.
 *
 * `visualisation/php/collect.php` statically parses routes/api.php + the Db* + DatabaseToIndexedDB
 * controllers and emits `visualisation/generated/backend.generated.json` — the controller tier
 * that visualisation/js/collect.ts stitches onto the route nodes. This mirrors the JS byte-gate
 * (tests/javascript/visualisation/flowViz.generate.test.js) and the app/Python `gen_*` no-drift
 * tests: regenerate in-memory and byte-compare the committed artifact, so a controller change that
 * isn't re-mapped fails CI. Regenerate with `php visualisation/php/collect.php` (or `npm run viz:idb`).
 *
 * Pure static analysis (no DB / no app boot), so this runs in the plain Unit suite.
 */

$REPO = dirname(__DIR__, 3);
$ARTIFACT = $REPO . '/visualisation/generated/backend.generated.json';

// `require` the collector as a library — its CLI main is guarded to run only when invoked
// directly, so this just defines buildBackendMap()/backendMapJson() (no I/O, no shelling out).
require_once $REPO . '/visualisation/php/collect.php';

test('committed backend.generated.json is up to date (run `php visualisation/php/collect.php`)', function () use ($ARTIFACT) {
    expect(file_exists($ARTIFACT))->toBeTrue('backend.generated.json missing — run `php visualisation/php/collect.php`');
    $committed = file_get_contents($ARTIFACT);
    $fresh = backendMapJson();
    expect($fresh)->toBe($committed, 'backend map is stale — run `php visualisation/php/collect.php` and commit');
});

test('backend map derives the model→table seam + the node read/write controllers', function () use ($ARTIFACT) {
    $map = json_decode(file_get_contents($ARTIFACT), true);

    // table attribution is DERIVED from each Pg* model's $table (not hand-coded)
    expect($map['modelTable']['PgNode'])->toBe('nodes');
    expect($map['modelTable']['PgLibrary'])->toBe('library');

    $byId = [];
    foreach ($map['nodes'] as $n) {
        $byId[$n['id']] = $n;
    }

    // READ side: getBookData pulls the author's content, incl. the `nodes` table + the row shape.
    $read = $byId['controller:DatabaseToIndexedDBController@getBookData'] ?? null;
    expect($read)->not->toBeNull();
    expect($read['dir'])->toBe('pull');
    expect($read['tables'])->toContain('nodes');
    expect($read['shape'])->toContain('content')->toContain('startLine')->toContain('chunk_id');

    // WRITE side: the node save the front end calls is the targeted upsert (push → nodes).
    $write = $byId['controller:DbNodeController@targetedUpsert'] ?? null;
    expect($write)->not->toBeNull();
    expect($write['dir'])->toBe('push');
    expect($write['tables'])->toContain('nodes');

    // every controller endpoint normalizes {param}→{} so it joins the JS route key
    foreach ($map['nodes'] as $n) {
        foreach ($n['endpoints'] as $u) {
            expect($u)->toStartWith('/api/')->not->toContain('{bookId}')->not->toContain('{book}');
        }
    }
});
