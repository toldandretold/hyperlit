<?php

/**
 * Deleted sub-book URLs fall back to the nearest surviving ancestor instead of 404ing.
 *
 * WHY: deleting a highlight destroys its annotation sub-book, but nothing rewrote the URL
 * that named it. Refreshing on `/{book}/2/HL_parent/HL_deleted` therefore hit
 * TextController::showNested → walkChainToRoot → null → abort(404) — a dead end on a book
 * the reader can perfectly well see. showNested now walks DOWN to the deepest ancestor that
 * still resolves and redirects there once, clearing the dead segments from the address bar.
 *
 * The walk cannot be string surgery: a sub_book_id only encodes its last two items
 * ("book/item" or "book/N/parentItem/item"), so the grandparent is not derivable from the
 * id — each step down is a real lookup of the parent ITEM's own sub_book_id.
 *
 * Seeding + cleanup follow SubBookVisibilityApiTest: admin-connection seeds, beforeEach-only
 * cleanup (an afterEach admin delete deadlocks against the open RefreshDatabase transaction).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Feature\Api\Support\InteractsWithApi;
use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class, InteractsWithApi::class);

function chainFallbackCleanup(): void
{
    $admin = DB::connection('pgsql_admin');
    $admin->table('hyperlights')->where('book', 'like', 'chaintest\_%')->delete();
    $admin->table('nodes')->where('book', 'like', 'chaintest\_%')->delete();
    $admin->table('library')->where('book', 'like', 'chaintest\_%')->delete();
    $admin->table('users')->where('email', 'like', 'api\_%@test.local')->delete();
}

beforeEach(fn () => chainFallbackCleanup());

/**
 * Seed a public book carrying a two-level highlight cascade:
 *   HL_parent  → sub-book "<book>/HL_parent"                        (level 1)
 *   HL_child   → sub-book "<book>/2/HL_parent/HL_child"             (level 2)
 * Returns [$book, $parentSubBookId, $childSubBookId].
 */
function seedCascade($test): array
{
    $fn = Closure::bind(function () {
        $owner = $this->apiUser();
        $book = 'chaintest_' . Str::random(12);
        $nodeId = "{$book}_n1";

        $this->makeBook($owner, ['book' => $book, 'visibility' => 'public']);
        $this->seedNode([
            'book' => $book, 'startLine' => 100, 'chunk_id' => 0, 'node_id' => $nodeId,
            'content' => '<p>cascade root text</p>', 'plainText' => 'cascade root text', 'type' => 'p',
        ]);

        $parentSub = "{$book}/HL_parent";
        $childSub  = "{$book}/2/HL_parent/HL_child";

        // Each annotation sub-book needs its own library row: hyperlights RLS keys
        // visibility off the row for the highlight's OWN book, so without these the
        // chain walk reads as "deleted" even when the rows are there.
        $this->makeBook($owner, ['book' => $parentSub, 'visibility' => 'public', 'type' => 'sub_book']);
        $this->makeBook($owner, ['book' => $childSub, 'visibility' => 'public', 'type' => 'sub_book']);

        $this->seedHyperlight([
            'book' => $book, 'hyperlight_id' => 'HL_parent', 'node_id' => [$nodeId],
            'charData' => [$nodeId => ['charStart' => 0, 'charEnd' => 7]],
            'annotation' => 'parent note', 'hidden' => false,
            'creator' => $owner->name, 'sub_book_id' => $parentSub,
        ]);
        // The child highlight lives INSIDE the parent's annotation sub-book.
        $this->seedHyperlight([
            'book' => $parentSub, 'hyperlight_id' => 'HL_child', 'node_id' => ["{$parentSub}_n1"],
            'charData' => ["{$parentSub}_n1" => ['charStart' => 0, 'charEnd' => 6]],
            'annotation' => 'child note', 'hidden' => false,
            'creator' => $owner->name, 'sub_book_id' => $childSub,
        ]);

        return [$book, $parentSub, $childSub];
    }, $test, get_class($test));

    return $fn();
}

test('an intact cascade still renders in place — no redirect', function () {
    [$book] = seedCascade($this);

    $this->get("/{$book}/2/HL_parent/HL_child")
        ->assertStatus(200)
        ->assertViewHas('autoOpenChain');
});

test('deleted leaf redirects to its surviving parent, not a 404', function () {
    [$book, , $childSub] = seedCascade($this);

    // Delete the child exactly as deleting a highlight-in-a-highlight does.
    DB::connection('pgsql_admin')->table('hyperlights')
        ->where('sub_book_id', $childSub)->delete();

    $this->get("/{$book}/2/HL_parent/HL_child")
        ->assertRedirect("/{$book}/HL_parent");
});

test('deleted leaf AND parent falls all the way back to the book, clearing the URL', function () {
    [$book, $parentSub, $childSub] = seedCascade($this);

    DB::connection('pgsql_admin')->table('hyperlights')
        ->whereIn('sub_book_id', [$childSub, $parentSub])->delete();

    $this->get("/{$book}/2/HL_parent/HL_child")
        ->assertRedirect("/{$book}");
});

test('the redirect target is itself resolvable — one hop, no bounce loop', function () {
    [$book, , $childSub] = seedCascade($this);

    DB::connection('pgsql_admin')->table('hyperlights')
        ->where('sub_book_id', $childSub)->delete();

    // Following the redirect must land on a rendered reader, not another redirect.
    $this->get("/{$book}/2/HL_parent/HL_child")
        ->assertRedirect("/{$book}/HL_parent");
    $this->get("/{$book}/HL_parent")->assertStatus(200);
});

test('resolve-chain API degrades to the surviving ancestor instead of 404ing', function () {
    [$book, $parentSub, $childSub] = seedCascade($this);

    DB::connection('pgsql_admin')->table('hyperlights')
        ->where('sub_book_id', $childSub)->delete();

    $response = $this->getJson("/api/resolve-chain/{$book}/2/HL_parent/HL_child")
        ->assertStatus(200)
        ->assertJson(['success' => true, 'truncated' => true, 'resolvedSubBookId' => $parentSub]);

    // The chain it hands back describes the ancestor, and stops there.
    $chain = $response->json('chain');
    expect($chain)->toHaveCount(1)
        ->and($chain[0]['itemId'])->toBe('HL_parent');
});

test('resolve-chain API reports an intact chain as not truncated', function () {
    [$book, , $childSub] = seedCascade($this);

    $this->getJson("/api/resolve-chain/{$book}/2/HL_parent/HL_child")
        ->assertStatus(200)
        ->assertJson(['success' => true, 'truncated' => false, 'resolvedSubBookId' => $childSub]);
});
