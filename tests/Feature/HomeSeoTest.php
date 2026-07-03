<?php

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
