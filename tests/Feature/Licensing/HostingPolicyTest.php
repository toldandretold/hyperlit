<?php

/**
 * HostingPolicy end to end: web evidence and all-rights-reserved copies are HELD, not published —
 * the backfill, the write paths, the reader-facing fallbacks, and what it must never touch.
 */

use App\Services\CitationReview\Report\ClaimMarkdownFormatter;
use App\Services\Licensing\HostingPolicy;
use App\Services\Licensing\LicenseDiscovery;
use App\Services\Licensing\RestrictedSourceRows;
use Illuminate\Support\Facades\DB;

afterEach(function () {
    $db = DB::connection('pgsql_admin');
    $db->table('nodes')->where('book', 'like', 'hpol\_%')->delete();
    $db->table('library')->where('book', 'like', 'hpol\_%')->delete();
});

function hpolSeed(string $book, array $attrs = []): void
{
    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book, 'title' => "Title {$book}", 'visibility' => 'public', 'creator' => 'OpenAlex',
        'license' => 'All-Rights-Reserved', 'has_nodes' => true, 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ], $attrs));
}

function hpolRow(string $book): object
{
    return DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->first(['visibility', 'license', 'held_reason', 'timestamp']);
}

test('backfill: dry run writes nothing; --apply holds web pages and ARR copies, never a user book or an open licence', function () {
    hpolSeed('hpol_web', ['creator' => 'WebFetch', 'type' => 'web_source', 'license' => 'CC-BY-SA-4.0-NO-AI', 'url' => 'https://news.example/a']);
    hpolSeed('hpol_closed');
    hpolSeed('hpol_open', ['license' => 'CC-BY-4.0']);
    hpolSeed('hpol_stub', ['has_nodes' => false]); // no text held → nothing to unpublish
    hpolSeed('hpol_mine', ['creator' => 'someone', 'canonical_match_method' => 'user_verified']);
    $books = ['--book' => ['hpol_web', 'hpol_closed', 'hpol_open', 'hpol_stub', 'hpol_mine']];

    $this->artisan('library:unpublish-restricted', $books)->expectsOutputToContain('Would make private: 1 web evidence page(s), 1 hosted')->assertSuccessful();
    expect(hpolRow('hpol_web')->visibility)->toBe('public');

    $this->artisan('library:unpublish-restricted', $books + ['--apply' => true])->assertSuccessful();

    $web = hpolRow('hpol_web');
    expect($web->visibility)->toBe('private');
    expect($web->license)->toBe('Unknown'); // never the user's-own-writing default
    expect($web->held_reason)->toBe('licence');
    expect((int) $web->timestamp)->toBeGreaterThan(1000);
    expect(hpolRow('hpol_closed')->visibility)->toBe('private');
    expect(hpolRow('hpol_open')->visibility)->toBe('public');
    expect(hpolRow('hpol_stub')->visibility)->toBe('public');
    expect(hpolRow('hpol_mine')->visibility)->toBe('public');
});

test('discovery: an ARR verdict holds a hosted copy, and a later open licence un-holds only what the policy held', function () {
    hpolSeed('hpol_green', ['license' => 'Unknown']);
    hpolSeed('hpol_chosen_private', ['license' => 'Unknown', 'visibility' => 'private']); // private for another reason

    LicenseDiscovery::apply(DB::connection('pgsql_admin')->table('library')->where('book', 'hpol_green')->first(),
        ['license' => 'All-Rights-Reserved', 'source' => 'crossref']);
    expect(hpolRow('hpol_green')->visibility)->toBe('private');

    LicenseDiscovery::apply(DB::connection('pgsql_admin')->table('library')->where('book', 'hpol_green')->first(),
        ['license' => 'CC-BY-4.0', 'source' => 'fetch_trace']);
    expect(hpolRow('hpol_green')->visibility)->toBe('public');
    expect(hpolRow('hpol_green')->held_reason)->toBeNull();

    LicenseDiscovery::apply(DB::connection('pgsql_admin')->table('library')->where('book', 'hpol_chosen_private')->first(),
        ['license' => 'CC-BY-4.0', 'source' => 'crossref']);
    expect(hpolRow('hpol_chosen_private')->visibility)->toBe('private');
});

test('a fetched closed copy is settled from the trace and held; an open repository copy stays public', function () {
    hpolSeed('hpol_vac_closed', ['license' => 'All-Rights-Reserved', 'oa_status' => 'closed']);
    hpolSeed('hpol_vac_green', ['license' => 'All-Rights-Reserved', 'oa_status' => 'closed']);

    HostingPolicy::settleFetchedCopy('hpol_vac_closed', []);
    HostingPolicy::settleFetchedCopy('hpol_vac_green', ['won_license' => 'https://creativecommons.org/licenses/by/4.0/']);

    expect(hpolRow('hpol_vac_closed')->visibility)->toBe('private');
    $green = hpolRow('hpol_vac_green');
    expect($green->license)->toBe('CC-BY-4.0');
    expect($green->visibility)->toBe('public');
});

test('a held page answers an anonymous reader with its citation and the original — never the text', function () {
    hpolSeed('hpol_held', ['creator' => 'WebFetch', 'type' => 'web_source', 'visibility' => 'private',
        'title' => 'Minister quits', 'url' => 'https://www.news.example/minister', 'author' => 'Reporter, A.']);
    DB::connection('pgsql_admin')->table('nodes')->insert([
        'book' => 'hpol_held', 'startLine' => 100, 'chunk_id' => 0, 'node_id' => 'hpol_held_n1',
        'content' => '<p>SECRET BODY TEXT</p>', 'plainText' => 'SECRET BODY TEXT',
    ]);

    $res = $this->get('/hpol_held');

    $res->assertOk();
    $res->assertSee('Minister quits');
    $res->assertSee('https://www.news.example/minister', false);
    $res->assertSee('news.example');
    $res->assertDontSee('SECRET BODY TEXT');
});

test('the review report links a held source to the original, a public one in-app', function () {
    $fmt = app(ClaimMarkdownFormatter::class);
    $held = $fmt->buildSourceMd(['source_title' => 'Minister quits', 'has_source_content' => true, 'source_book_id' => 'web_x',
        'source_type' => 'web_source', 'source_url' => 'https://news.example/m', 'source_is_public' => false]);
    expect($held)->toContain('(https://news.example/m)')->not->toContain('](/web');

    $public = $fmt->buildSourceMd(['source_title' => 'Open paper', 'has_source_content' => true, 'source_book_id' => 'open1',
        'source_is_public' => true]);
    expect($public)->toContain('](/open1)');
});

test('a bibliography card for a held source says web stub + original url + not readable', function () {
    hpolSeed('hpol_card', ['creator' => 'WebFetch', 'type' => 'web_source', 'visibility' => 'private', 'url' => 'https://news.example/c']);
    $refs = collect([(object) ['source_id' => 'hpol_card', 'source_type' => null, 'source_url' => null, 'source_has_nodes' => null]]);

    RestrictedSourceRows::fill($refs);

    expect($refs[0]->source_type)->toBe('web_source');
    expect($refs[0]->source_url)->toBe('https://news.example/c');
    expect($refs[0]->source_has_nodes)->toBeFalse();
});
