<?php

/**
 * JournalHyperciteMap — the journal hero's inline hypercite-map SVG (blob of
 * articles + spokes to hypercited books beyond the journal). Locks the data
 * rules one by one: both directions of a hypercite edge, sub-book folding, the
 * public/has_nodes visibility gate on outside partners (an invisible book's
 * title must never leak into the public page), the two blob modes, and title
 * escaping.
 *
 * Seeds via pgsql_admin with beforeEach-only cleanup (afterEach admin deletes
 * deadlock against the open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use App\Models\JournalSource;
use App\Services\JournalHarvest\JournalHyperciteMap;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function jmapDb()
{
    return DB::connection('pgsql_admin');
}

function jmapCleanup(): void
{
    jmapDb()->table('hypercites')->where('book', 'LIKE', 'book_jmap_%')->delete();
    jmapDb()->table('canonical_source')->where('title', 'LIKE', 'JMap %')->delete();
    jmapDb()->table('library')->where('book', 'LIKE', 'book_jmap_%')->delete();
    jmapDb()->table('journal_sources')->where('display_name', 'LIKE', 'JMap %')->delete();
}

beforeEach(fn () => jmapCleanup());
afterAll(fn () => jmapCleanup());

function jmapJournal(): JournalSource
{
    return JournalSource::create([
        'id'                 => (string) Str::uuid(),
        'openalex_source_id' => 'SJMAP' . Str::upper(Str::random(7)),
        'display_name'       => 'JMap Journal ' . Str::random(4),
        'issn_l'             => '8888-000' . random_int(0, 9),
        'slug'               => 'jmap-' . Str::lower(Str::random(10)),
        'is_diamond'         => true,
    ]);
}

/** A public readable book, optionally attached to the journal as an article. */
function jmapBook(string $title, ?JournalSource $journal = null, array $opts = []): string
{
    $book = 'book_jmap_' . Str::lower(Str::random(10));
    jmapDb()->table('library')->insert(array_merge([
        'book'       => $book,
        'title'      => $title,
        'visibility' => 'public',
        'listed'     => false,
        'has_nodes'  => true,
        'type'       => 'book',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
    ], $opts));

    if ($journal) {
        jmapDb()->table('canonical_source')->insert([
            'id'                => (string) Str::uuid(),
            'title'             => 'JMap canonical ' . Str::random(4),
            'journal_source_id' => $journal->id,
            'auto_version_book' => $book,
            'created_at'        => now(),
            'updated_at'        => now(),
        ]);
    }

    return $book;
}

/** One hypercite edge: a passage of $cited quoted inside $citing. */
function jmapHypercite(string $cited, string $citing): void
{
    jmapDb()->table('hypercites')->insert([
        'book'        => $cited,
        'hyperciteId' => 'hypercite_' . Str::lower(Str::random(8)),
        'citedIN'     => json_encode(["/{$citing}#hypercite_" . Str::lower(Str::random(6))]),
        'raw_json'    => '{}',
        'charData'    => '{}',
        'created_at'  => now(),
    ]);
}

function jmapSvg(JournalSource $journal): ?string
{
    return (new JournalHyperciteMap())->svg($journal);
}

test('two journal articles hypercited together draw two lit dots and an internal edge', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Article Alpha', $journal);
    $b = jmapBook('JMap Article Beta', $journal);
    jmapHypercite($a, $b);

    $svg = jmapSvg($journal);

    expect($svg)->toContain('<svg');
    expect($svg)->toContain('JMap Article Alpha');
    expect($svg)->toContain('JMap Article Beta');
    expect($svg)->toContain('href="/' . $a . '"');
    expect($svg)->toContain('href="/' . $b . '"');
    // 2 lit dots + 1 internal edge, all in the hero ink (brand pink vanished
    // against the pink lava-lamp background — never reintroduce it here).
    expect(substr_count($svg, '<circle'))->toBe(2);
    expect(substr_count($svg, '<path'))->toBe(1);
    expect($svg)->not->toContain('#EE4A95');
    expect($svg)->toContain('#221F20');
});

test('a hypercite with an outside book draws a spoke and the partner label, both directions', function () {
    $journal = jmapJournal();
    $article = jmapBook('JMap Inside Article', $journal);
    $out1 = jmapBook('JMap Outside Quoter');   // quotes the article
    $out2 = jmapBook('JMap Outside Source');   // is quoted BY the article
    jmapHypercite($article, $out1);
    jmapHypercite($out2, $article);

    $svg = jmapSvg($journal);

    expect($svg)->toContain('JMap Outside Quoter');
    expect($svg)->toContain('JMap Outside Source');
    expect($svg)->toContain('href="/' . $out1 . '"');
    expect($svg)->toContain('#2E7D80'); // spoke + partner dots (darkened aqua)
    // Titles ride data-title for the hover/tap card — no inline <text> labels,
    // which is what lets the network fill the full width.
    expect($svg)->not->toContain('<text');
    expect($svg)->toContain('data-title="JMap Outside Quoter"');
});

test('an invisible outside partner never leaks: edge dropped, title absent', function () {
    $journal = jmapJournal();
    $article = jmapBook('JMap Lonely Article', $journal);
    $private = jmapBook('JMap Secret Diary', null, ['visibility' => 'private']);
    $stub = jmapBook('JMap Empty Stub', null, ['has_nodes' => false]);
    jmapHypercite($article, $private);
    jmapHypercite($stub, $article);

    $svg = jmapSvg($journal);

    // Both edges vanish entirely: the article renders as an ordinary faint
    // dot, and neither invisible title appears anywhere in the SVG.
    expect($svg)->toContain('JMap Lonely Article');
    expect($svg)->not->toContain('JMap Secret Diary');
    expect($svg)->not->toContain('JMap Empty Stub');
    expect(substr_count($svg, '<path'))->toBe(0);
});

test('a citedIN entry pointing at a sub-book folds to the root book', function () {
    $journal = jmapJournal();
    $article = jmapBook('JMap Root Article', $journal);
    $outside = jmapBook('JMap Root Outside');
    // The quoting anchor lives in a footnote sub-book of the outside work.
    jmapHypercite($article, $outside . '/Fn12');

    $svg = jmapSvg($journal);

    expect($svg)->toContain('href="/' . $outside . '"');
    expect((string) $svg)->not->toContain('Fn12');
});

test('unconnected articles stay on the map as faint dots; hypercited ones draw solid', function () {
    $journal = jmapJournal();
    $lit = jmapBook('JMap Lit Article', $journal);
    jmapBook('JMap Quiet Article', $journal);
    jmapHypercite($lit, jmapBook('JMap Lit Partner', $journal));

    $svg = jmapSvg($journal);

    expect($svg)->toContain('JMap Quiet Article');
    expect($svg)->toContain('JMap Lit Article');
    // Faint (0.5) for the quiet article, solid (1) for the hypercited pair.
    expect($svg)->toContain('fill-opacity="0.5"');
    expect(substr_count($svg, 'fill-opacity="1"'))->toBe(2);
});

test('empty journal renders nothing', function () {
    expect(jmapSvg(jmapJournal()))->toBeNull();
});

test('article and partner titles are escaped', function () {
    $journal = jmapJournal();
    $article = jmapBook('JMap <script>alert(1)</script> Article', $journal);
    $partner = jmapBook('JMap "Quoted" & <b>Partner</b>');
    jmapHypercite($article, $partner);

    $svg = jmapSvg($journal);

    expect($svg)->not->toContain('<script>');
    expect($svg)->not->toContain('<b>');
    expect($svg)->toContain('&lt;script&gt;');
});

// ── the page ─────────────────────────────────────────────────────────────────

test('the journal page renders the map and the lit-up 3D link', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Page Article A', $journal);
    jmapHypercite($a, jmapBook('JMap Page Article B', $journal));

    $html = $this->get('/j/' . $journal->slug)->assertOk()->getContent();

    expect($html)->toContain('journal-hypercite-map');
    expect($html)->toContain('journal-map-legend');
    expect($html)->toContain('journal-map-expand');
    expect($html)->toContain('JMap Page Article A');
    expect($html)->toContain('/3d/j/' . $journal->slug);
    // The deferral/feed contract must survive the new section.
    expect($html)->not->toContain('class="main-content');
    expect($html)->not->toContain('arranger-button active');
});

test('a journal with no readable articles gets neither map nor 3D link', function () {
    $journal = jmapJournal();

    $html = $this->get('/j/' . $journal->slug)->assertOk()->getContent();

    expect($html)->not->toContain('journal-hypercite-map');
    expect($html)->not->toContain('/3d/j/');
});

test('the svg is responsive and labelled', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Resp A', $journal);
    jmapHypercite($a, jmapBook('JMap Resp B', $journal));

    $svg = jmapSvg($journal);

    expect($svg)->toContain('viewBox="');
    expect($svg)->toContain('role="img"');
    expect($svg)->toContain('aria-label="Hypercite network of ' . e($journal->display_name) . '"');
    expect($svg)->toContain('width:100%');
    expect($svg)->toContain('tabindex="-1"'); // welcome-copy keyboard model
});
