<?php

/**
 * Homepage SEO prerender — the homepage used to serve three EMPTY <main> containers
 * (all content JS-injected from API/IndexedDB), so crawlers saw ~nothing on the one
 * page that should rank for "hyperlit". HomeController now server-renders the first
 * chunk of the synthetic "most-recent" book (the same sanitized card HTML the client
 * renders — see HomePageServerController) into #most-recent, plus a visually-hidden
 * <h1> and WebSite/Organization JSON-LD. The client rebuilds the container wholesale
 * on hydration (transitionToBookContent), so this markup is crawler-only.
 */

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    Cache::forget('home_prerender_html');

    // The prerender reads most-recent nodes on the DEFAULT (RLS) connection as an
    // anonymous request — that needs a public library row for 'most-recent', which
    // the bare test DB may not have (prod/dev get it from HomePageServerController).
    $admin = DB::connection('pgsql_admin');
    $this->seededMostRecentLibrary = ! $admin->table('library')->where('book', 'most-recent')->exists();
    if ($this->seededMostRecentLibrary) {
        $admin->table('library')->insert([
            'book' => 'most-recent', 'title' => 'Most Recent', 'visibility' => 'public',
            'creator' => null, 'creator_token' => null, 'timestamp' => 1000,
            'raw_json' => json_encode(['book' => 'most-recent']),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
});

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    $admin->table('nodes')->where('node_id', 'most-recent_apitest_home_card')->delete();
    if ($this->seededMostRecentLibrary ?? false) {
        $admin->table('library')->where('book', 'most-recent')->delete();
    }
    Cache::forget('home_prerender_html');
});

test('homepage server-renders the most-recent card list as a prerendered chunk', function () {
    // A marker card in chunk 0 of the synthetic most-recent book (same shape as
    // HomePageServerController::createNodesForBook writes). startLine 0 keeps it
    // clear of the real cards' positions (1..N).
    DB::connection('pgsql_admin')->table('nodes')->insert([
        'book' => 'most-recent', 'startLine' => 0, 'chunk_id' => 0,
        'node_id' => 'most-recent_apitest_home_card',
        'content' => '<p class="libraryCard" id="0">Prerender Marker Book<a href="/apitest_home"><span class="open-icon">↗</span></a></p>',
        'plainText' => 'Prerender Marker Book', 'type' => 'p',
        'footnotes' => json_encode([]), 'raw_json' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $html = $this->get('/')->assertStatus(200)->getContent();

    expect($html)->toContain('data-prerendered="true"');
    expect($html)->toContain('Prerender Marker Book');
    expect($html)->toContain('href="/apitest_home"');
});

test('homepage emits WebSite/Organization JSON-LD and a machine-readable h1', function () {
    $html = $this->get('/')->assertStatus(200)->getContent();

    expect($html)->toContain('application/ld+json');
    expect($html)->toContain('"@type":"WebSite"');
    expect($html)->toContain('"@type":"Organization"');
    expect($html)->toContain('<h1');
    expect($html)->toContain('Hyperlit — read, write and publish hypertext literature');
});

test('homepage survives an empty most-recent book (empty <main>, no error)', function () {
    // Force the cache to the empty-prerender state without touching the real rows.
    Cache::put('home_prerender_html', '', 900);

    $html = $this->get('/')->assertStatus(200)->getContent();

    expect($html)->toContain('id="most-recent"');
    expect($html)->not->toContain('data-prerendered="true"');
});
