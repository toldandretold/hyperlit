<?php

/**
 * The harvest knowledge-network data endpoint + standalone 3D page —
 * /api/harvest-network/{root}/data and /harvest-network/{root}. Locks: the
 * graph reconstruction from the report row's cumulative_results (depth-2
 * children wire to their depth-1 parent via the parent's held-book id, NOT
 * the root; orphans and legacy pre-lineage entries fan from the root), and
 * the auth boundary (the yield REPORT book's visibility; private → 404 for
 * strangers so existence never leaks; public commons → readable by anyone).
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function hnDb()
{
    return DB::connection('pgsql_admin');
}

/** Seed the yield-report library row for a root, with the given union. */
function hnSeedReport(string $root, array $union, array $opts = []): string
{
    $reportId = 'source-yield-report-' . $root;
    hnDb()->table('library')->insert(array_merge([
        'book'       => $reportId,
        'title'      => 'Source Yield Report — HN Test',
        'author'     => 'Hyperlit',
        'visibility' => 'private',
        'listed'     => false,
        'has_nodes'  => true,
        'type'       => 'report',
        'raw_json'   => json_encode([
            'book'               => $reportId,
            'type'               => 'report',
            'report_of'          => $root,
            'cumulative_results' => $union,
        ]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts));
    return $reportId;
}

afterEach(function () {
    hnDb()->table('library')->where('book', 'like', 'source-yield-report-apitest\_%')->delete();
    $this->cleanupApiFixtures();
});

test('owner gets the graph: depth-2 child wired to its depth-1 parent, orphan + legacy fan from root', function () {
    $owner = $this->loginUser();
    $root = $this->makeBook($owner, ['title' => 'HN Root Book', 'year' => 1970, 'cited_by_count' => 7]);

    $c1 = (string) Str::uuid();
    $c2 = (string) Str::uuid();
    $c3 = (string) Str::uuid();
    $c4 = (string) Str::uuid();
    hnSeedReport($root, [
        // depth-1 success whose held book parents the next entry
        ['canonical_source_id' => $c1, 'title' => 'Level One', 'year' => 2001, 'status' => 'assigned', 'book' => 'apitest_hn_held1', 'depth' => 1, 'parent_book' => $root, 'cited_by_count' => 10],
        // depth-2 child of c1 (parent_book = c1's auto_version_book)
        ['canonical_source_id' => $c2, 'title' => 'Level Two', 'year' => 2005, 'status' => 'fetch_failed', 'reason' => 'walled', 'doi' => '10.1/two', 'journal' => 'Test Review', 'type' => 'journal-article', 'book' => null, 'depth' => 2, 'parent_book' => 'apitest_hn_held1', 'cited_by_count' => 3],
        // orphan: parent held under a DIFFERENT root → reparents to root
        ['canonical_source_id' => $c3, 'title' => 'Orphan', 'year' => 2010, 'status' => 'assigned', 'book' => 'apitest_hn_held3', 'depth' => 2, 'parent_book' => 'apitest_hn_elsewhere', 'cited_by_count' => 0],
        // legacy pre-lineage entry: no depth/parent_book/cited_by_count
        ['canonical_source_id' => $c4, 'title' => 'Legacy Entry', 'year' => 1999, 'status' => 'deferred', 'oa_url' => 'https://repo.test/legacy'],
    ], ['creator' => $owner->name]);

    $resp = $this->getJson("/api/harvest-network/{$root}/data")->assertOk();

    $nodes = collect($resp->json('nodes'));
    $edges = collect($resp->json('edges'));

    expect($nodes)->toHaveCount(5); // root + 4 entries
    $rootNode = $nodes->firstWhere('status', 'root');
    expect($rootNode['id'])->toBe($root);
    expect($rootNode['depth'])->toBe(0);
    expect($rootNode['title'])->toBe('HN Root Book');

    // depth-2 child wired to its depth-1 PARENT's node id, not the root.
    expect($edges->firstWhere('target', $c2)['source'])->toBe($c1);
    // depth-1 + orphan + legacy all wire to the root.
    expect($edges->firstWhere('target', $c1)['source'])->toBe($root);
    expect($edges->firstWhere('target', $c3)['source'])->toBe($root);
    expect($edges->firstWhere('target', $c4)['source'])->toBe($root);

    // Legacy entry got the defaults + a usable link.
    $legacy = $nodes->firstWhere('id', $c4);
    expect($legacy['depth'])->toBe(1);
    expect($legacy['url'])->toBe('https://repo.test/legacy');
    // Failed entry's url is its best external link (DOI), and the citation
    // details the click panel renders ride along.
    $failed = $nodes->firstWhere('id', $c2);
    expect($failed['url'])->toBe('https://doi.org/10.1/two');
    expect($failed['journal'])->toBe('Test Review');
    expect($failed['type'])->toBe('journal-article');
    expect($failed['reason'])->toBe('walled');
});

test('a private report is a 404 for a stranger and for a guest (existence must not leak)', function () {
    $owner = $this->loginUser();
    $root = $this->makeBook($owner);
    hnSeedReport($root, [], ['creator' => $owner->name]);

    // Stranger (different logged-in user).
    $this->loginUser();
    $this->getJson("/api/harvest-network/{$root}/data")->assertNotFound();
    $this->get("/harvest-network/{$root}")->assertNotFound();

    // Guest.
    auth()->guard('web')->logout();
    $this->flushSession();
    $this->getJson("/api/harvest-network/{$root}/data")->assertNotFound();
});

test('a public (commons) report is readable by the owner, a stranger, and a guest', function () {
    $owner = $this->loginUser();
    $root = $this->makeBook($owner, ['visibility' => 'public']);
    $c1 = (string) Str::uuid();
    hnSeedReport($root, [
        ['canonical_source_id' => $c1, 'title' => 'Commons Work', 'status' => 'assigned', 'book' => 'apitest_hn_cheld', 'depth' => 1, 'parent_book' => $root],
    ], ['creator' => $owner->name, 'visibility' => 'public']);

    // Stranger.
    $this->loginUser();
    $this->getJson("/api/harvest-network/{$root}/data")->assertOk();

    // Guest.
    auth()->guard('web')->logout();
    $this->flushSession();
    $resp = $this->getJson("/api/harvest-network/{$root}/data")->assertOk();
    expect(collect($resp->json('nodes'))->pluck('id'))->toContain($c1);
});

test('missing report is a 404 even when the root book exists', function () {
    $owner = $this->loginUser();
    $root = $this->makeBook($owner); // book exists, but no harvest ran → no report
    $this->getJson("/api/harvest-network/{$root}/data")->assertNotFound();
    $this->get("/harvest-network/{$root}")->assertNotFound();
});

test('the page route renders the standalone view for the owner', function () {
    $owner = $this->loginUser();
    $root = $this->makeBook($owner, ['title' => 'HN Page Root']);
    hnSeedReport($root, [], ['creator' => $owner->name]);

    $resp = $this->get("/harvest-network/{$root}")->assertOk();
    $resp->assertSee('HN Page Root');
    $resp->assertViewIs('harvest-network');
});
