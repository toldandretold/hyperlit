<?php

/**
 * Hypercite gate parity + the always-on singles filter + pinned deep-link exemptions
 * (DatabaseToIndexedDBController::getHypercites / applyGateFilters / getPinnedHyperciteIds)
 * and the sanitized single-record find endpoint (DbHyperciteController::find).
 *
 * The invariants pinned here:
 *  - Foreign relationshipStatus='single' hypercites are NEVER in bulk payloads (standalone
 *    `hypercites[]` AND embedded `nodes[*].hypercites[]` — both derive from getHypercites()).
 *  - The creator (logged-in OR anon token) always receives their own singles.
 *  - `target=` (on /initial) and `pinned=` exempt specific ids — deep links must render.
 *  - Global default mode now hides AI hypercites (parity with hyperlights); book
 *    gate_defaults override it; mode=all shows AI/anon but still not foreign singles.
 *  - NULL relationshipStatus legacy rows stay visible.
 *  - find never leaks creator_token (top-level or raw_json) and supports scope=record.
 */

use Illuminate\Support\Str;
use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class);

afterEach(function () {
    $this->cleanupRlsFixtures();
    $this->cleanupApiFixtures();
});

/**
 * Seed a public book with one node and a standard cast of hypercites:
 *  - hypercite_single  : foreign 'single' (owned by $other)
 *  - hypercite_couple  : foreign 'couple' (owned by $other)
 * Returns [bookId, nodeId]. Bound to the test case so the protected
 * InteractsWithApi/SeedsRlsFixtures helpers are callable.
 */
function seedHyperciteBook($test, $other): array
{
    $fn = Closure::bind(function ($other) {
        $book = 'apitest_' . Str::random(12);
        $nodeId = "{$book}_n1";
        $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
        $this->seedNode([
            'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
            'content' => '<p>hello hypercite world</p>', 'plainText' => 'hello hypercite world', 'type' => 'p',
        ]);
        $charData = [$nodeId => ['charStart' => 0, 'charEnd' => 5]];
        $this->seedHypercite([
            'book' => $book, 'hyperciteId' => 'hypercite_single', 'node_id' => [$nodeId],
            'charData' => $charData, 'citedIN' => [], 'relationshipStatus' => 'single',
            'creator' => $other->name, 'hypercitedText' => 'hello',
        ]);
        $this->seedHypercite([
            'book' => $book, 'hyperciteId' => 'hypercite_couple', 'node_id' => [$nodeId],
            'charData' => $charData, 'citedIN' => ['/somebook#hypercite_x'], 'relationshipStatus' => 'couple',
            'creator' => $other->name, 'hypercitedText' => 'hello',
        ]);

        return [$book, $nodeId];
    }, $test, get_class($test));

    return $fn($other);
}

/** Collect hyperciteIds from the standalone payload and from every embedded node array. */
function hyperciteIdsFrom(array $json): array
{
    $standalone = array_column($json['hypercites'] ?? [], 'hyperciteId');
    $embedded = [];
    foreach ($json['nodes'] ?? [] as $node) {
        foreach ($node['hypercites'] ?? [] as $hc) {
            $embedded[] = $hc['hyperciteId'];
        }
    }
    return [$standalone, $embedded];
}

/* ─── the always-on singles filter ────────────────────────────────────── */

test('foreign singles are excluded from /data (standalone AND embedded); couples stay', function () {
    $other = $this->apiUser();
    [$book] = seedHyperciteBook($this, $other);

    $json = $this->getJson("/api/database-to-indexeddb/books/{$book}/data")
        ->assertStatus(200)->json();

    [$standalone, $embedded] = hyperciteIdsFrom($json);
    expect($standalone)->not->toContain('hypercite_single')
        ->and($embedded)->not->toContain('hypercite_single')
        ->and($standalone)->toContain('hypercite_couple')
        ->and($embedded)->toContain('hypercite_couple');
});

test('foreign singles are excluded from /annotations too', function () {
    $other = $this->apiUser();
    [$book] = seedHyperciteBook($this, $other);

    $json = $this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json();

    $ids = array_column($json['hypercites'] ?? [], 'hyperciteId');
    expect($ids)->not->toContain('hypercite_single')->and($ids)->toContain('hypercite_couple');
});

test('the logged-in creator always receives their own singles (is_user_hypercite true)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperciteBook($this, $other);
    $this->actingAs($other);

    $json = $this->getJson("/api/database-to-indexeddb/books/{$book}/data")
        ->assertStatus(200)->json();

    [$standalone, $embedded] = hyperciteIdsFrom($json);
    expect($standalone)->toContain('hypercite_single')->and($embedded)->toContain('hypercite_single');
    $single = collect($json['hypercites'])->firstWhere('hyperciteId', 'hypercite_single');
    expect($single['is_user_hypercite'])->toBeTrue();
});

test('an anonymous creator receives their own singles via the anon_token cookie', function () {
    $other = $this->apiUser();
    $anonToken = Str::uuid()->toString();
    $book = 'apitest_' . Str::random(12);
    $nodeId = "{$book}_n1";
    $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
    $this->seedNode([
        'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>anon world</p>', 'plainText' => 'anon world', 'type' => 'p',
    ]);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_anonsingle', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 4]], 'citedIN' => [],
        'relationshipStatus' => 'single', 'creator' => null, 'creator_token' => $anonToken,
    ]);

    // Without the cookie: filtered
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->not->toContain('hypercite_anonsingle');

    // With the cookie: included. GOTCHA: getJson() only sends the test cookie jars when
    // withCredentials() is set (prepareCookiesForJsonRequest returns [] otherwise) — without
    // it the cookie silently never reaches the server and this asserts against nothing.
    $ids = array_column($this->withCredentials()->withUnencryptedCookie('anon_token', $anonToken)
        ->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->toContain('hypercite_anonsingle');
});

test('NULL relationshipStatus legacy rows are still returned to guests', function () {
    $other = $this->apiUser();
    $book = 'apitest_' . Str::random(12);
    $nodeId = "{$book}_n1";
    $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
    $this->seedNode([
        'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>legacy</p>', 'plainText' => 'legacy', 'type' => 'p',
    ]);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_legacynull', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 3]], 'citedIN' => [],
        'relationshipStatus' => null, 'creator' => $other->name,
    ]);

    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->toContain('hypercite_legacynull');
});

/* ─── target / pinned exemptions (deep links must render) ─────────────── */

test('/initial?target= exempts a foreign single from the filter (deep link renders)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperciteBook($this, $other);

    $json = $this->getJson("/api/database-to-indexeddb/books/{$book}/initial?target=hypercite_single")
        ->assertStatus(200)->json();

    $ids = array_column($json['hypercites'] ?? [], 'hyperciteId');
    expect($ids)->toContain('hypercite_single');
    // And the embedded copy on the target chunk's nodes (/initial's node key is `initial_chunk`)
    $embedded = [];
    foreach ($json['initial_chunk'] ?? [] as $node) {
        foreach ($node['hypercites'] ?? [] as $hc) {
            $embedded[] = $hc['hyperciteId'];
        }
    }
    expect($embedded)->toContain('hypercite_single');
});

test('pinned= exempts a foreign single on /annotations', function () {
    $other = $this->apiUser();
    [$book] = seedHyperciteBook($this, $other);

    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?pinned=hypercite_single")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->toContain('hypercite_single');
});

test('garbage pinned values are ignored (no 500, no exemption)', function () {
    $other = $this->apiUser();
    [$book] = seedHyperciteBook($this, $other);

    $garbage = urlencode("';DROP TABLE hypercites;--,not_a_cite,hypercite_bad!chars,,");
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?pinned={$garbage}")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->not->toContain('hypercite_single');
});

test('pinned is capped at 20 ids — an id beyond the cap gets no exemption', function () {
    $other = $this->apiUser();
    [$book] = seedHyperciteBook($this, $other);

    $filler = array_map(fn ($i) => "hypercite_filler{$i}", range(1, 25));
    $pinned = implode(',', array_merge($filler, ['hypercite_single'])); // real id is #26
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?pinned={$pinned}")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->not->toContain('hypercite_single');
});

/* ─── gate parity (shared hideAI/hideAnonymous checkboxes) ────────────── */

test('global default mode now hides AI hypercites (parity with hyperlights)', function () {
    $other = $this->apiUser();
    [$book, $nodeId] = seedHyperciteBook($this, $other);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_ai', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 5]],
        'citedIN' => ['/x#hypercite_y'], 'relationshipStatus' => 'couple', 'creator' => 'AIreview:gpt',
    ]);

    // No gate param, guest → global default
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->not->toContain('hypercite_ai')->and($ids)->toContain('hypercite_couple');
});

test('book gate_defaults hideAI:false overrides the global default (AI cite shows)', function () {
    $other = $this->apiUser();
    [$book, $nodeId] = seedHyperciteBook($this, $other);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_ai', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 5]],
        'citedIN' => ['/x#hypercite_y'], 'relationshipStatus' => 'couple', 'creator' => 'AIreview:gpt',
    ]);
    Illuminate\Support\Facades\DB::connection('pgsql_admin')->table('library')
        ->where('book', $book)
        ->update(['gate_defaults' => json_encode(['hideAI' => false, 'hideAnonymous' => false, 'hideNoAnnotation' => false])]);

    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->toContain('hypercite_ai');
});

test('custom hideAnonymous filters null-creator hypercites', function () {
    $other = $this->apiUser();
    [$book, $nodeId] = seedHyperciteBook($this, $other);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_anon', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 5]],
        'citedIN' => ['/x#hypercite_y'], 'relationshipStatus' => 'couple',
        'creator' => null, 'creator_token' => Str::uuid()->toString(),
    ]);

    $gate = urlencode(json_encode(['mode' => 'custom', 'custom' => ['hideAnonymous' => true]]));
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?gate={$gate}")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->not->toContain('hypercite_anon')->and($ids)->toContain('hypercite_couple');
});

test('mode=all shows AI + anonymous hypercites but STILL not foreign singles', function () {
    $other = $this->apiUser();
    [$book, $nodeId] = seedHyperciteBook($this, $other);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_ai', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 5]],
        'citedIN' => ['/x#hypercite_y'], 'relationshipStatus' => 'couple', 'creator' => 'AIreview:gpt',
    ]);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_anon', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 5]],
        'citedIN' => ['/x#hypercite_y'], 'relationshipStatus' => 'couple',
        'creator' => null, 'creator_token' => Str::uuid()->toString(),
    ]);

    $gate = urlencode(json_encode(['mode' => 'all']));
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?gate={$gate}")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->toContain('hypercite_ai')
        ->and($ids)->toContain('hypercite_anon')
        ->and($ids)->not->toContain('hypercite_single'); // singles filter is NOT gate-wired
});

test('mode=hideAll with pinned= returns only the pinned hypercite', function () {
    $other = $this->apiUser();
    [$book] = seedHyperciteBook($this, $other);

    $gate = urlencode(json_encode(['mode' => 'hideAll']));
    $ids = array_column($this->getJson("/api/database-to-indexeddb/books/{$book}/annotations?gate={$gate}&pinned=hypercite_single")
        ->assertStatus(200)->json('hypercites') ?? [], 'hyperciteId');
    expect($ids)->toBe(['hypercite_single']);
});

/* ─── the find endpoint: sanitization, scope=record, sub-book routing ─── */

test('find never leaks creator_token (top-level nor raw_json) and computes is_user_hypercite', function () {
    $other = $this->apiUser();
    $token = Str::uuid()->toString();
    $book = 'apitest_' . Str::random(12);
    $nodeId = "{$book}_n1";
    $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
    $this->seedNode([
        'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>find me</p>', 'plainText' => 'find me', 'type' => 'p',
    ]);
    // raw_json deliberately carries creator_token — find must strip it from the copy too
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_findme', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 4]], 'citedIN' => [],
        'relationshipStatus' => 'single', 'creator' => null, 'creator_token' => $token,
    ]);

    $this->loginUser(); // find sits in the `author` group — needs an identity
    $json = $this->getJson("/api/db/hypercites/find/{$book}/hypercite_findme")
        ->assertStatus(200)->json();

    expect($json['hypercite'])->not->toHaveKey('creator_token')
        ->and($json['hypercite']['raw_json'] ?? [])->not->toHaveKey('creator_token')
        ->and($json['hypercite'])->toHaveKey('is_user_hypercite')
        ->and($json['hypercite']['is_user_hypercite'])->toBeFalse()
        ->and($json)->toHaveKey('nodes');
});

test('find?scope=record returns the hypercite only (no nodes payload)', function () {
    $other = $this->apiUser();
    $book = 'apitest_' . Str::random(12);
    $nodeId = "{$book}_n1";
    $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
    $this->seedNode([
        'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>rec</p>', 'plainText' => 'rec', 'type' => 'p',
    ]);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_reconly', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 3]], 'citedIN' => [],
        'relationshipStatus' => 'single', 'creator' => $other->name,
    ]);

    $this->loginUser();
    $json = $this->getJson("/api/db/hypercites/find/{$book}/hypercite_reconly?scope=record")
        ->assertStatus(200)->json();

    expect($json)->toHaveKey('hypercite')->not->toHaveKey('nodes');
    expect($json['hypercite']['hyperciteId'])->toBe('hypercite_reconly');
});

test('find routes sub-book book ids containing a slash', function () {
    $other = $this->apiUser();
    $parent = 'apitest_' . Str::random(12);
    $book = "{$parent}/Fn1"; // sub-book id shape: book_<parent>/Fn<id>
    $nodeId = "{$parent}_Fn1_n1";
    $this->makeBook($other, ['book' => $book, 'visibility' => 'public']);
    $this->seedNode([
        'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
        'content' => '<p>sub</p>', 'plainText' => 'sub', 'type' => 'p',
    ]);
    $this->seedHypercite([
        'book' => $book, 'hyperciteId' => 'hypercite_subbook', 'node_id' => [$nodeId],
        'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 3]], 'citedIN' => [],
        'relationshipStatus' => 'single', 'creator' => $other->name,
    ]);

    $this->loginUser();
    // Before the greedy {book} constraint this was a router-level 404 (no route match).
    $json = $this->getJson("/api/db/hypercites/find/{$book}/hypercite_subbook?scope=record")
        ->assertStatus(200)->json();
    expect($json['hypercite']['book'])->toBe($book);
});
