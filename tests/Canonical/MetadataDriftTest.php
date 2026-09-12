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

function mdOjsPage(string $year, string $volume = '1', string $issue = '1'): string
{
    return <<<HTML
    <html><head>
    <meta name="citation_journal_title" content="tripleC"/>
    <meta name="citation_author" content="Christian Fuchs"/>
    <meta name="citation_title" content="Co-operation and Self-Organization"/>
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

    mdDb()->table('canonical_source')->insert([
        'id' => $canonicalId, 'title' => 'MDD Co-operation and Self-Organization',
        'year' => $year, 'journal_source_id' => $journalId, 'auto_version_book' => $book,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    mdDb()->table('library')->insert([
        'book' => $book, 'canonical_source_id' => $canonicalId, 'title' => 'MDD',
        'year' => $year !== null ? (string) $year : null, 'visibility' => 'public', 'raw_json' => '{}',
        'bibtex' => "@article{mdd,\n  title = {MDD},\n  year = {" . ($year ?? '') . "},\n}",
        'created_at' => now(), 'updated_at' => now(),
    ]);

    if ($pageHtml !== null) {
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

    expect(DB::table('conversion_flags')->where('book', $book)->count())->toBe(0);
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
