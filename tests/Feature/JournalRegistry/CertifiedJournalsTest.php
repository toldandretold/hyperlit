<?php

/**
 * What certification puts on the HOMEPAGE. The toggle that sets the flag, and the console
 * payloads that carry it, are admin API surface and live in Feature/Api/JournalImportConsoleTest.
 *
 * Two gates, tested separately because they fail in opposite directions. `certified_at` is a
 * human vouching — nothing automatic may grant it. The readable-article floor is the half that
 * SELF-HEALS: a certified journal whose lanes all lose their content drops off the homepage on
 * the next request, so the list can never link to an empty /j/{slug} page and nobody has to
 * remember to un-certify.
 *
 * Seeds via pgsql_admin with beforeEach-only cleanup (an afterEach admin delete deadlocks
 * against the still-open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function certDb()
{
    return DB::connection('pgsql_admin');
}

function certCleanup(): void
{
    certDb()->table('canonical_source')->where('title', 'LIKE', 'Cert %')->delete();
    certDb()->table('library')->where('book', 'LIKE', 'book_cert%')->delete();
    certDb()->table('journal_sources')->where('display_name', 'LIKE', 'Cert %')->delete();
}

beforeEach(fn () => certCleanup());

function certSeedJournal(array $opts = []): object
{
    $row = array_merge([
        'id'                 => (string) Str::uuid(),
        'openalex_source_id' => 'SCERT' . Str::upper(Str::random(6)),
        'display_name'       => 'Cert Journal',
        'publisher'          => 'Cert Press',
        'slug'               => 'cert-' . Str::lower(Str::random(8)),
        'is_diamond'         => true,
        'cited_by_count'     => 100,
        'works_count'        => 5,
        'created_at'         => now(),
        'updated_at'         => now(),
    ], $opts);
    certDb()->table('journal_sources')->insert($row);

    return (object) $row;
}

/** A work for the journal; $version null = citation-only (nothing readable). */
function certSeedWork(string $journalId, ?array $version = []): void
{
    $book = null;
    if ($version !== null) {
        $book = 'book_cert_' . Str::lower(Str::random(8));
        certDb()->table('library')->insert(array_merge([
            'book'       => $book,
            'title'      => 'Cert Version',
            'visibility' => 'public',
            'listed'     => true,
            'has_nodes'  => true,
            'type'       => 'book',
            'raw_json'   => '[]',
            'timestamp'  => 0,
            'created_at' => now(),
        ], $version));
    }

    certDb()->table('canonical_source')->insert([
        'id'                => (string) Str::uuid(),
        'title'             => 'Cert Work',
        'journal_source_id' => $journalId,
        'auto_version_book' => $book,
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);
}

test('a certified journal with a readable article is listed on the homepage', function () {
    $journal = certSeedJournal(['display_name' => 'Cert Listed Journal', 'certified_at' => now()]);
    certSeedWork($journal->id);
    certSeedWork($journal->id);

    $html = $this->get('/')->assertOk()->getContent();

    expect($html)->toContain('We are currently importing, and systematically hyperciting, diamond open access journals:');
    expect($html)->toContain('href="/j/' . $journal->slug . '"');
    expect($html)->toContain('Cert Listed Journal · 2 articles');
});

test('the count is singular for one article', function () {
    $journal = certSeedJournal(['display_name' => 'Cert Single', 'certified_at' => now()]);
    certSeedWork($journal->id);

    $html = $this->get('/')->assertOk()->getContent();

    expect($html)->toContain('Cert Single · 1 article <span class="open-icon">');
});

test('an uncertified journal is not listed, however readable it is', function () {
    $journal = certSeedJournal(['display_name' => 'Cert Not Certified']);
    certSeedWork($journal->id);

    $html = $this->get('/')->assertOk()->getContent();

    expect($html)->not->toContain('Cert Not Certified');
    expect($html)->not->toContain('href="/j/' . $journal->slug . '"');
});

test('a certified journal with nothing readable is dropped, not linked to an empty page', function () {
    // The self-healing gate: certification stands, but there is nothing to read —
    // one work with no version at all, one whose version has no nodes.
    $journal = certSeedJournal(['display_name' => 'Cert Empty Journal', 'certified_at' => now()]);
    certSeedWork($journal->id, null);
    certSeedWork($journal->id, ['has_nodes' => false]);

    $html = $this->get('/')->assertOk()->getContent();

    expect($html)->not->toContain('Cert Empty Journal');
    expect($html)->not->toContain('href="/j/' . $journal->slug . '"');
});

test('with nothing certified the whole block is absent, not an empty list', function () {
    certSeedJournal();

    $html = $this->get('/')->assertOk()->getContent();

    expect($html)->not->toContain('diamond open access journals:');
    expect($html)->not->toContain('copy-journal-list');
});

test('homepage journal links are keyboard-inert (Tab is chrome-only in .welcome-copy)', function () {
    $journal = certSeedJournal(['display_name' => 'Cert Tabbable', 'certified_at' => now()]);
    certSeedWork($journal->id);

    $html = $this->get('/')->assertOk()->getContent();

    // The a11y contract for .welcome-copy: content links are reached by the
    // contentHopper (n/p), never by Tab. tests/e2e/specs/a11y/keyboard.spec.js
    // fails on any Tab stop inside .welcome-copy.
    expect($html)->toContain('<a href="/j/' . $journal->slug . '" tabindex="-1">');
});
