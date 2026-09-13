<?php

/**
 * Citation metadata reconciled against the publisher's own page: the plausibility floor, the
 * correct-vs-flag split, and the fence that keeps a metadata flag out of the reconvert queue.
 *
 * The case behind all of it: tripleC's `10.31269/triplec.v1i1.2` is deposited at CROSSREF as
 * `issued: 1970-01-01` and OpenAlex copied it faithfully, so no registry can fix it — 1970-01-01
 * is the Unix epoch, a null date serialised as a real one in the publisher's deposit pipeline.
 * Two things can: the article's own OJS page (`citation_date: 2003`), and the fact that the
 * journal did not exist before 2003.
 */

use App\Models\ConversionFlag;
use App\Services\Conversion\ReconvertQueue;
use App\Services\Metadata\JournalYearFloor;
use App\Services\Metadata\MetadataDriftDetector;
use App\Services\Metadata\PublisherPageMetadata;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

function mdDb()
{
    return DB::connection('pgsql_admin');
}

/**
 * Clean in beforeEach ONLY. These rows are written through `pgsql_admin`, which escapes
 * RefreshDatabase's transaction — an afterEach delete of an admin-committed row waits on a
 * rollback that has not happened yet and hangs forever.
 */
function mdCleanup(): void
{
    $ids = mdDb()->table('canonical_source')->where('title', 'LIKE', 'MDD %')->pluck('id');
    if ($ids->isNotEmpty()) {
        $books = mdDb()->table('library')->whereIn('canonical_source_id', $ids)->pluck('book');
        foreach ($books as $book) {
            File::deleteDirectory(resource_path("markdown/{$book}"));
        }
        DB::table('conversion_flags')->whereIn('book', $books)->delete();
        mdDb()->table('library')->whereIn('canonical_source_id', $ids)->delete();
    }
    mdDb()->table('canonical_source')->where('title', 'LIKE', 'MDD %')->delete();
    mdDb()->table('journal_sources')->where('display_name', 'LIKE', 'MDD %')->delete();
}

beforeEach(fn () => mdCleanup());

/** The DOI every fixture work carries, so a page can prove it is that work. */
const MDD_DOI = '10.31269/triplec.v1i1.2';

function mdOjsPage(string $year, string $volume = '1', string $issue = '1', string $doi = MDD_DOI): string
{
    return <<<HTML
    <html><head>
    <meta name="citation_journal_title" content="tripleC"/>
    <meta name="citation_author" content="Christian Fuchs"/>
    <meta name="citation_title" content="MDD Co-operation and Self-Organization"/>
    <meta name="citation_doi" content="{$doi}"/>
    <meta name="citation_date" content="{$year}"/>
    <meta name="citation_volume" content="{$volume}"/>
    <meta name="citation_issue" content="{$issue}"/>
    <meta name="citation_firstpage" content="1"/>
    <meta name="citation_lastpage" content="52"/>
    </head><body><p>Body.</p></body></html>
    HTML;
}

/** A journal whose registry row carries a plausibility floor. */
function mdJournal(?int $firstYear = 2003): string
{
    $id = (string) Str::uuid();
    mdDb()->table('journal_sources')->insert([
        'id' => $id,
        'openalex_source_id' => 'S' . substr(str_replace('-', '', $id), 0, 12),
        'display_name' => 'MDD tripleC',
        'slug' => 'mdd-triplec-' . substr($id, 0, 8),
        'first_year' => $firstYear,
        'first_year_source' => $firstYear ? 'doaj_oa_start' : null,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    return $id;
}

/** A canonical with one library lane, optionally with a publisher page on disk. */
function mdWork(?int $year, ?string $journalId = null, ?string $pageHtml = null, string $pageFile = 'original.html'): array
{
    $canonicalId = (string) Str::uuid();
    $book = 'book_mdd_' . substr((string) Str::uuid(), 0, 8);
    $doi = MDD_DOI . '.' . substr($canonicalId, 0, 8);

    mdDb()->table('canonical_source')->insert([
        'id' => $canonicalId, 'title' => 'MDD Co-operation and Self-Organization',
        'year' => $year, 'journal_source_id' => $journalId, 'auto_version_book' => $book,
        // Unique per work: the canonical_source DOI column is indexed and the matcher dedupes on
        // it, so a shared literal would collide across fixtures.
        'doi' => $doi,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    mdDb()->table('library')->insert([
        'book' => $book, 'canonical_source_id' => $canonicalId, 'title' => 'MDD',
        'year' => $year !== null ? (string) $year : null, 'visibility' => 'public', 'raw_json' => '{}',
        'bibtex' => "@article{mdd,\n  title = {MDD},\n  year = {" . ($year ?? '') . "},\n}",
        'created_at' => now(), 'updated_at' => now(),
    ]);

    if ($pageHtml !== null) {
        // Point the fixture page's citation_doi at THIS work, so it passes the identity check the
        // detector runs before trusting any page. A test that wants a mismatch writes its own DOI
        // into the page and is left alone here.
        $pageHtml = str_replace('content="' . MDD_DOI . '"', 'content="' . $doi . '"', $pageHtml);

        File::ensureDirectoryExists(resource_path("markdown/{$book}"));
        File::put(resource_path("markdown/{$book}/{$pageFile}"), $pageHtml);
    }

    return [$canonicalId, $book];
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

test('reads the whole citation set, not just the four tags the import used to keep', function () {
    $found = app(PublisherPageMetadata::class)->extractAll(mdOjsPage('2003'));

    expect($found['year'])->toBe(2003);
    expect($found['volume'])->toBe('1');
    expect($found['issue'])->toBe('1');
    expect($found['pages'])->toBe('1–52');
    expect($found['authors'])->toBe(['Christian Fuchs']);
    expect($found['journal'])->toBe('tripleC');
});

test('a lone first page is a start, not a range', function () {
    $html = '<meta name="citation_date" content="2003"><meta name="citation_firstpage" content="7">';

    expect(app(PublisherPageMetadata::class)->extractAll($html)['pages'])->toBeNull();
});

test('every author is kept, in order — et-al is a render concern', function () {
    $html = '<meta name="citation_author" content="A One">'
        . '<meta name="citation_author" content="B Two">'
        . '<meta name="citation_author" content="C Three">';

    expect(app(PublisherPageMetadata::class)->authors($html))->toBe(['A One', 'B Two', 'C Three']);
});

test('a commented-out or templated meta tag is not a meta tag', function () {
    // The regex this replaced could not tell a live tag from one inside an HTML comment or a
    // `<script>` template. The parser skips both by construction.
    $page = app(PublisherPageMetadata::class);

    $commented = '<html><head><!-- <meta name="citation_date" content="1999"> --></head></html>';
    expect($page->year($commented))->toBeNull();

    $templated = '<html><head><script type="text/template">'
        . '<meta name="citation_date" content="1999">'
        . '</script></head></html>';
    expect($page->year($templated))->toBeNull();
});

test('a related-articles widget in the body cannot impersonate the page', function () {
    // A publisher page that lists other works can carry their citation tags too. Meta belongs in
    // the head, so scoping there makes the widget case disappear rather than defending against it.
    $html = '<html><head>'
        . '<meta name="citation_date" content="2003">'
        . '<meta name="citation_volume" content="1">'
        . '</head><body>'
        . '<div class="related"><meta name="citation_date" content="2019">'
        . '<meta name="citation_volume" content="42"></div>'
        . '</body></html>';

    $found = app(PublisherPageMetadata::class)->extractAll($html);

    expect($found['year'])->toBe(2003);
    expect($found['volume'])->toBe('1');
});

test('meta names match case-insensitively, as publishers actually emit them', function () {
    // `DC.Date` and `dc.date` are the same tag and publishers are inconsistent about which.
    expect(app(PublisherPageMetadata::class)->year('<meta content="2008" name="dc.date">'))->toBe(2008);
});

test('entity-encoded values are decoded exactly once', function () {
    // getAttribute already decodes; decoding again would turn `&amp;amp;` into a bare `&`.
    $html = '<meta name="citation_journal_title" content="Capitalism &amp;amp; Critique">';

    expect(app(PublisherPageMetadata::class)->metaContent($html, 'citation_journal_title'))
        ->toBe('Capitalism &amp; Critique');
});

test('finds the landing page under original.html, not just fetched_page.html', function () {
    // The bug this fixes: `fetched_page.html` is written only by the HTML lane's success path,
    // while a PDF-lane import saves the SAME landing page as `original.html` before deciding the
    // page is abstract-only and downloading the PDF. Every PDF-lane work therefore reported "no
    // stored page" while its page sat on disk — which is why the tripleC article stayed at 1970.
    [, $book] = mdWork(1970, null, mdOjsPage('2003'), 'original.html');

    $page = app(PublisherPageMetadata::class);
    expect($page->storedPageNameFor($book))->toBe('original.html');
    expect($page->storedPageFor($book))->toContain('citation_date');
});

// ---------------------------------------------------------------------------
// The plausibility floor
// ---------------------------------------------------------------------------

test('a year before the journal existed is impossible', function () {
    $floor = app(JournalYearFloor::class);

    expect($floor->isImpossible(1970, 2003))->toBeTrue();
    expect($floor->isImpossible(2003, 2003))->toBeFalse();
    expect($floor->isImpossible(2015, 2003))->toBeFalse();
    expect($floor->isImpossible((int) date('Y') + 5, 2003))->toBeTrue();
});

test('an unknown floor means unknown, never impossible', function () {
    // Only the future bound can apply when we do not know when the journal started. Treating
    // "no floor recorded" as "everything is impossible" would condemn every work in a journal
    // that has not been synced yet.
    $floor = app(JournalYearFloor::class);

    expect($floor->isImpossible(1970, null))->toBeFalse();
    expect($floor->isImpossible((int) date('Y') + 5, null))->toBeTrue();
});

test('the floor is the earlier of DOAJ oa_start and what we have actually observed', function () {
    // oa_start is when the journal went OPEN ACCESS, which for a converted journal is LATER than
    // its founding year. Trusting it alone would declare genuinely old articles impossible.
    $journalId = mdJournal(null);
    mdWork(1954, $journalId);

    $result = app(JournalYearFloor::class)->establish($journalId, 1998);

    expect($result['year'])->toBe(1954);
    expect($result['source'])->toBe('observed_works');
});

test('sentinel years are excluded when deriving a floor from observed works', function () {
    // Load-bearing: include 1970 and tripleC's floor becomes 1970, the gate passes every corrupt
    // row, and the detector silently does nothing at all.
    $journalId = mdJournal(null);
    mdWork(1970, $journalId);
    mdWork(2009, $journalId);

    expect(app(JournalYearFloor::class)->earliestObservedYear($journalId))->toBe(2009);
});

// ---------------------------------------------------------------------------
// The correct-vs-flag split
// ---------------------------------------------------------------------------

test('an epoch sentinel is corrected from the page without asking anyone', function () {
    $journalId = mdJournal(2003);
    [$canonicalId, $book] = mdWork(1970, $journalId, mdOjsPage('2003'));

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId);

    expect($result['status'])->toBe('corrected');
    expect($result['fields']['year']['rule'])->toBe('epoch_sentinel');
    expect((int) mdDb()->table('canonical_source')->where('id', $canonicalId)->value('year'))->toBe(2003);

    $row = mdDb()->table('library')->where('book', $book)->first();
    expect($row->year)->toBe('2003');
    // Cards render the stored bibtex in PREFERENCE to the structured columns, so patching only
    // the column would leave the visible citation showing 1970 forever.
    expect($row->bibtex)->toContain('year = {2003}');
});

test('an automatic correction still leaves an audit flag, marked as needing no decision', function () {
    // Nothing is ever rewritten invisibly. A silent fix whose only trace is a log line means
    // "the card says 2003 now and nobody knows who decided that" — its own integrity problem.
    $journalId = mdJournal(2003);
    [$canonicalId, $book] = mdWork(1970, $journalId, mdOjsPage('2003'));

    app(MetadataDriftDetector::class)->inspect($canonicalId);

    $flag = DB::table('conversion_flags')->where('book', $book)->first();
    expect($flag)->not->toBeNull();
    expect($flag->source)->toBe(ConversionFlag::SOURCE_METADATA_DRIFT);
    expect($flag->reason)->toContain('Corrected from the publisher page');

    $details = json_decode((string) $flag->details, true);
    expect($details['needs_decision'])->toBeFalse();
    expect($details['applied']['year'])->toBe(2003);
});

test('a year before the journal started is corrected even though it is not a sentinel', function () {
    // The case no pattern-match on the value alone could catch: 1995 looks like a real year.
    // Only the journal's own lifespan says it is impossible.
    $journalId = mdJournal(2003);
    [$canonicalId] = mdWork(1995, $journalId, mdOjsPage('2007'));

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId);

    expect($result['status'])->toBe('corrected');
    expect($result['fields']['year']['rule'])->toBe('impossible_for_journal');
    expect((int) mdDb()->table('canonical_source')->where('id', $canonicalId)->value('year'))->toBe(2007);
});

test('two plausible years that merely differ are flagged, not silently picked', function () {
    $journalId = mdJournal(2003);
    [$canonicalId, $book] = mdWork(2005, $journalId, mdOjsPage('2004'));

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId);

    expect($result['status'])->toBe('flagged');
    expect($result['fields']['year']['action'])->toBe('dispute');
    // Nothing written: preferring the page here would trade a known bug for an unknown one.
    expect((int) mdDb()->table('canonical_source')->where('id', $canonicalId)->value('year'))->toBe(2005);

    $flag = DB::table('conversion_flags')->where('book', $book)->first();
    expect($flag->source)->toBe(ConversionFlag::SOURCE_METADATA_DRIFT);
    expect($flag->status)->toBe('open');
    expect($flag->reason)->toContain('stored 2005');
    expect($flag->reason)->toContain('page 2004');
    expect(json_decode((string) $flag->details, true)['needs_decision'])->toBeTrue();
});

test('a page whose own year is impossible cannot repair anything', function () {
    // Otherwise a junk page would "fix" a good year into a bad one — the gate has to judge the
    // incoming candidate by exactly the same rule as the stored value.
    $journalId = mdJournal(2003);
    [$canonicalId] = mdWork(2010, $journalId, mdOjsPage('1970'));

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId);

    expect($result['fields']['year']['action'])->toBe('reject_page');
    expect((int) mdDb()->table('canonical_source')->where('id', $canonicalId)->value('year'))->toBe(2010);
});

test('volume and issue fill a gap but a disagreement is flagged, never overwritten', function () {
    $journalId = mdJournal(2003);
    [$canonicalId] = mdWork(2003, $journalId, mdOjsPage('2003', '9', '4'));
    mdDb()->table('canonical_source')->where('id', $canonicalId)->update(['volume' => '7', 'issue' => null]);

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId);

    $row = mdDb()->table('canonical_source')->where('id', $canonicalId)->first();
    expect($row->volume)->toBe('7');            // present already — not ours to overwrite
    expect($row->issue)->toBe('4');             // was empty — filled
    expect($result['fields']['volume']['action'])->toBe('dispute');
    expect($result['fields']['issue']['action'])->toBe('fill');
});

test('an ahead-of-print sentinel is never filled into an empty column', function () {
    // Found by auditing the real corpus, not imagined: Bristol UP emits `citation_volume: -1`
    // and `citation_issue: aop` on an ahead-of-print article. Filling an empty column with that
    // is worse than leaving the gap — the gap is honest and self-heals on the next sync, whereas
    // `volume = -1` renders on the card and looks deliberate.
    $journalId = mdJournal(2003);
    [$canonicalId] = mdWork(2003, $journalId, mdOjsPage('2003', '-1', 'aop'));

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId);

    expect($result['fields'])->toBe([]);
    $row = mdDb()->table('canonical_source')->where('id', $canonicalId)->first();
    expect($row->volume)->toBeNull();
    expect($row->issue)->toBeNull();
});

test('the placeholder vocabulary is rejected but messy real designators survive', function () {
    $page = app(PublisherPageMetadata::class);

    foreach (['-1', '0', '000', 'aop', 'AOP', 'in press', 'n/a', 'none', '—', ' ', ''] as $junk) {
        expect($page->isPlausibleDesignator($junk))->toBeFalse("'{$junk}' should be rejected");
    }
    // Real designators are messily various; demanding digits would throw away good data.
    foreach (['1', '12A', 'Suppl 1', 'Part 2', '1-2', '7646'] as $real) {
        expect($page->isPlausibleDesignator($real))->toBeTrue("'{$real}' should be kept");
    }
});

test('agreement writes nothing and flags nothing', function () {
    $journalId = mdJournal(2003);
    [$canonicalId, $book] = mdWork(2003, $journalId, mdOjsPage('2003', '1', '1'));
    // Volume and issue have to match too, or the run is a legitimate gap-fill rather than the
    // no-op this test is about.
    mdDb()->table('canonical_source')->where('id', $canonicalId)->update(['volume' => '1', 'issue' => '1']);

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId);

    expect($result['status'])->toBe('agreed');
    expect($result['fields'])->toBe([]);
    expect(DB::table('conversion_flags')->where('book', $book)->count())->toBe(0);
});

test('a dry run decides but writes nothing', function () {
    $journalId = mdJournal(2003);
    [$canonicalId, $book] = mdWork(1970, $journalId, mdOjsPage('2003'));

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId, null, true);

    expect($result['applied']['year'])->toBe(2003);
    expect((int) mdDb()->table('canonical_source')->where('id', $canonicalId)->value('year'))->toBe(1970);
    expect(DB::table('conversion_flags')->where('book', $book)->count())->toBe(0);
});

test('no stored page is a status, not a crash', function () {
    [$canonicalId] = mdWork(1970, mdJournal(2003));

    expect(app(MetadataDriftDetector::class)->inspect($canonicalId)['status'])->toBe('no_page');
});

// ---------------------------------------------------------------------------
// The identity gate — a page only gets to rewrite the database if it proves it
// is the same work. `storedPageFor()` returns whatever HTML is in the book's
// directory, and an engine-crash `rejected_page.html` was never identity-checked
// by the import (that gate runs BEFORE the authenticity gate).
// ---------------------------------------------------------------------------

test('a page for a DIFFERENT work is refused, however plausible its date', function () {
    // The failure this prevents is worse than the bug being fixed: 1970 is obviously ugly and
    // every plausibility rule catches it, whereas another article's 2011 is confidently wrong
    // and invisible to everything downstream.
    $journalId = mdJournal(2003);
    [$canonicalId] = mdWork(1970, $journalId, mdOjsPage('2011', '1', '1', '10.9999/someone.else.99'));

    $result = app(MetadataDriftDetector::class)->inspect($canonicalId);

    expect($result['status'])->toBe('identity_unconfirmed');
    expect((int) mdDb()->table('canonical_source')->where('id', $canonicalId)->value('year'))->toBe(1970);
});

test('a page that identifies as nothing at all is refused, not trusted by default', function () {
    $journalId = mdJournal(2003);
    [$canonicalId] = mdWork(1970, $journalId, '<meta name="citation_date" content="2003">');

    expect(app(MetadataDriftDetector::class)->inspect($canonicalId)['status'])->toBe('identity_unconfirmed');
    expect((int) mdDb()->table('canonical_source')->where('id', $canonicalId)->value('year'))->toBe(1970);
});

test('a matching title stands in when neither side has a DOI', function () {
    $page = app(PublisherPageMetadata::class);
    $sim = fn (string $a, string $b): float => app(\App\Services\OpenAlexService::class)->titleSimilarity($a, $b);

    $html = '<meta name="citation_title" content="Co-operation and Self-Organization">';

    expect($page->identityMatches($html, null, 'Co-operation and Self-Organization', $sim)['ok'])->toBeTrue();
    expect($page->identityMatches($html, null, 'An Entirely Different Paper About Bees', $sim)['ok'])->toBeFalse();
});

test('a DOI match settles identity outright, in either direction of prefix', function () {
    $page = app(PublisherPageMetadata::class);
    $sim = fn (string $a, string $b): float => 0.0;   // must not be consulted when a DOI decides

    $html = '<meta name="citation_doi" content="https://doi.org/10.31269/TripleC.V1I1.2">';

    // Case and the doi.org prefix are presentation, not identity.
    expect($page->identityMatches($html, '10.31269/triplec.v1i1.2', 'x', $sim))
        ->toBe(['ok' => true, 'basis' => 'doi_match']);
    expect($page->identityMatches($html, '10.31269/triplec.v1i1.3', 'x', $sim)['ok'])->toBeFalse();
});

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

test('a metadata flag never reaches the reconvert queue', function () {
    // The trap this closes: ReconvertQueue selected EVERY open flag regardless of source, so any
    // new flag kind silently enrolled its books for re-conversion. On this corpus that would have
    // queued 112 tripleC books for re-OCR over a wrong YEAR, at real money.
    $journalId = mdJournal(2003);
    [$canonicalId, $book] = mdWork(2005, $journalId, mdOjsPage('2004'));

    app(MetadataDriftDetector::class)->inspect($canonicalId);
    expect(DB::table('conversion_flags')->where('book', $book)->where('status', 'open')->count())->toBe(1);

    $queued = collect(app(ReconvertQueue::class)->openFlagsGrouped())->pluck('book');
    expect($queued)->not->toContain($book);
});

test('a real conversion flag still reaches the reconvert queue', function () {
    // The allow-list must not have fenced out the flags the queue exists to serve.
    [, $book] = mdWork(2003, mdJournal(2003));
    ConversionFlag::raise($book, ConversionFlag::SOURCE_USER_REPORT, 'garbled text');

    $queued = collect(app(ReconvertQueue::class)->openFlagsGrouped())->pluck('book');
    expect($queued)->toContain($book);
});
