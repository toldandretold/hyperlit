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
use Illuminate\Support\Facades\Cache;
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

beforeEach(function () {
    jmapCleanup();

    /*
     * The map is served through Cache::flexible (stale-while-revalidate), and
     * phpunit.xml sets CACHE_STORE=array — a store that lives in the PHP
     * PROCESS, so unlike the database it is never rolled back by
     * RefreshDatabase and persists across every test in a run. Combined with
     * flexible's wall-clock stale window and its deferred refresh, svg() could
     * return a value built from another test's DB state, or nothing at all:
     * measured 2 failures in 30 identical runs, landing on a different test
     * each time and reading as "the journal lost its articles".
     *
     * Same shape as the pgsql_admin / fetch_host_reachability trap documented
     * in tests/Pest.php: shared state that escapes the transaction rollback.
     */
    Cache::flush();
});
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

/** One hypercite edge: a passage of $cited quoted inside $citing. Returns the hyperciteId. */
function jmapHypercite(string $cited, string $citing, ?string $anchor = null): string
{
    $hyperciteId = 'hypercite_' . Str::lower(Str::random(8));
    jmapDb()->table('hypercites')->insert([
        'book'        => $cited,
        'hyperciteId' => $hyperciteId,
        'citedIN'     => json_encode(["/{$citing}#" . ($anchor ?? 'hypercite_' . Str::lower(Str::random(6)))]),
        'raw_json'    => '{}',
        'charData'    => '{}',
        'created_at'  => now(),
    ]);

    return $hyperciteId;
}

/** The full <a …> opening tag for a book's dot, for per-node attribute asserts. */
function jmapAnchorTag(string $svg, string $book): string
{
    preg_match('/<a href="\/' . preg_quote($book, '/') . '"[^>]*>/', $svg, $m);

    return $m[0] ?? '';
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
    // Titles ride aria-label — read by screen readers AND by the hover/tap card —
    // with no inline <text> labels, which is what lets the network fill the full
    // width. There used to be an identical `data-title` beside every aria-label;
    // that second copy was 19% of the SVG's bytes for no new information.
    expect($svg)->not->toContain('<text');
    expect($svg)->toContain('aria-label="JMap Outside Quoter"');
    expect($svg)->not->toContain('data-title');
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

test('hypercited dots carry an intro deep-link: own hyperciteId inbound, the ↗ anchor outbound', function () {
    $journal = jmapJournal();
    $cited = jmapBook('JMap Intro Cited', $journal);     // has its own hypercites row
    $citing = jmapBook('JMap Intro Citing', $journal);   // only the ↗ anchor in its content
    jmapBook('JMap Intro Quiet', $journal);              // untouched
    $hyperciteId = jmapHypercite($cited, $citing, 'anchor_intro42');

    $svg = jmapSvg($journal);

    expect(jmapAnchorTag($svg, $cited))->toContain('data-intro="' . $hyperciteId . '"');
    expect(jmapAnchorTag($svg, $citing))->toContain('data-intro="anchor_intro42"');

    $quietTag = jmapAnchorTag($svg, jmapDb()->table('library')->where('title', 'JMap Intro Quiet')->value('book'));
    expect($quietTag)->not->toContain('data-intro');
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
    // role="group", NOT role="img": the dots are real <a href> links, and an
    // interactive descendant inside a children-presentational role is the axe
    // `nested-interactive` violation (WCAG 4.1.2) the user-page a11y scan caught.
    expect($svg)->toContain('role="group"');
    expect($svg)->not->toContain('role="img"');
    expect($svg)->toContain('aria-label="Hypercite network of ' . e($journal->display_name) . '"');
    expect($svg)->toContain('width:100%');
    expect($svg)->toContain('tabindex="-1"'); // welcome-copy keyboard model
});

// ── accessibility + the text alternative ─────────────────────────────────────

/**
 * The figure's TEXT ALTERNATIVE is the load-bearing piece, and it does three
 * jobs that all break together if it disappears:
 *
 *  1. the only way a screen-reader user can read the network;
 *  2. the only KEYBOARD route to the node links — the dots keep tabindex="-1"
 *     (400 tab stops in a graphic is hostile) and contentHopper, which makes
 *     tabindex="-1" content reachable elsewhere, roots on .main-content and
 *     .welcome-copy, neither of which contains this figure. Without the list the
 *     links are mouse-only: WCAG 2.1.1;
 *  3. the dots' only text is an aria-label, so to a crawler they are nearly
 *     anonymous. These <a> elements carry the real TITLE as anchor text — and
 *     many of these works are public but `listed = false`, so this list is the
 *     only thing on the site that links to them.
 */
test('the figure wraps the svg with a caption and a legend', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Figure Alpha', $journal);
    jmapHypercite($a, jmapBook('JMap Figure Beta', $journal));

    $svg = jmapSvg($journal);

    expect($svg)->toContain('<figure class="hypercite-figure">');
    expect($svg)->toContain('<figcaption');
    // the legend moved OUT of the two blades into the service, so journal and
    // user versions cannot drift (they were hand-copies with the nouns swapped)
    expect($svg)->toContain('journal-map-legend');

    // The <details> "view as a list" text alternative is GONE and must not come
    // back: contentHopper already gives these dots a keyboard route, and the
    // <summary> was a native Tab stop inside .welcome-copy — it BROKE the
    // homepage's chrome-only Tab loop (WCAG 2.4.3) rather than helping.
    expect($svg)->not->toContain('hypercite-map-list');
    expect($svg)->not->toContain('<summary');
    expect($svg)->not->toContain('<li><a href=');
});



test('a slugged work is linked at its CANONICAL url, never the raw book id', function () {
    $journal = jmapJournal();
    $slug = 'jmap-canon-' . Str::lower(Str::random(8));
    $a = jmapBook('JMap Slugged Work', $journal, ['slug' => $slug]);
    jmapHypercite($a, jmapBook('JMap Slugged Partner', $journal));

    $svg = jmapSvg($journal);

    // A work linked from its own collection page at /{book_id} would point away
    // from the URL its own page canonicalizes to.
    expect($svg)->toContain('<a href="/' . $slug . '"');
    expect($svg)->not->toContain('href="/' . $a . '"');
});


test('the svg describes itself: a sized <desc> plus a caption explaining the encoding', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Desc Alpha', $journal);
    jmapHypercite($a, jmapBook('JMap Desc Beta', $journal));

    $svg = jmapSvg($journal);

    // <desc> says how big the network is and where to read it...
    expect($svg)->toMatch('/<desc>A network diagram of 2 articles and 1 hypercite connection\./');
    // ...the figcaption says what the shapes MEAN. Two different sentences on
    // purpose: identical text would be announced twice for one graphic.
    expect($svg)->toContain('Each dot is one article');

    // NO <title> child: aria-label already names the group, and a <title> draws
    // a native tooltip that fights the hover/tap card.
    expect($svg)->not->toContain('<title>');
    // and still no inline text labels in the drawing itself
    expect($svg)->not->toContain('<text');
});

test('the dots stay unfocusable — contentHopper is the keyboard route', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Tab Alpha', $journal);
    jmapHypercite($a, jmapBook('JMap Tab Beta', $journal));

    $svg = jmapSvg($journal);

    // Every node anchor is tabindex="-1". Making 400 dots tab stops would bury
    // the page behind hundreds of presses; contentHopper's n/j/p/k reach them
    // instead, because this figure sits inside .welcome-copy — one of that
    // module's content roots. (An earlier comment in the service claimed the
    // opposite and a <details> list was added to compensate; see its docblock.)
    expect(substr_count($svg, 'tabindex="-1"'))->toBe(substr_count($svg, '<circle'));

    // and the figure introduces NO tabbable control of its own
    expect($svg)->not->toContain('<summary');
    expect($svg)->not->toContain('<button');
});

test('the legend is hidden from screen readers — the caption says it in words', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Legend Alpha', $journal);
    jmapHypercite($a, jmapBook('JMap Legend Beta', $journal));

    $svg = jmapSvg($journal);

    // four colour swatches read aloud are noise; the figcaption already states
    // the same mapping as prose. It carries no interactive content, so
    // aria-hidden here is safe (hiding a focusable subtree would not be).
    expect($svg)->toMatch('/<ul class="journal-map-legend" aria-hidden="true">/');
    expect($svg)->not->toMatch('/<ul class="journal-map-legend"[^>]*>.*?<a /s');
});

test('the user-page vocabulary reaches the caption and the legend', function () {
    $a = 'book_jmap_' . Str::lower(Str::random(10));
    jmapDb()->table('library')->insert([
        'book' => $a, 'title' => 'JMap Vocab Book', 'visibility' => 'public',
        'listed' => false, 'has_nodes' => true, 'type' => 'book',
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
    ]);

    $svg = (new JournalHyperciteMap())->buildSvgForBooks(
        [$a => ['title' => 'JMap Vocab Book', 'author' => null, 'year' => null, 'slug' => null]],
        'Hypercite network of Someone',
        ['noun' => 'book', 'plural' => 'books', 'beyond' => 'beyond this library'],
    );

    expect($svg)->toContain('Each dot is one book');
    expect($svg)->toContain('beyond this library');
    expect($svg)->toContain('hypercited book');
    expect($svg)->not->toContain('beyond the journal');

    // The journal nouns must not leak into the PROSE. Scoped to the caption on
    // purpose: `data-map-node="article"` is a structural attribute value, not
    // vocabulary, and asserting on the whole SVG catches it by accident.
    $caption = Str::between($svg, '<figcaption', '</figcaption>');
    expect($caption)->not->toContain('article');
});

test('the figure is valid HTML: figcaption is the last child, holding caption and legend', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Valid Alpha', $journal);
    jmapHypercite($a, jmapBook('JMap Valid Beta', $journal));

    $svg = jmapSvg($journal);

    // <figure>'s content model is flow content followed by at most ONE
    // <figcaption> (or a figcaption first) — a caption in the MIDDLE is invalid,
    // which is what loose legend siblings after it produced.
    expect($svg)->toMatch('#</figcaption></figure>$#');
    expect($svg)->toMatch('#</svg><figcaption#');
    // both descriptive parts live inside the caption
    $caption = Str::between($svg, '<figcaption', '</figcaption>');
    expect($caption)->toContain('hypercite-encoding');
    expect($caption)->toContain('journal-map-legend');
    // exactly one caption, and the figure has exactly two children
    expect(substr_count($svg, '<figcaption'))->toBe(1);
    expect(substr_count($svg, '<svg'))->toBe(1);
});

test('the hover card vocabulary rides the svg, so no page gets journal nouns by accident', function () {
    $journal = jmapJournal();
    $a = jmapBook('JMap Vocab Attr A', $journal);
    jmapHypercite($a, jmapBook('JMap Vocab Attr B', $journal));

    $svg = jmapSvg($journal);

    // The JS card reads these instead of hard-coding "Hypercited article" —
    // which is what made every book on /u/{name} read "HYPERCITED ARTICLE"
    // while the PHP caption correctly said "book".
    expect($svg)->toContain('data-map-noun="article"');
    expect($svg)->toContain('data-map-noun-beyond="beyond the journal"');
});

test('a user-library map carries ITS nouns to the hover card', function () {
    $book = 'book_jmap_' . Str::lower(Str::random(10));
    jmapDb()->table('library')->insert([
        'book' => $book, 'title' => 'JMap Vocab Lib', 'visibility' => 'public',
        'listed' => false, 'has_nodes' => true, 'type' => 'book',
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
    ]);

    $svg = (new JournalHyperciteMap())->buildSvgForBooks(
        [$book => ['title' => 'JMap Vocab Lib', 'author' => null, 'year' => null, 'slug' => null]],
        'Hypercite network of Someone',
        ['noun' => 'book', 'plural' => 'books', 'beyond' => 'beyond this library'],
    );

    expect($svg)->toContain('data-map-noun="book"');
    expect($svg)->toContain('data-map-noun-beyond="beyond this library"');
    expect($svg)->not->toContain('data-map-noun="article"');
});
