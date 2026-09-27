<?php

/**
 * /{book}/AIreview for a visitor who cannot SEE the book must render the reader (whose access
 * screen then says "you can't see this — home or log in"), never 404.
 *
 * The route's existence check used to run on the DEFAULT connection, which is RLS-subject: an
 * anonymous visitor cannot see a private book's nodes, so exists() was false and a review that
 * EXISTS reported "not found" — the same RLS-probe-reads-as-nonexistence trap as the
 * /{identifier} username redirect (documented on that route). Existence is now checked on
 * pgsql_admin; ACCESS stays with RLS downstream, exactly like the parent book's own route.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function aireviewDb()
{
    return DB::connection('pgsql_admin');
}

beforeEach(function () {
    $this->book = 'aireviewtest_' . Str::random(8);
    $sub = "{$this->book}/AIreview";

    aireviewDb()->table('library')->insert([
        'book' => $this->book, 'title' => 'AIreview Access Fixture', 'creator' => 'aireview_fixture',
        'visibility' => 'private', 'has_nodes' => true, 'timestamp' => 0, 'raw_json' => '[]',
    ]);
    aireviewDb()->table('nodes')->insert([
        'book' => $sub, 'startLine' => '1', 'chunk_id' => 1,
        'content' => '<h1 id="1">AI Citation Review</h1>', 'plainText' => 'AI Citation Review',
    ]);

    // nodes is wiped globally per test (Pest.php); library is not — clean our row on the way out.
    $this->beforeApplicationDestroyed(function () {
        aireviewDb()->table('library')->where('book', $this->book)->delete();
        aireviewDb()->table('nodes')->where('book', "{$this->book}/AIreview")->delete();
    });
});

test('an anonymous visitor gets the reader (and its access screen), not a 404', function () {
    $this->get("/{$this->book}/AIreview")
        ->assertOk()
        ->assertViewIs('reader')
        ->assertViewHas('book', "{$this->book}/AIreview");
});

test('a book with no AIreview is a genuine 404', function () {
    aireviewDb()->table('nodes')->where('book', "{$this->book}/AIreview")->delete();

    $this->get("/{$this->book}/AIreview")->assertNotFound();
});
