<?php

/**
 * /j and /j/{slug} — the public journal pages. /j/{slug} is a homepage-class
 * hero page (journal-home.blade.php): locks the auto-load deferral contract
 * (no <main>, no active arranger — mirror of HomeSeoTest), the three
 * shelf-backed feed buttons (data-filter="shelf" + sort published/connected/lit),
 * the journal-scoped search container, the about copy (custom verbatim vs
 * composed default), counts, JSON-LD, and 404. /j is the static diamond index.
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
    $shelfIds = jpageDb()->table('shelves')->where('name', 'LIKE', 'Journal: JPage%')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        jpageDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        jpageDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
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
    jpageDb()->table('journal_sources')->insert(
        collect($row)->map(fn ($v) => is_array($v) ? json_encode($v) : $v)->all()
    );
    return (object) $row;
}

/** Give a journal a public shelf and point shelf_id at it. Returns shelf id. */
function jpageSeedShelf(object $journal): string
{
    $shelfId = (string) Str::uuid();
    jpageDb()->table('shelves')->insert([
        'id'           => $shelfId,
        'creator'      => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR,
        'name'         => 'Journal: ' . $journal->display_name,
        'slug'         => 'journal-' . Str::lower(Str::random(10)),
        'visibility'   => 'public',
        'default_sort' => 'recent',
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);
    jpageDb()->table('journal_sources')->where('id', $journal->id)->update(['shelf_id' => $shelfId]);
    return $shelfId;
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

test('journal hero: page type, lava mount, deferral contract, feed buttons, scoped search, counts', function () {
    $journal = jpageSeedJournal();
    $shelfId = jpageSeedShelf($journal);

    jpageSeedWork($journal->id, ['title' => 'JPage Readable Work'], ['title' => 'JPage Version Readable']);
    jpageSeedWork($journal->id, ['title' => 'JPage Stub Work'], ['title' => 'JPage Version Stub', 'has_nodes' => false]);
    jpageSeedWork($journal->id, ['title' => 'JPage Versionless Work']);

    $response = $this->get('/j/' . $journal->slug)->assertOk();
    $html = $response->getContent();

    // Homepage-class chrome + journal identity: the logo lockup is the
    // hyperlit colon squares + the journal name (no wordmark, no badge).
    expect($html)->toContain('data-page="journal"');
    expect($html)->toContain('id="lava-lamp-mount"');
    expect($html)->toContain('home-content-wrapper journal-content-wrapper');
    expect($html)->toContain('journal-colon');
    expect($html)->toContain('JPage Test Journal');

    // Auto-load deferral contract (mirror of HomeSeoTest): NO server-rendered
    // main-content, NO pre-activated arranger button.
    expect($html)->not->toContain('class="main-content');
    expect($html)->not->toContain('arranger-button active');

    // The three shelf-backed feed buttons.
    expect($html)->toContain('data-filter="shelf" data-shelf-id="' . $shelfId . '" data-sort="published"');
    expect($html)->toContain('data-filter="shelf" data-shelf-id="' . $shelfId . '" data-sort="connected"');
    expect($html)->toContain('data-filter="shelf" data-shelf-id="' . $shelfId . '" data-sort="lit"');

    // Journal-scoped search container carries the shelf id, with the same
    // titles↔full-text toggle as home.
    expect($html)->toContain('id="journal-search-container"');
    expect($html)->toContain('data-shelf-id="' . $shelfId . '"');
    expect($html)->toContain('id="journal-fulltext-toggle"');
    expect($html)->toContain('fulltext-toggle-label');

    // Counts: readable = visible content-bearing best versions.
    expect($html)->toContain('1 of 3 articles readable');

    // JSON-LD Periodical.
    expect($html)->toContain('"@type":"Periodical"');
    expect($html)->toContain('application/ld+json');
});

test('custom about copy renders verbatim; composed default when null', function () {
    $journal = jpageSeedJournal([
        'about'          => null,
        'keywords'       => ['climate change', 'social justice'],
        'subjects'       => ['Economic growth, development, planning'],
        'doaj_license'   => 'CC BY',
        'review_process' => 'Double anonymous peer review',
        'ref_urls'       => ['aims_scope' => 'https://example.org/aims', 'board' => 'https://example.org/board'],
        'homepage_url'   => 'https://example.org/journal',
    ]);
    jpageSeedShelf($journal);

    // Composed default: paragraph + keywords + license + links.
    $response = $this->get('/j/' . $journal->slug)->assertOk();
    $response->assertSee('diamond open access journal', false);
    $response->assertSee('climate change');
    $response->assertSee('CC BY');
    $response->assertSee('double anonymous peer review');
    $response->assertSee('https://example.org/aims', false);
    $response->assertSee('Aims &amp; scope', false);
    $response->assertSee('Editorial board');
    $response->assertSee('Journal website');

    // Custom copy replaces the composed parts wholesale.
    jpageDb()->table('journal_sources')->where('id', $journal->id)
        ->update(['about' => 'JPage custom about copy, hand written.']);
    $response = $this->get('/j/' . $journal->slug)->assertOk();
    $response->assertSee('JPage custom about copy, hand written.');
    // Composed parts (keywords line) are replaced; the meta description in
    // <head> still legitimately says "diamond open access", so assert on a
    // composed-only string.
    $response->assertDontSee('climate change');
});

test('a journal without a shelf renders the hero without feed buttons', function () {
    $journal = jpageSeedJournal();

    $response = $this->get('/j/' . $journal->slug)->assertOk();
    $html = $response->getContent();

    expect($html)->not->toContain('data-filter="shelf"');
    expect($html)->toContain('Not yet harvested');
    // Deferral contract still holds.
    expect($html)->not->toContain('class="main-content');
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
