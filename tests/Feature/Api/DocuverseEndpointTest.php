<?php

/**
 * The docuverse graph endpoint — /api/docuverse/data?layers=…. Locks: the
 * three edge layers (hypercite / citation_verified / citation_auto) and the
 * layer filter, the CONNECTED-ONLY node rule (an orphan work is not on the
 * map), sub-book folding, and visibility (RLS on the default connection: a
 * stranger/guest never sees edges into private books).
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function dvDb()
{
    return DB::connection('pgsql_admin');
}

function dvSeedCanonical(array $opts = []): string
{
    $id = (string) Str::uuid();
    dvDb()->table('canonical_source')->insert(array_merge([
        'id' => $id,
        'title' => 'DvTest Canonical ' . Str::random(6),
        'author' => 'Dv Author',
        'year' => 1970,
        'openalex_id' => 'W_DVTEST_' . Str::random(8),
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts));
    return $id;
}

function dvSeedBib(string $book, array $opts = []): void
{
    dvDb()->table('bibliography')->insert(array_merge([
        'book' => $book,
        'referenceId' => 'dv' . Str::random(8),
        'content' => 'DvTest reference',
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts));
}

function dvSeedHypercite(string $book, array $citedIn): void
{
    $id = 'hypercite_dv' . Str::random(8);
    dvDb()->table('hypercites')->insert([
        'book' => $book,
        'hyperciteId' => $id,
        'citedIN' => json_encode($citedIn),
        'relationshipStatus' => 'couple',
        'raw_json' => json_encode(['hyperciteId' => $id, 'citedIN' => $citedIn]),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

afterEach(function () {
    dvDb()->table('hypercites')->where('hyperciteId', 'like', 'hypercite\_dv%')->delete();
    dvDb()->table('bibliography')->where('referenceId', 'like', 'dv%')->delete();
    dvDb()->table('canonical_source')->where('openalex_id', 'like', 'W\_DVTEST\_%')->delete();
    $this->cleanupApiFixtures();
});

test('hypercite layer: book↔book edges, sub-books fold to root, connected-only', function () {
    $owner = $this->loginUser();
    $a = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Dv Source A']);
    $b = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Dv Target B']);
    $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Dv Orphan']); // no edges → not on the map

    // citedIN via a SUB-BOOK path of B — must fold onto B.
    dvSeedHypercite($a, ["/{$b}/Fn1#hypercite_x"]);

    $resp = $this->getJson('/api/docuverse/data?layers=hypercite')->assertOk();
    $nodes = collect($resp->json('nodes'));
    $edges = collect($resp->json('edges'));

    expect($edges)->toHaveCount(1);
    expect($edges[0])->toMatchArray(['source' => $a, 'target' => $b, 'kind' => 'hypercite']);
    expect($nodes->pluck('id')->sort()->values()->all())->toBe(collect([$a, $b])->sort()->values()->all());
    expect($nodes->firstWhere('id', $a)['kind'])->toBe('book');
});

test('citation layers split on verification, and the layer param filters them', function () {
    $owner = $this->loginUser();
    $a = $this->makeBook($owner, ['visibility' => 'public']);
    $cAuto = dvSeedCanonical(['title' => 'Dv Auto Matched']);
    $cVerified = dvSeedCanonical(['title' => 'Dv Verified']);

    dvSeedBib($a, ['canonical_source_id' => $cAuto]);
    dvSeedBib($a, ['canonical_source_id' => $cVerified, 'reference_verified_at' => now(), 'reference_verified_by' => $owner->name]);

    // Verified layer only (the default posture): auto edge invisible.
    $resp = $this->getJson('/api/docuverse/data?layers=citation_verified')->assertOk();
    $edges = collect($resp->json('edges'));
    expect($edges)->toHaveCount(1);
    expect($edges[0])->toMatchArray(['source' => $a, 'target' => $cVerified, 'kind' => 'citation_verified']);
    expect(collect($resp->json('nodes'))->pluck('id'))->not->toContain($cAuto);
    // An unheld canonical is a violet "citation identity" node.
    expect(collect($resp->json('nodes'))->firstWhere('id', $cVerified)['kind'])->toBe('canonical');

    // Adding the auto layer surfaces the auto edge too.
    $resp = $this->getJson('/api/docuverse/data?layers=citation_verified,citation_auto')->assertOk();
    $kinds = collect($resp->json('edges'))->pluck('kind')->sort()->values()->all();
    expect($kinds)->toBe(['citation_auto', 'citation_verified']);
});

test('default layers are hypercite + verified citations (auto stays hidden)', function () {
    $owner = $this->loginUser();
    $a = $this->makeBook($owner, ['visibility' => 'public']);
    dvSeedBib($a, ['canonical_source_id' => dvSeedCanonical()]); // auto-matched only

    $resp = $this->getJson('/api/docuverse/data')->assertOk();
    expect($resp->json('layers'))->toBe(['hypercite', 'citation_verified']);
    expect($resp->json('edges'))->toBe([]);
    expect($resp->json('nodes'))->toBe([]); // connected-only: nothing qualifies
});

test('a held canonical is ONE sphere carrying ALL its visible versions', function () {
    $owner = $this->loginUser();
    $a = $this->makeBook($owner, ['visibility' => 'public']);
    $v1 = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Dv Held Version One']);
    $v2 = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Dv Held Version Two']);
    $private = $this->makeBook($owner, ['title' => 'Dv Held Private']); // private version
    $c = dvSeedCanonical(['title' => 'Dv Held Canonical']);
    dvDb()->table('library')->whereIn('book', [$v1, $v2, $private])->update(['canonical_source_id' => $c]);
    dvSeedBib($a, ['canonical_source_id' => $c, 'reference_verified_at' => now()]);

    $resp = $this->getJson('/api/docuverse/data?layers=citation_verified')->assertOk();
    $nodes = collect($resp->json('nodes'));
    // ONE node for the canonical — versions never become their own spheres.
    expect($nodes->where('id', $c))->toHaveCount(1);
    $node = $nodes->firstWhere('id', $c);
    expect($node['kind'])->toBe('held');
    expect(collect($node['versions'])->pluck('book')->sort()->values()->all())
        ->toBe(collect([$v1, $v2, $private])->sort()->values()->all()); // owner sees all three
    expect($node['book'])->toBe($node['versions'][0]['book']);

    // A stranger's version list excludes the private copy (RLS).
    $this->loginUser();
    $resp = $this->getJson('/api/docuverse/data?layers=citation_verified')->assertOk();
    $node = collect($resp->json('nodes'))->firstWhere('id', $c);
    expect(collect($node['versions'])->pluck('book'))->not->toContain($private);
    expect(collect($node['versions']))->toHaveCount(2);
});

test('visibility: a stranger and a guest never see edges into a private book', function () {
    $owner = $this->loginUser();
    $a = $this->makeBook($owner, ['visibility' => 'public']);
    $private = $this->makeBook($owner); // private by default
    dvSeedHypercite($a, ["/{$private}#hypercite_x"]);

    // The owner sees the edge.
    $resp = $this->getJson('/api/docuverse/data?layers=hypercite')->assertOk();
    expect(collect($resp->json('edges')))->toHaveCount(1);

    // A stranger doesn't — RLS hides the private endpoint, the edge drops,
    // and the now-unconnected public book vanishes too (connected-only).
    $this->loginUser();
    $resp = $this->getJson('/api/docuverse/data?layers=hypercite')->assertOk();
    expect($resp->json('edges'))->toBe([]);
    expect(collect($resp->json('nodes'))->pluck('id'))->not->toContain($private);

    // Guest: same.
    auth()->guard('web')->logout();
    $this->flushSession();
    $resp = $this->getJson('/api/docuverse/data?layers=hypercite')->assertOk();
    expect($resp->json('edges'))->toBe([]);
});

test('the page route renders the standalone view', function () {
    $this->get('/3d/docuverse')->assertOk()->assertViewIs('docuverse')->assertSee('Connected by');
    // The 3d namespace keeps book ids collision-free: /docuverse falls through
    // to the /{identifier} catch-all (a user page / book named "docuverse").
});

test('focus scopes the graph to the connected component containing one book', function () {
    $owner = $this->loginUser();
    // Component 1: a → b → c (chain).
    $a = $this->makeBook($owner, ['visibility' => 'public']);
    $b = $this->makeBook($owner, ['visibility' => 'public']);
    $c = $this->makeBook($owner, ['visibility' => 'public']);
    dvSeedHypercite($a, ["/{$b}#hypercite_x"]);
    dvSeedHypercite($b, ["/{$c}#hypercite_y"]);
    // Component 2: d → e, disjoint from 1.
    $d = $this->makeBook($owner, ['visibility' => 'public']);
    $e = $this->makeBook($owner, ['visibility' => 'public']);
    dvSeedHypercite($d, ["/{$e}#hypercite_z"]);

    $resp = $this->getJson("/api/docuverse/data?layers=hypercite&focus={$a}")->assertOk();
    $ids = collect($resp->json('nodes'))->pluck('id');
    expect($ids->sort()->values()->all())->toBe(collect([$a, $b, $c])->sort()->values()->all());
    expect($ids)->not->toContain($d);
    expect($resp->json('focus'))->toBe($a); // independent record → its own node id
    expect(collect($resp->json('edges')))->toHaveCount(2);

    // Without focus, both components are on the map.
    $all = $this->getJson('/api/docuverse/data?layers=hypercite')->assertOk();
    expect(collect($all->json('nodes')))->toHaveCount(5);
});

test('focus on an unconnected book returns an empty graph, not a 404', function () {
    $owner = $this->loginUser();
    $lonely = $this->makeBook($owner, ['visibility' => 'public']);
    $resp = $this->getJson("/api/docuverse/data?layers=hypercite&focus={$lonely}")->assertOk();
    expect($resp->json('nodes'))->toBe([]);
    expect($resp->json('edges'))->toBe([]);
});

test('focus on an invisible or missing book is a 404 (existence must not leak)', function () {
    $owner = $this->loginUser();
    $private = $this->makeBook($owner); // private
    $this->loginUser(); // stranger
    $this->getJson("/api/docuverse/data?layers=hypercite&focus={$private}")->assertNotFound();
    $this->getJson('/api/docuverse/data?layers=hypercite&focus=apitest_nope_xyz')->assertNotFound();
    $this->get("/3d/{$private}")->assertNotFound();
});

test('the focused page route renders with the book title', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public', 'title' => 'Dv Focus Title']);
    dvSeedHypercite($book, ['/somewhere#hypercite_q']);
    $this->get("/3d/{$book}")->assertOk()->assertViewIs('docuverse')
        ->assertSee('Dv Focus Title')->assertSee('in the docuverse');
});
