<?php

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Homepage SEO + deferred-load invariants (server side).
 *
 * The homepage is the lava-lamp hero: it defers its content feed until a tab is
 * pressed, so there is NO `.main-content` in the server HTML. The crawlable SEO
 * body is the static `.welcome-copy` copy written directly in home.blade.php
 * (blade IS the server-side rendering — no dynamic prerender anymore) plus the
 * WebSite/Organization JSON-LD from HomeController::buildHomeJsonLd().
 *
 * These assertions are deliberately COPY-AGNOSTIC — reword the intro freely.
 * They lock the things that would silently break the migration:
 *  - JSON-LD present (Google structured data)
 *  - a real, non-empty <h1> and the .welcome-copy block actually rendered
 *  - NO `class="main-content"` server-side — re-adding one re-enables the
 *    homepageDisplayUnit auto-load the deferred design removed
 *  - the lava-lamp-background / data-page="home" scaffolding is intact
 */

test('homepage renders the deferred lava hero with no server-side main-content', function () {
    $html = $this->get('/')->assertStatus(200)->getContent();

    // data-page drives every component's page detection
    expect($html)->toContain('data-page="home"');
    // the design scaffolding homepageHero + lavaLampBackground + homepage.css key off
    expect($html)->toContain('id="app-container" class="lava-lamp-background"');
    expect($html)->toContain('id="lava-lamp-mount"');

    // THE deferred-load guard: no main-content element in the server HTML, and
    // no pre-activated arranger tab (either would auto-load the feed on boot)
    expect($html)->not->toContain('class="main-content');
    expect($html)->not->toContain('arranger-button active');
});

test('homepage serves crawlable SEO copy: JSON-LD + a non-empty h1 in .welcome-copy', function () {
    $html = $this->get('/')->assertStatus(200)->getContent();

    // WebSite/Organization structured data
    expect($html)->toContain('application/ld+json');
    expect($html)->toContain('"@type":"WebSite"');
    expect($html)->toContain('"@type":"Organization"');

    // the crawlable copy section rendered, with a real non-empty <h1> inside it
    expect($html)->toContain('class="welcome-copy"');
    expect($html)->toMatch('/<h1[^>]*>\s*\S.*?<\/h1>/s');
});

test('/home serves the same homepage as /', function () {
    $root = $this->get('/')->assertStatus(200)->getContent();
    $home = $this->get('/home')->assertStatus(200)->getContent();

    foreach (['data-page="home"', 'id="lava-lamp-mount"', 'class="welcome-copy"'] as $needle) {
        expect($root)->toContain($needle);
        expect($home)->toContain($needle);
    }
});

/**
 * THE crawl-path guard. Googlebot reaches a page by following links, and the
 * three arranger tabs are <button>s it cannot click — so without a followable
 * <a href> into the corpus the homepage is a dead end and every book is
 * sitemap-only, which is how 2 of 324 URLs came to be indexed.
 *
 * That path is the hypercite map: real visible content whose every dot is a
 * link, plus a "browse all texts" link in the diagram's own action row. It is
 * deliberately NOT a standalone line of hero copy — as copy it reads as a
 * marketing CTA into a list of books, which the hero is not for, and a clipped
 * invisible version of it was tried and rejected (see the next test).
 *
 * Seeded rather than asserted unconditionally: the map renders only once
 * something is hypercited, and a bare test DB has nothing connected, so an
 * unconditional assertion would be testing the fixture rather than the page.
 */
/**
 * When the library HAS hypercites, the homepage also renders the network itself —
 * the docuverse as real visible content, every dot an <a href> to a book. Seeded
 * rather than assumed, because the connected core is empty on a bare test DB and
 * an unconditional assertion would just be testing the fixture.
 */
test('a connected library renders the hypercite map on the homepage', function () {
    $admin = DB::connection('pgsql_admin');
    $cited = 'book_hsm_'.bin2hex(random_bytes(5));
    $citing = 'book_hsm_'.bin2hex(random_bytes(5));

    foreach ([[$cited, 'Home Map Cited'], [$citing, 'Home Map Citing']] as [$book, $title]) {
        $admin->table('library')->insert([
            'book' => $book, 'title' => $title, 'visibility' => 'public',
            'listed' => true, 'has_nodes' => true, 'type' => 'book',
            'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(),
        ]);
    }
    $admin->table('hypercites')->insert([
        'book' => $cited, 'hyperciteId' => 'hypercite_hsm',
        'citedIN' => json_encode(["/{$citing}#hypercite_hsm"]),
        'raw_json' => '{}', 'charData' => '{}', 'created_at' => now(),
    ]);

    Cache::forget('home-hypercite-map:v1');
    $html = $this->get('/')->assertStatus(200)->getContent();

    expect($html)->toContain('journal-hypercite-map');
    expect($html)->toContain('hypercite-figure');
    // the dots are real links into the corpus
    expect($html)->toContain('href="/'.$cited.'"');
    expect($html)->toContain('href="/'.$citing.'"');
    // connected-core mode: no faint unconnected dots
    expect($html)->not->toContain('fill-opacity="0.5"');

    // the diagram's action row holds ONLY the expand control. Scoped to the div
    // itself: a `.*?` from the class name runs on to the crawler-only link
    // further down the document and matches by accident.
    expect($html)->toContain('journal-map-actions');
    // Str::before, not Str::between: between() is after()+beforeLast(), so it
    // runs to the LAST </div> in the document and swallows the whole page.
    $actions = Str::before(Str::after($html, 'class="journal-map-actions"'), '</div>');
    expect($actions)->toContain('journal-map-expand');
    expect($actions)->not->toContain('/books');

    $admin->table('hypercites')->where('book', $cited)->delete();
    $admin->table('library')->where('book', 'like', 'book_hsm_%')->delete();
    Cache::forget('home-hypercite-map:v1');
});

/**
 * The /books link is CRAWLER-ONLY, and both halves of that are the invariant.
 *
 * It must EXIST: measured on prod 2026-10-02, the homepage map reaches 179 of
 * 323 listed books, so 144 of them (45%) have no other homepage-reachable path
 * and fall back to sitemap-only — the condition that left 322 of 324 URLs
 * unindexed in the first place.
 *
 * It must NEVER be VISIBLE: a "browse all texts" line sends a reader to a flat
 * list that is worse UX than the feeds and the map they already have. It was
 * shipped visibly twice by mistake; these assertions are what stop a third.
 */
test('the /books link is present and crawler-only, never visible copy', function () {
    $html = $this->get('/')->assertStatus(200)->getContent();

    // present and followable
    expect($html)->toMatch('/<a\s[^>]*href="\/books"/');
    // carried by the hidden-link class — the hiding is keyed on the NAME alone,
    // so this must be the class on the anchor itself
    expect($html)->toMatch('/<a\s[^>]*class="seo-crawl-link"\s[^>]*href="\/books"/');

    // and NOT dressed as visible copy: no heading, no standalone paragraph, and
    // not sitting in the map's visible action row
    expect($html)->not->toMatch('/<h[1-3][^>]*>[^<]*<a[^>]*href="\/books"/');
    expect($html)->not->toContain('copy-books-link');
    expect($html)->not->toMatch('/journal-map-actions.*?href="\/books"/s');
    expect($html)->not->toContain('Browse all texts');
    expect($html)->not->toContain('Browse every text');
});

/**
 * The hiding CSS is load-bearing: without the alias the anchor renders as a
 * visible line in the hero, which is exactly how it shipped visibly once.
 */
test('the crawl link is actually hidden by the shared utility', function () {
    $css = file_get_contents(resource_path('css/base/foundation.css'));

    $start = strpos($css, '.visually-hidden,');
    expect($start)->not->toBeFalse();

    $rule = substr($css, $start, 600);
    expect($rule)->toContain('.welcome-copy .seo-crawl-link');
    expect($rule)->toContain('clip-path: inset(50%)');
    expect($rule)->not->toContain('display: none');

    // no competing copy in homepage.css
    $homeCss = file_get_contents(resource_path('css/components/homepage.css'));
    expect($homeCss)->not->toMatch('/\.seo-crawl-link\s*\{/');
});

/**
 * The visually-hidden utility itself stays clip-path based, not display:none:
 * clipped content remains in the accessibility tree (display:none drops it) and
 * is treated as real content by crawlers. Still used for genuine text
 * alternatives and labels; just not for the homepage's crawl path.
 */
test('the shared visually-hidden utility is clipped, not display:none', function () {
    $css = file_get_contents(resource_path('css/base/foundation.css'));

    $start = strpos($css, '.visually-hidden');
    expect($start)->not->toBeFalse();

    $rule = substr($css, $start, 400);
    expect($rule)->toContain('clip-path: inset(50%)');
    expect($rule)->not->toContain('display: none');
});

/**
 * A weight budget for the homepage, because nothing else measures one.
 *
 * The hypercite map is the first thing to put real bulk in this page, and its
 * size scales with how connected the library is — so it can grow silently. The
 * number that matters to a visitor is the COMPRESSED transfer (prod serves
 * brotli: 47kB of HTML went over the wire as 14.6kB), and this is a
 * raw-HTML proxy for it, generous enough not to be a tripwire for ordinary copy
 * edits but tight enough to catch an unbounded list or a 400-dot blob.
 *
 * If this fails, check what grew before raising it: MAX_BLOB_DOTS truncation and
 * HomeController's connectedOnly flag are the two levers, and `/books` already
 * carries the complete index so the map never has to.
 */
test('the homepage stays within its HTML weight budget', function () {
    $bytes = strlen($this->get('/')->assertStatus(200)->getContent());

    expect($bytes)->toBeLessThan(150_000);
});
