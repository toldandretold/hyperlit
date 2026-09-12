<?php

/**
 * PublisherYearRepair — correcting a work's year from the publisher's own article page.
 *
 * The case that motivated it: tripleC's `10.31269/triplec.v1i1.2` is deposited at CROSSREF as
 * `issued: 1970-01-01` and OpenAlex copied it faithfully, so neither registry can fix it. 1970-01-01
 * is the Unix epoch — a null date serialised as a real one in the publisher's deposit pipeline. The
 * article's own OJS page says `citation_date: 2003`.
 */

use App\Services\CanonicalVersions\PublisherYearRepair;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function pyrDb()
{
    return DB::connection('pgsql_admin');
}

function pyrCleanup(): void
{
    $ids = pyrDb()->table('canonical_source')->where('title', 'LIKE', 'PYR %')->pluck('id');
    if ($ids->isNotEmpty()) {
        pyrDb()->table('library')->whereIn('canonical_source_id', $ids)->delete();
    }
    pyrDb()->table('canonical_source')->where('title', 'LIKE', 'PYR %')->delete();
}

beforeEach(fn () => pyrCleanup());
afterEach(fn () => pyrCleanup());

function pyrOjsPage(string $year, string $volume = '1', string $issue = '1'): string
{
    return <<<HTML
    <html><head>
    <meta name="citation_journal_title" content="tripleC"/>
    <meta name="citation_date" content="{$year}"/>
    <meta name="citation_volume" content="{$volume}"/>
    <meta name="citation_issue" content="{$issue}"/>
    </head><body><p>Body.</p></body></html>
    HTML;
}

test('reads year, volume and issue out of OJS citation meta', function () {
    $found = app(PublisherYearRepair::class)->extractFromPage(pyrOjsPage('2003'));

    expect($found['year'])->toBe(2003);
    expect($found['volume'])->toBe('1');
    expect($found['issue'])->toBe('1');
});

test('accepts the date formats publishers actually emit', function () {
    $repair = app(PublisherYearRepair::class);

    // A bare year (OJS), a slashed date (Highwire), an ISO date, and the reversed attribute order
    // that some templates produce. The year is the only part used, so the parse is deliberately
    // loose rather than a date parse.
    expect($repair->extractFromPage('<meta name="citation_date" content="2003">')['year'])->toBe(2003);
    expect($repair->extractFromPage('<meta name="citation_publication_date" content="2015/03/12">')['year'])->toBe(2015);
    expect($repair->extractFromPage('<meta name="citation_date" content="2019-11-04">')['year'])->toBe(2019);
    expect($repair->extractFromPage('<meta content="2008" name="DC.Date">')['year'])->toBe(2008);
});

test('a page with no date at all yields nothing rather than a guess', function () {
    $repair = app(PublisherYearRepair::class);

    expect($repair->extractFromPage('<html><head><title>No dates here</title></head></html>'))->toBeNull();
    // A volume number is not a year, and must never be mistaken for one.
    expect($repair->extractFromPage('<meta name="citation_volume" content="12">'))->toBeNull();
});

test('applying a correction rewrites the canonical, every lane, and the rendered bibtex', function () {
    $canonicalId = (string) Str::uuid();
    pyrDb()->table('canonical_source')->insert([
        'id' => $canonicalId, 'title' => 'PYR Co-operation and Self-Organization',
        'year' => 1970, 'created_at' => now(), 'updated_at' => now(),
    ]);

    foreach (['book_pyr_pdf', 'book_pyr_html'] as $book) {
        pyrDb()->table('library')->insert([
            'book' => $book, 'canonical_source_id' => $canonicalId, 'title' => 'PYR',
            'year' => '1970', 'visibility' => 'public', 'raw_json' => '{}',
            'bibtex' => "@article{pyr2003,\n  title = {PYR},\n  year = {1970},\n}",
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    $lanes = app(PublisherYearRepair::class)
        ->apply($canonicalId, ['year' => 2003, 'volume' => '1', 'issue' => '1']);

    expect($lanes)->toBe(2);
    expect((int) pyrDb()->table('canonical_source')->where('id', $canonicalId)->value('year'))->toBe(2003);

    foreach (['book_pyr_pdf', 'book_pyr_html'] as $book) {
        $row = pyrDb()->table('library')->where('book', $book)->first();
        expect($row->year)->toBe('2003');
        // Cards render the stored bibtex in PREFERENCE to the structured columns, so patching only
        // the column would leave the visible citation showing 1970 forever.
        expect($row->bibtex)->toContain('year = {2003}');
        expect($row->bibtex)->not->toContain('1970');
    }
});

test('volume and issue FILL but never overwrite', function () {
    $canonicalId = (string) Str::uuid();
    pyrDb()->table('canonical_source')->insert([
        'id' => $canonicalId, 'title' => 'PYR Already Has Volume',
        'year' => 1970, 'volume' => '7', 'created_at' => now(), 'updated_at' => now(),
    ]);

    app(PublisherYearRepair::class)->apply($canonicalId, ['year' => 2003, 'volume' => '1', 'issue' => '2']);

    $row = pyrDb()->table('canonical_source')->where('id', $canonicalId)->first();
    // The year is the field we have positive evidence is broken. A publisher page's volume string
    // is not obviously better than one already stored, so it only fills a gap.
    expect($row->volume)->toBe('7');
    expect($row->issue)->toBe('2');
    expect((int) $row->year)->toBe(2003);
});
