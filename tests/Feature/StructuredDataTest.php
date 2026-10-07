<?php

/**
 * JSON-LD and <html lang> across the public page types.
 *
 * Structured data is how Google resolves an ENTITY rather than a bag of words,
 * which is the whole problem here: "hyperlit" is contested by an npm package,
 * two other GitHub projects and a SourceForge project, and the site's own
 * GitHub repo outranks it for its own name. What these tests lock:
 *  - a book declares where it sits (BreadcrumbList), because two thirds of the
 *    corpus still lives at an opaque /book_1790421435416 that tells a searcher
 *    nothing;
 *  - a user page is a typed identity at all — it emitted NO structured data;
 *  - the homepage's JSON-LD description MATCHES its meta description, which
 *    were two divergent strings describing one site;
 *  - <html lang> follows the book, which was hardcoded "en" over a corpus
 *    holding de/es/it/nl works.
 */

use Illuminate\Support\Facades\DB;

function seedSdBook(array $attrs = []): string
{
    $book = 'book_sd_'.bin2hex(random_bytes(6));

    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'Structured Subject',
        'author' => 'SD Author',
        'visibility' => 'public',
        'listed' => true,
        'creator' => 'structureddatatest',
        'timestamp' => (int) (microtime(true) * 1000),
        'raw_json' => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $attrs, ['book' => $book]));

    DB::connection('pgsql_admin')->table('nodes')->insert([
        'book' => $book, 'startLine' => 0, 'chunk_id' => 0,
        'node_id' => $book.'_n0', 'content' => '<p>Body</p>',
        'plainText' => 'Body', 'type' => 'p', 'footnotes' => json_encode([]),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return $book;
}

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    foreach (['nodes', 'library'] as $table) {
        $admin->table($table)->where('book', 'like', 'book_sd_%')->delete();
    }
});

// Admin-connection user fixture (commits escape RefreshDatabase): random name,
// cleaned up in beforeEach — the UserPageSeoTest pattern. A real users row is
// required because RLS matches ownership on user_token, not the name.
beforeEach(function () {
    DB::connection('pgsql_admin')->table('users')
        ->where('email', 'like', '%@sdtest.test')->delete();
});

function seedSdOwner(): \App\Models\User
{
    $unique = 'sdowner_'.\Illuminate\Support\Str::random(8);
    $id = DB::connection('pgsql_admin')->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique.'@sdtest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) \Illuminate\Support\Str::uuid(),
        'status'     => 'budget',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return \App\Models\User::on('pgsql_admin')->find($id);
}

/** Every JSON-LD block on the page, decoded. */
function jsonLdBlocks(object $test, string $url): array
{
    $html = $test->get($url)->assertStatus(200)->getContent();

    preg_match_all(
        '/<script type="application\/ld\+json">(.*?)<\/script>/s',
        $html,
        $m
    );

    return array_values(array_filter(array_map(
        fn ($raw) => json_decode(trim($raw), true),
        $m[1] ?? []
    )));
}

test('a book page declares a BreadcrumbList through Hyperlit and /books', function () {
    $book = seedSdBook(['title' => 'Breadcrumbed Work']);

    $blocks = jsonLdBlocks($this, "/{$book}");

    expect($blocks)->not->toBeEmpty();
    $crumb = $blocks[0]['breadcrumb'] ?? null;

    expect($crumb)->not->toBeNull();
    expect($crumb['@type'])->toBe('BreadcrumbList');
    expect($crumb['itemListElement'])->toHaveCount(3);
    expect($crumb['itemListElement'][0]['item'])->toBe(url('/'));
    // the trail must point at the real index page, not an invented one
    expect($crumb['itemListElement'][1]['item'])->toBe(url('/books'));
    expect($crumb['itemListElement'][2]['name'])->toBe('Breadcrumbed Work');
});

test('a book page is still typed as the work, not just a breadcrumb host', function () {
    $book = seedSdBook(['title' => 'Typed Work', 'journal' => null]);

    $blocks = jsonLdBlocks($this, "/{$book}");

    expect($blocks[0]['@type'])->toBe('Book');
    expect($blocks[0]['name'])->toBe('Typed Work');
});

test('an article (one with a journal) is typed ScholarlyArticle', function () {
    $book = seedSdBook(['title' => 'Journal Piece', 'journal' => 'tripleC']);

    $blocks = jsonLdBlocks($this, "/{$book}");

    expect($blocks[0]['@type'])->toBe('ScholarlyArticle');
    expect($blocks[0]['isPartOf']['name'])->toBe('tripleC');
});

test('<html lang> follows the book language, and is OMITTED when unknown', function () {
    // An unknown language emits NO lang attribute. It used to default to "en",
    // which asserted English for 295,076 of ~295,290 books on no evidence —
    // and a WRONG lang is worse than none: it fights the browser's own
    // content-based language detection, which is what decides whether a
    // translation is offered. "Unknown" now means neither declared
    // (library.language) nor detected (library.language_detected — see the
    // detected-fallback test below).
    $german = seedSdBook(['title' => 'Ein Deutsches Werk', 'language' => 'de']);
    $none = seedSdBook(['title' => 'No Language Given', 'language' => null]);

    expect($this->get("/{$german}")->getContent())->toContain('<html lang="de">');

    $noneHtml = $this->get("/{$none}")->getContent();
    expect($noneHtml)->toContain('<html>');
    expect($noneHtml)->not->toContain('<html lang=');
});

test('a junk language value is dropped rather than emitted as a lang attribute', function () {
    // The column is varchar(10) free text, so the realistic junk is a name or
    // a wrong separator rather than a sentence. A malformed lang attribute is
    // worse than none — and so is a guessed one, so junk omits rather than
    // falling back to "en".
    foreach (['English', 'en_US', '12', '--'] as $junk) {
        $book = seedSdBook(['title' => 'Junk '.$junk, 'language' => $junk]);

        expect($this->get("/{$book}")->getContent())
            ->not->toContain('<html lang=');
    }

    // a legitimate regional tag IS kept
    $regional = seedSdBook(['title' => 'Regional Tag', 'language' => 'pt-br']);
    expect($this->get("/{$regional}")->getContent())->toContain('<html lang="pt-br">');
});

test('a detected language fills <html lang> when nothing is declared, and declared wins', function () {
    // library.language_detected (BookLanguageDetector, confidence-floored) is
    // the fallback for <html lang> ONLY. A declared value always wins — the
    // detected value is a guess about the page's text, the declared one is
    // the owner's/import's statement.
    $detected = seedSdBook(['title' => 'Nur Erkannt', 'language' => null, 'language_detected' => 'de']);
    $both = seedSdBook(['title' => 'Beides Gesetzt', 'language' => 'fr', 'language_detected' => 'de']);
    $junkDetected = seedSdBook(['title' => 'Junk Detected', 'language' => null, 'language_detected' => 'English']);

    expect($this->get("/{$detected}")->getContent())->toContain('<html lang="de">');
    expect($this->get("/{$both}")->getContent())->toContain('<html lang="fr">');
    // a junk detected value is normalised away exactly like a junk declared one
    expect($this->get("/{$junkDetected}")->getContent())->not->toContain('<html lang=');
});

test('a detected language NEVER reaches the bibliographic metadata', function () {
    // citation_language and JSON-LD inLanguage are CLAIMS ABOUT THE WORK —
    // declared-only, and they must keep ignoring language_detected however
    // confident the detection is.
    $book = seedSdBook(['title' => 'Detected Only Meta', 'language' => null, 'language_detected' => 'de']);

    $html = $this->get("/{$book}")->getContent();
    expect($html)->toContain('<html lang="de">');      // the one place it may appear
    expect($html)->not->toContain('citation_language');
    expect($html)->not->toContain('inLanguage');
});

test('app chrome still declares English, since it really is English UI', function () {
    // The reader omits what it does not know; Hyperlit's OWN pages are not
    // books and do know. Guards against the omission leaking into app chrome.
    expect($this->get('/')->getContent())->toContain('<html lang="en">');
});

test('a junk or absent language never reaches the bibliographic metadata', function () {
    // citation_language and JSON-LD inLanguage are CLAIMS ABOUT THE WORK, so
    // they are declared-only and normalised: a value correctly rejected for
    // <html lang> must not sail through to Google Scholar instead.
    $junk = seedSdBook(['title' => 'Junk Lang Meta', 'language' => 'en_US']);
    $none = seedSdBook(['title' => 'No Lang Meta', 'language' => null]);

    foreach ([$junk, $none] as $book) {
        $html = $this->get("/{$book}")->getContent();
        expect($html)->not->toContain('citation_language');
        expect($html)->not->toContain('inLanguage');
    }

    $good = seedSdBook(['title' => 'Good Lang Meta', 'language' => 'DE']);
    $goodHtml = $this->get("/{$good}")->getContent();
    // normalised to lower case on the way out
    expect($goodHtml)->toContain('name="citation_language" content="de"');
    expect($goodHtml)->toContain('"inLanguage":"de"');
});

test('the homepage JSON-LD description matches its meta description', function () {
    $html = $this->get('/')->assertStatus(200)->getContent();

    preg_match('/<meta name="description" content="([^"]+)"/', $html, $meta);
    $metaDescription = html_entity_decode($meta[1] ?? '', ENT_QUOTES | ENT_HTML5);

    expect($metaDescription)->not->toBe('');
    // Google truncates the snippet around 160 characters
    expect(strlen($metaDescription))->toBeLessThanOrEqual(160);
    // and the old copy shipped this typo live into meta, og: and twitter:
    expect($metaDescription)->not->toContain('epubc');

    $blocks = jsonLdBlocks($this, '/');
    $graph = $blocks[0]['@graph'] ?? [];
    $website = collect($graph)->firstWhere('@type', 'WebSite');

    expect($website)->not->toBeNull();
    expect($website['description'])->toBe($metaDescription);
    // the contested-name problem: every form the entity is searched by
    expect($website['alternateName'])->toContain('hyperlit.io');
});

test('the homepage title carries a disambiguating qualifier, not the bare name', function () {
    $html = $this->get('/')->assertStatus(200)->getContent();

    preg_match('/<title>(.*?)<\/title>/s', $html, $m);
    $title = html_entity_decode(trim($m[1] ?? ''), ENT_QUOTES | ENT_HTML5);

    expect($title)->toContain('Hyperlit');
    expect($title)->not->toBe('Hyperlit');
    expect(mb_strlen($title))->toBeLessThanOrEqual(62);
});

test('/home canonicalizes to the homepage rather than competing with it', function () {
    $html = $this->get('/home')->assertStatus(200)->getContent();

    expect($html)->toContain('<link rel="canonical" href="'.url('/').'">');
    expect($html)->not->toContain('<link rel="canonical" href="'.url('/home').'">');
});

test('an app surface is noindex+follow, not indexable alongside the book', function () {
    $book = seedSdBook(['title' => 'Time Machined']);

    $html = $this->get("/{$book}/timemachine?at=1700000000000")
        ->assertStatus(200)->getContent();

    expect($html)->toContain('<meta name="robots" content="noindex, follow">');
});

test('a real book page is NOT noindexed', function () {
    $book = seedSdBook(['title' => 'Indexable Work']);

    expect($this->get("/{$book}")->getContent())->not->toContain('name="robots"');
});

/*
 * The soft-404 shell class (GSC "Duplicate, Google chose different canonical
 * than user", 2026-10): any identifier the server can't see — a typo, a deleted
 * book, a private book under RLS — used to serve a byte-identical indexable 200
 * shell. The 200 stays (the local-first create flow renders through this
 * branch); the shell itself is noindexed.
 */

test('an unknown identifier serves the shell with noindex (soft-404 class)', function () {
    $html = $this->get('/zz-no-such-book-'.bin2hex(random_bytes(4)))
        ->assertStatus(200)->getContent();

    expect($html)->toContain('<meta name="robots" content="noindex, follow">');
});

test('a PRIVATE book is an unserveable shell for an anonymous visitor → noindex', function () {
    $book = seedSdBook(['visibility' => 'private', 'creator' => 'sd_owner_1']);

    $html = $this->get("/{$book}")->assertStatus(200)->getContent();

    expect($html)->toContain('<meta name="robots" content="noindex, follow">');
});

test('the OWNER of a private book gets the real page, never noindex', function () {
    // RLS matches ownership on users.user_token (resolved by the session-context
    // middleware from a real users row), so the owner's session sees the nodes
    // and takes the database branch.
    $owner = seedSdOwner();
    $book = seedSdBook(['visibility' => 'private', 'creator' => $owner->name]);

    $html = $this->actingAs($owner)->get("/{$book}")->assertStatus(200)->getContent();

    expect($html)->not->toContain('name="robots"');
});

test('showNested serves a private book\'s shell with noindex too (/{book}/{rest})', function () {
    // Same soft-404 shape at a deep URL: the chain cannot resolve under RLS, so
    // the generic shell is served — it must not be indexable either.
    $book = seedSdBook(['visibility' => 'private', 'creator' => 'sd_owner_1']);

    $html = $this->get("/{$book}/1/Fn123")->assertStatus(200)->getContent();

    expect($html)->toContain('<meta name="robots" content="noindex, follow">');
});

test('a book with a DOI declares its external identity via sameAs', function () {
    $book = seedSdBook([
        'title' => 'Identified Work',
        'doi' => '10.1332/27523349y2025d000000066',
        'openalex_id' => 'W7123740518',
    ]);

    $blocks = jsonLdBlocks($this, "/{$book}");
    $sameAs = $blocks[0]['sameAs'] ?? null;

    // These links exist on the page already — in the source container's
    // citation line — but that panel is EMPTY until a user opens it, so a
    // crawler never sees them.
    expect($sameAs)->toContain('https://doi.org/10.1332/27523349y2025d000000066');
    expect($sameAs)->toContain('https://openalex.org/W7123740518');

    // citation_doi keeps the BARE identifier — Scholar's tag wants the id, not a link
    $html = $this->get("/{$book}")->getContent();
    expect($html)->toContain('<meta name="citation_doi" content="10.1332/27523349y2025d000000066">');
});

test('an already-resolved DOI is not double-prefixed, and junk is dropped', function () {
    // free-text column fed by several harvest paths: a stored doi.org URL would
    // otherwise become https://doi.org/https://doi.org/10...
    $resolved = seedSdBook(['title' => 'Resolved Doi', 'doi' => 'https://doi.org/10.1234/abcd']);
    expect(jsonLdBlocks($this, "/{$resolved}")[0]['sameAs'])
        ->toBe(['https://doi.org/10.1234/abcd']);

    // a malformed sameAs asserts a FALSE identity — worse than none
    $junk = seedSdBook(['title' => 'Junk Doi', 'doi' => 'not-a-doi', 'openalex_id' => 'nonsense']);
    expect(jsonLdBlocks($this, "/{$junk}")[0]['sameAs'] ?? null)->toBeNull();
});

test('a book with no external identifiers omits sameAs entirely', function () {
    $book = seedSdBook(['title' => 'Unidentified Work', 'doi' => null, 'openalex_id' => null]);

    expect(jsonLdBlocks($this, "/{$book}")[0])->not->toHaveKey('sameAs');
});
