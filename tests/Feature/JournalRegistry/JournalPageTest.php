<?php

/**
 * /j and /j/{slug} — the public journal pages. Locks: 404 for unknown slugs,
 * journal header rendering, the linking rule (a visible version WITH CONTENT
 * links regardless of listed; listed=false gets the "unreviewed" marker;
 * content-less stubs and version-less canonicals render unlinked), and the
 * index listing diamond journals.
 *
 * Seeds via pgsql_admin with beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function jpageDb()
{
    return DB::connection('pgsql_admin');
}

function jpageCleanup(): void
{
    jpageDb()->table('canonical_source')->where('title', 'LIKE', 'JPage %')->delete();
    jpageDb()->table('library')->where('title', 'LIKE', 'JPage %')->delete();
    jpageDb()->table('journal_sources')->where('display_name', 'LIKE', 'JPage %')->delete();
}

beforeEach(fn() => jpageCleanup());

function jpageSeedJournal(array $opts = []): object
{
    $id = (string) Str::uuid();
    $row = array_merge([
        'id'                 => $id,
        'openalex_source_id' => 'SJPAGE' . Str::upper(Str::random(6)),
        'display_name'       => 'JPage Test Journal',
        'publisher'          => 'JPage Press',
        'issn_l'             => '9999-000' . random_int(0, 9),
        'slug'               => 'jpage-test-' . Str::lower(Str::random(8)),
        'is_diamond'         => true,
        'cited_by_count'     => 100,
        'works_count'        => 3,
        'created_at'         => now(),
        'updated_at'         => now(),
    ], $opts);
    jpageDb()->table('journal_sources')->insert($row);
    return (object) $row;
}

function jpageSeedWork(string $journalId, array $canonical = [], ?array $version = null): void
{
    $book = null;
    if ($version !== null) {
        $book = 'book_jpage_' . Str::lower(Str::random(8));
        jpageDb()->table('library')->insert(array_merge([
            'book'       => $book,
            'title'      => 'JPage Version',
            'visibility' => 'public',
            'listed'     => false,
            'has_nodes'  => true,
            'type'       => 'book',
            'raw_json'   => '[]',
            'timestamp'  => 0,
            'created_at' => now(),
        ], $version));
    }

    jpageDb()->table('canonical_source')->insert(array_merge([
        'id'                => (string) Str::uuid(),
        'title'             => 'JPage Work',
        'journal_source_id' => $journalId,
        'auto_version_book' => $book,
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $canonical));
}

test('unknown slug is a 404', function () {
    $this->get('/j/no-such-journal-slug')->assertNotFound();
});

test('journal page renders header, links content-bearing versions, marks unreviewed', function () {
    $journal = jpageSeedJournal();

    // Unreviewed but converted → linked + "unreviewed" marker.
    jpageSeedWork($journal->id, ['title' => 'JPage Linked Work', 'cited_by_count' => 9], ['title' => 'JPage Version Linked']);
    // Content-less stub → unlinked.
    jpageSeedWork($journal->id, ['title' => 'JPage Stub Work', 'cited_by_count' => 5], ['title' => 'JPage Version Stub', 'has_nodes' => false]);
    // No version at all → unlinked.
    jpageSeedWork($journal->id, ['title' => 'JPage Versionless Work', 'cited_by_count' => 1]);

    $response = $this->get('/j/' . $journal->slug)->assertOk();

    $response->assertSee('JPage Test Journal');
    $response->assertSee('JPage Press');
    $response->assertSee('diamond open access');
    $response->assertSee('1 of 3 articles readable');

    $linkedBook = jpageDb()->table('library')->where('title', 'JPage Version Linked')->value('book');
    $response->assertSee('href="/' . $linkedBook . '"', false);
    $response->assertSee('<span class="jp-unreviewed"', false);

    $stubBook = jpageDb()->table('library')->where('title', 'JPage Version Stub')->value('book');
    $response->assertDontSee('href="/' . $stubBook . '"', false);
});

test('a reviewed (listed) version links without the unreviewed marker', function () {
    $journal = jpageSeedJournal();
    jpageSeedWork($journal->id, ['title' => 'JPage Approved Work'], ['title' => 'JPage Version Approved', 'listed' => true]);

    $response = $this->get('/j/' . $journal->slug)->assertOk();

    $book = jpageDb()->table('library')->where('title', 'JPage Version Approved')->value('book');
    $response->assertSee('href="/' . $book . '"', false);
    $response->assertDontSee('<span class="jp-unreviewed"', false);
});

test('the /j index lists diamond journals ranked by citations', function () {
    $big = jpageSeedJournal(['display_name' => 'JPage Big Journal', 'cited_by_count' => 9000]);
    $small = jpageSeedJournal(['display_name' => 'JPage Small Journal', 'cited_by_count' => 10]);
    jpageSeedJournal(['display_name' => 'JPage NonDiamond Journal', 'is_diamond' => false]);

    $response = $this->get('/j')->assertOk();

    $response->assertSeeInOrder(['JPage Big Journal', 'JPage Small Journal']);
    $response->assertDontSee('JPage NonDiamond Journal');
    $response->assertSee('/j/' . $big->slug, false);
});
