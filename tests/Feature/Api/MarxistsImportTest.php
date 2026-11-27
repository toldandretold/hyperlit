<?php

/**
 * The marxists.org import lane (docs/marxists-import.md): paste the contents
 * page of ONE work, and the server crawls its pages, stitches them into an
 * EPUB and converts it — the same paste-a-link flow as Project Gutenberg.
 *
 *   inspect  → metadata read off the work's own page (one fetch), or a refusal
 *              that says WHY (an author index is a list of works, not a work)
 *   commit   → the library row (the licence the page STATES, the contents page
 *              as the credit link), the author link, and a queued stitch job
 *   the job  → original.epub, then ProcessDocumentImportJob on the same lane
 *
 * The crawler itself is Python and is tested against a synthetic site in
 * tests/conversion/unit/test_marxists_stitch.py. Here the process is faked:
 * no test in this file touches the network or runs Python.
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Jobs\StitchMarxistsWorkJob;
use App\Services\Authors\MarxistsAuthors;
use App\Services\SourceImport\Content\MarxistsStitcher;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

const MARX_QIDS = ['Q9061', 'Q34787', 'Q1394', 'Q7231'];

function marxDb()
{
    return DB::connection('pgsql_admin');
}

function marxCleanup(): void
{
    // The lane links to the REAL author slugs (marx, engels…), which a test database has no
    // other reason to hold — so they are this file's to remove.
    $authorIds = marxDb()->table('authors')->whereIn('wikidata_qid', MARX_QIDS)->pluck('id');
    $shelfIds = marxDb()->table('archive_sources')->whereIn('author_id', $authorIds)->pluck('shelf_id');
    marxDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
    marxDb()->table('archive_sources')->whereIn('author_id', $authorIds)->delete();
    marxDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    marxDb()->table('authors')->whereIn('id', $authorIds)->delete();
    marxDb()->table('book_authors')->where('book', 'LIKE', 'marxtest\_%')->delete();
    marxDb()->table('library')->where('book', 'LIKE', 'marxtest\_%')->delete();

    // The bulk import mints its own readable book ids, so its fixtures are found by title/url.
    $bulkBooks = marxDb()->table('library')->where('title', 'LIKE', 'Marxtest %')->pluck('book');
    marxDb()->table('book_authors')->whereIn('book', $bulkBooks)->delete();
    marxDb()->table('shelf_items')->whereIn('book', $bulkBooks)->delete();
    marxDb()->table('library')->whereIn('book', $bulkBooks)->delete();
    foreach ($bulkBooks as $book) {
        File::deleteDirectory(resource_path("markdown/{$book}"));
    }
    marxDb()->table('marxists_works')->where('url', 'LIKE', '%/archive/marxtest/%')->delete();
    $archiveShelf = marxDb()->table('archive_sources')->where('slug', \App\Services\Marxists\MarxistsArchive::SLUG)->value('shelf_id');
    if ($archiveShelf) {
        marxDb()->table('shelf_items')->where('shelf_id', $archiveShelf)->delete();
        marxDb()->table('archive_sources')->where('shelf_id', $archiveShelf)->delete();
        marxDb()->table('shelves')->where('id', $archiveShelf)->delete();
    }

    foreach (glob(resource_path('markdown/marxtest_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
}

beforeEach(function () {
    marxCleanup();
    Cache::flush();
    Http::preventStrayRequests();
    // An author created by the lane is filled from Wikidata; the entity is irrelevant here.
    Http::fake(['www.wikidata.org/*' => Http::response(['entities' => []])]);
});
afterEach(function () {
    $this->cleanupApiFixtures();
    foreach (glob(resource_path('markdown/marxtest_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
});

/** What `stitch.py metadata` prints for a work's contents page. */
function marxMetadata(array $overrides = []): array
{
    return ['ok' => true, 'metadata' => $overrides + [
        'index_url' => 'https://www.marxists.org/archive/marx/works/1852/18th-brumaire/index.htm',
        'title' => 'The Eighteenth Brumaire of Louis Bonaparte',
        'author' => 'Karl Marx',
        'year' => 1852,
        'language' => 'en',
        'licence' => ['code' => 'PDM', 'url' => null, 'evidence' => 'Public Domain: Marx Internet Archive 2006'],
        'note' => 'Written: December 1851 – March 1852 | Source: Chapters 1 and 7 are translated by Saul K. Padover',
        'info' => ['Written' => 'December 1851 – March 1852'],
    ]];
}

function marxFakeStitcher(array $payload, int $exit = 0): void
{
    Process::fake(['*stitch.py*' => Process::result(output: json_encode($payload), exitCode: $exit)]);
}

const MARX_URL = 'https://www.marxists.org/archive/marx/works/1852/18th-brumaire/index.htm';

/* ── inspect ─────────────────────────────────────────────────────────────── */

test('inspect previews a marxists.org work from its own contents page', function () {
    $this->loginUser();
    marxFakeStitcher(marxMetadata());

    $this->postJson('/import-url/inspect', ['url' => 'marxists.org/archive/marx/works/1852/18th-brumaire/'])
        ->assertOk()
        ->assertJsonPath('identifier.kind', 'marxists')
        ->assertJsonPath('identifier.url', MARX_URL)
        ->assertJsonPath('metadata.title', 'The Eighteenth Brumaire of Louis Bonaparte')
        ->assertJsonPath('metadata.author', 'Karl Marx')
        ->assertJsonPath('metadata.year', 1852)
        ->assertJsonPath('metadata.source', 'marxists')
        ->assertJsonPath('plan.access', 'open')
        ->assertJsonPath('plan.via_ladder', false);

    // One page fetched, and the address handed to the script is the normalised one.
    Process::assertRan(fn ($process) => in_array('metadata', $process->command, true) && in_array(MARX_URL, $process->command, true));
});

test('a second look at the same work does not ask the site again', function () {
    $this->loginUser();
    marxFakeStitcher(marxMetadata());

    $this->postJson('/import-url/inspect', ['url' => MARX_URL])->assertOk();
    $this->postJson('/import-url/inspect', ['url' => MARX_URL . '#ch1'])->assertOk();

    Process::assertRanTimes(fn ($process) => in_array('metadata', $process->command, true), 1);
});

test('an index of works is refused with the reason, not "metadata unavailable"', function () {
    $this->loginUser();
    marxFakeStitcher(['ok' => false, 'error' => 'not_a_single_work', 'detail' => 'an index of works'], exit: 2);

    $this->postJson('/import-url/inspect', ['url' => 'https://www.marxists.org/archive/lenin/works/cw/volume22.htm'])
        ->assertStatus(422)
        ->assertJsonPath('error', 'not_a_single_work');

    $this->postJson('/import-url', ['url' => 'https://www.marxists.org/archive/lenin/works/cw/volume22.htm', 'book' => 'marxtest_refused'])
        ->assertStatus(422)
        ->assertJsonPath('error', 'not_a_single_work')
        ->assertJsonPath('identifier_kind', 'marxists');
    expect(marxDb()->table('library')->where('book', 'marxtest_refused')->exists())->toBeFalse();
});

test('a site hiccup is "unavailable" — and is not remembered as a verdict on the page', function () {
    $this->loginUser();
    marxFakeStitcher(['ok' => false, 'error' => 'page_unavailable', 'detail' => MARX_URL], exit: 2);
    $this->postJson('/import-url/inspect', ['url' => MARX_URL])->assertStatus(422)->assertJsonPath('error', 'metadata_unavailable');

    // The next try asks again and succeeds.
    marxFakeStitcher(marxMetadata());
    $this->postJson('/import-url/inspect', ['url' => MARX_URL])->assertOk();
});

/* ── commit ──────────────────────────────────────────────────────────────── */

test('commit mints the book with the stated licence and credit link, links its author, and queues the stitch', function () {
    Queue::fake();
    $user = $this->loginUser();
    marxFakeStitcher(marxMetadata());
    $book = 'marxtest_' . Str::lower(Str::random(10));

    $library = $this->postJson('/import-url', ['url' => MARX_URL, 'book' => $book])
        ->assertOk()
        ->assertJsonPath('ok', true)
        ->assertJsonPath('bookId', $book)
        ->assertJsonPath('status', 'processing')
        ->json('library');

    expect($library['title'])->toBe('The Eighteenth Brumaire of Louis Bonaparte')
        ->and($library['author'])->toBe('Karl Marx')
        // The WORK's licence as its page states it — not Hyperlit's own-writing default.
        ->and($library['license'])->toBe('PDM')
        // One work = one book, crediting the work's contents page.
        ->and($library['url'])->toBe(MARX_URL)
        ->and($library['publisher'])->toBe('Marxists Internet Archive')
        ->and($library['language'])->toBe('en')
        ->and($library['note'])->toContain('translated by Saul K. Padover')
        ->and($library['creator'])->toBe($user->name);

    // The crawl is a JOB on the interactive lane — nothing was fetched in the request.
    Queue::assertPushedOn(ProcessDocumentImportJob::QUEUE_INTERACTIVE, StitchMarxistsWorkJob::class,
        fn ($job) => $job->bookId === $book && $job->path === 'archive/marx/works/1852/18th-brumaire/index.htm'
            && $job->formData['url'] === MARX_URL && $job->creatorInfo['creator'] === $user->name);
    Queue::assertNotPushed(ProcessDocumentImportJob::class);
    Process::assertDidntRun(fn ($process) => in_array('build', $process->command, true));

    // The reader's progress card has something to show at once.
    $progress = json_decode(File::get(resource_path("markdown/{$book}/progress.json")), true);
    expect($progress['stage'])->toBe('fetching_pages')->and($progress['status'])->toBe('processing');

    // Linked to Marx — by identity, whoever imported it.
    $link = marxDb()->table('book_authors')->join('authors', 'authors.id', '=', 'book_authors.author_id')
        ->where('book', $book)->first(['authors.slug', 'authors.wikidata_qid', 'role', 'source']);
    expect([$link->slug, $link->wikidata_qid, $link->role, $link->source])->toBe(['marx', 'Q9061', 'author', 'import']);
});

test('a licence the page does not state is Unknown, and an author we do not know is left unlinked', function () {
    Queue::fake();
    $this->loginUser();
    marxFakeStitcher(marxMetadata([
        'title' => 'What Is Property?', 'author' => 'Pierre-Joseph Proudhon',
        'licence' => ['code' => 'Unknown', 'url' => null, 'evidence' => null],
    ]));
    $book = 'marxtest_' . Str::lower(Str::random(10));

    $library = $this->postJson('/import-url', ['url' => 'https://www.marxists.org/reference/subject/economics/proudhon/property/index.htm', 'book' => $book])
        ->assertOk()->json('library');

    expect($library['license'])->toBe(\App\Support\Licenses::UNKNOWN)
        ->and(marxDb()->table('book_authors')->where('book', $book)->exists())->toBeFalse();
    Queue::assertPushed(StitchMarxistsWorkJob::class);
});

test('a stated Creative Commons licence keeps its terms link', function () {
    Queue::fake();
    $this->loginUser();
    marxFakeStitcher(marxMetadata(['licence' => [
        'code' => 'CC-BY-SA-2.0', 'url' => 'https://www.marxists.org/admin/legal/cc/by-sa.htm', 'evidence' => 'Copyleft: …',
    ]]));
    $book = 'marxtest_' . Str::lower(Str::random(10));

    $library = $this->postJson('/import-url', ['url' => MARX_URL, 'book' => $book])->assertOk()->json('library');

    expect($library['license'])->toBe('CC-BY-SA-2.0')
        ->and($library['license_url'])->toBe('https://www.marxists.org/admin/legal/cc/by-sa.htm');
});

/* ── who a credit names ──────────────────────────────────────────────────── */

test('an author credit is read as people, all or nothing', function () {
    expect(MarxistsAuthors::identify('V.I. Lenin'))->toBe([['name' => 'V.I. Lenin', 'slug' => 'lenin', 'wikidata' => 'Q1394']])
        // Engels' works sit under /archive/marx/ — the CREDIT, not the folder, says who.
        ->and(MarxistsAuthors::identify('Frederick Engels')[0]['slug'])->toBe('engels')
        ->and(array_column(MarxistsAuthors::identify('Karl Marx, Friedrich Engels'), 'slug'))->toBe(['marx', 'engels'])
        ->and(array_column(MarxistsAuthors::identify('Karl Marx u. Friedrich Engels'), 'slug'))->toBe(['marx', 'engels'])
        // A joint work with one unknown author links NOBODY, never just the famous half.
        ->and(MarxistsAuthors::identify('Karl Marx and Jenny von Westphalen'))->toBeNull()
        ->and(MarxistsAuthors::identify('Marxists Internet Archive'))->toBeNull()
        ->and(MarxistsAuthors::identify(null))->toBeNull();
});

/* ── the stitch job ──────────────────────────────────────────────────────── */

test('the stitch job hands a stitched EPUB to the ordinary import job, on the same lane', function () {
    Queue::fake();
    $book = 'marxtest_' . Str::lower(Str::random(10));
    $dir = resource_path("markdown/{$book}");

    $this->mock(MarxistsStitcher::class, function ($mock) use ($dir) {
        $mock->shouldReceive('build')->once()
            ->with(MARX_URL, $dir)
            ->andReturnUsing(function () use ($dir) {
                File::put("{$dir}/original.epub", 'PK-fake-epub');

                return ['ok' => true, 'epub' => "{$dir}/original.epub", 'pages' => 11, 'images' => 3];
            });
    });

    $formData = ['title' => 'T', 'author' => 'Karl Marx', 'year' => 1852, 'url' => MARX_URL];
    $creatorInfo = ['creator' => 'marxtest_user', 'creator_token' => null, 'valid' => true];
    app()->call([new StitchMarxistsWorkJob($book, 'archive/marx/works/1852/18th-brumaire/index.htm', 7, $formData, $creatorInfo), 'handle']);

    Queue::assertPushedOn(ProcessDocumentImportJob::QUEUE_INTERACTIVE, ProcessDocumentImportJob::class);
    $pushed = Queue::pushed(ProcessDocumentImportJob::class)->first();
    $shape = (new ReflectionClass($pushed))->getProperties();
    $values = [];
    foreach ($shape as $property) {
        $property->setAccessible(true);
        $values[$property->getName()] = $property->isInitialized($pushed) ? $property->getValue($pushed) : null;
    }
    expect($values['bookId'])->toBe($book)
        ->and($values['extension'])->toBe('epub')
        ->and($values['formData'])->toBe($formData);
    expect(json_decode(File::get("{$dir}/progress.json"), true)['status'])->toBe('queued');
});

test('a failed or refused crawl ends the import visibly and converts nothing', function () {
    Queue::fake();
    $book = 'marxtest_' . Str::lower(Str::random(10));
    $this->mock(MarxistsStitcher::class, fn ($mock) => $mock->shouldReceive('build')->once()
        ->andReturn(['ok' => false, 'error' => 'too_many_pages', 'detail' => 'more than 200 pages']));

    app()->call([new StitchMarxistsWorkJob($book, 'archive/x/works/huge/index.htm', null, [], []), 'handle']);

    Queue::assertNotPushed(ProcessDocumentImportJob::class);
    $progress = json_decode(File::get(resource_path("markdown/{$book}/progress.json")), true);
    expect($progress['status'])->toBe('failed')->and($progress['detail'])->toContain('more pages than one import can fetch');
});

test('the stitcher reads the script\'s refusal and never mistakes a crash for one', function () {
    marxFakeStitcher(['ok' => false, 'error' => 'not_a_single_work', 'detail' => 'an index of works'], exit: 2);
    expect(app(MarxistsStitcher::class)->metadata(MARX_URL))->toMatchArray(['ok' => false, 'error' => 'not_a_single_work']);

    Process::fake(['*stitch.py*' => Process::result(output: '', errorOutput: 'Traceback: ModuleNotFoundError: bs4', exitCode: 1)]);
    $crash = app(MarxistsStitcher::class)->build(MARX_URL, sys_get_temp_dir());
    expect($crash['ok'])->toBeFalse()->and($crash['error'])->toBe('stitch_failed')->and($crash['detail'])->toContain('bs4');
});

/* ── duplicates ──────────────────────────────────────────────────────────── */

test('a work already imported from the same contents page is offered before a second copy is made', function () {
    $this->loginUser();
    marxFakeStitcher(marxMetadata());
    $existing = 'marxtest_' . Str::lower(Str::random(10));
    marxDb()->table('library')->insert([
        'book' => $existing, 'title' => 'The Eighteenth Brumaire of Louis Bonaparte', 'author' => 'Karl Marx',
        'url' => MARX_URL, 'visibility' => 'public', 'has_nodes' => true, 'type' => 'book',
        'creator' => 'marxtest_someone', 'timestamp' => round(microtime(true) * 1000), 'raw_json' => '{}',
    ]);

    $versions = $this->postJson('/import-url/inspect', ['url' => MARX_URL])->assertOk()->json('existing_versions');
    expect(array_column($versions, 'book'))->toBe([$existing]);
});

/* ── the maintainer's bulk import ────────────────────────────────────────── */

use App\Jobs\ImportMarxistsWorkJob;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Marxists\MarxistsArchive;
use App\Services\Marxists\MarxistsBulkImporter;

const MARXTEST_ROOT = 'https://www.marxists.org/archive/marxtest/works/';

/** A ledger row ready to import; returns its id. */
function marxWork(string $path, string $author = 'lenin', string $status = MarxistsBulkImporter::STATUS_QUEUED): int
{
    return (int) marxDb()->table('marxists_works')->insertGetId([
        'url' => MARXTEST_ROOT . $path, 'author' => $author, 'listing_url' => 'https://www.marxists.org/archive/marxtest/index.htm',
        'link_title' => 'Marxtest link', 'kind' => 'article', 'status' => $status, 'created_at' => now(), 'updated_at' => now(),
    ]);
}

/** A stitcher that answers from memory: metadata per call, and a build that writes an EPUB. */
function marxMockStitcher($test, array $metadata, ?array $build = null): void
{
    $mock = Mockery::mock(MarxistsStitcher::class);
    $mock->shouldReceive('metadata')->andReturn($metadata);
    $mock->shouldReceive('build')->andReturnUsing(function (string $url, string $dir) use ($build) {
        if ($build !== null) {
            return $build;
        }
        File::put("{$dir}/original.epub", 'PK-fake-epub');

        return ['ok' => true, 'epub' => "{$dir}/original.epub", 'pages' => 3, 'images' => 0];
    });
    // Every consumer (the resolver, the fetcher, the importer) must get THIS double.
    foreach ([MarxistsStitcher::class, \App\Services\SourceImport\Metadata\MarxistsMetadataResolver::class,
        \App\Services\SourceImport\Content\MarxistsWorkFetcher::class, MarxistsBulkImporter::class] as $class) {
        app()->forgetInstance($class);
    }
    app()->instance(MarxistsStitcher::class, $mock);
}

test('listing an author records one ledger row per work, and re-listing adds nothing', function () {
    Process::fake(['*stitch.py*' => Process::result(output: json_encode([
        'ok' => true, 'listing' => 'https://www.marxists.org/archive/luxemburg/index.htm', 'root' => '/archive/luxemburg/',
        'works' => [
            ['url' => MARXTEST_ROOT . '1913/accumulation/index.htm', 'title' => 'Marxtest Accumulation', 'kind' => 'work_folder'],
            ['url' => MARXTEST_ROOT . '1894/02/may-day.htm', 'title' => 'Marxtest May Day', 'kind' => 'article'],
        ],
        'followed' => [], 'skipped' => ['not_a_text' => 1],
    ]))]);
    $importer = app(MarxistsBulkImporter::class);

    expect($importer->listAuthor('luxemburg', dryRun: true))->toMatchArray(['ok' => true, 'found' => 2, 'new' => 2])
        ->and(marxDb()->table('marxists_works')->where('url', 'LIKE', '%/archive/marxtest/%')->count())->toBe(0);

    expect($importer->listAuthor('luxemburg'))->toMatchArray(['found' => 2, 'new' => 2, 'by_kind' => ['work_folder' => 1, 'article' => 1]]);
    $rows = marxDb()->table('marxists_works')->where('url', 'LIKE', '%/archive/marxtest/%')->orderBy('id')->get();
    expect($rows->pluck('status')->all())->toBe(['listed', 'listed'])
        ->and($rows->pluck('author')->unique()->all())->toBe(['luxemburg'])
        ->and($rows[0]->link_title)->toBe('Marxtest Accumulation');

    expect($importer->listAuthor('luxemburg'))->toMatchArray(['new' => 0, 'already_listed' => 2])
        ->and($importer->listAuthor('nobody'))->toMatchArray(['ok' => false, 'error' => 'unknown_author']);
});

test('a bulk-imported work is a system-owned, public, unlisted book on the archive and its author page', function () {
    Queue::fake();
    // The page names no author: in a one-author archive the listing's author is assumed.
    marxMockStitcher($this, marxMetadata(['title' => 'Marxtest Imperialism', 'author' => null, 'year' => 1916,
        'index_url' => MARXTEST_ROOT . '1916/imp/index.htm']));
    $workId = marxWork('1916/imp/index.htm', 'lenin');

    expect(app(MarxistsBulkImporter::class)->importWork($workId))->toBe('imported');

    $work = marxDb()->table('marxists_works')->where('id', $workId)->first();
    $row = marxDb()->table('library')->where('book', $work->book)->first();
    expect($work->book)->toBe('lenin-1916-marxtest-imperialism')
        ->and($row->creator)->toBe(AutoVersionResolver::CREATOR)          // nobody "contributed" it
        ->and($row->visibility)->toBe('public')
        ->and($row->listed)->toBeFalse()                                   // not on the homepage feeds
        ->and($row->license)->toBe('PDM')
        ->and($row->url)->toBe(MARXTEST_ROOT . '1916/imp/index.htm')
        ->and($row->author)->toBe('Vladimir Lenin')
        ->and($row->publisher)->toBe('Marxists Internet Archive')
        ->and(json_decode($row->raw_json, true)['scrape_site'])->toBe('marxists.org');

    // On the archive's shelf (so it is reviewable in /maintainer/shelf-import), linked to Lenin.
    $shelf = marxDb()->table('archive_sources')->where('slug', MarxistsArchive::SLUG)->first();
    expect($shelf->display_name)->toBe('Marxists Internet Archive')
        ->and(marxDb()->table('shelf_items')->where('shelf_id', $shelf->shelf_id)->pluck('book')->all())->toBe([$work->book])
        ->and(marxDb()->table('book_authors')->join('authors', 'authors.id', '=', 'book_authors.author_id')
            ->where('book', $work->book)->value('authors.slug'))->toBe('lenin');

    // The conversion is queued on the BULK lane, as the system.
    Queue::assertPushedOn('default', ProcessDocumentImportJob::class);
    Queue::assertNotPushed(StitchMarxistsWorkJob::class);
    expect(File::exists(resource_path("markdown/{$work->book}/original.epub")))->toBeTrue();
});

test('a licence the page does not state is imported public as "Licence unknown"', function () {
    Queue::fake();
    marxMockStitcher($this, marxMetadata(['title' => 'Marxtest Wage Labour', 'author' => 'Karl Marx', 'year' => 1847,
        'licence' => ['code' => 'Unknown', 'url' => null, 'evidence' => null]]));
    $workId = marxWork('1847/wage/index.htm', 'marx');

    app(MarxistsBulkImporter::class)->importWork($workId);

    $row = marxDb()->table('library')->where('book', marxDb()->table('marxists_works')->where('id', $workId)->value('book'))->first();
    expect($row->license)->toBe(\App\Support\Licenses::UNKNOWN)
        ->and($row->visibility)->toBe('public')
        // …and the hosting policy agrees it may stay public (Unknown is withheld only for web evidence).
        ->and(\App\Services\Licensing\HostingPolicy::mayPublish($row))->toBeTrue();
});

test('the Marx/Engels archive never assumes Marx for a page that names no author', function () {
    Queue::fake();
    marxMockStitcher($this, marxMetadata(['title' => 'Marxtest Uncredited', 'author' => null]));
    $workId = marxWork('1850/uncredited.htm', 'marx');

    app(MarxistsBulkImporter::class)->importWork($workId);

    $book = marxDb()->table('marxists_works')->where('id', $workId)->value('book');
    expect($book)->not->toBeNull()
        ->and(marxDb()->table('book_authors')->where('book', $book)->exists())->toBeFalse()
        ->and(marxDb()->table('library')->where('book', $book)->value('author'))->toBeNull();
});

test('a work already imported from the same page is not imported twice', function () {
    Queue::fake();
    marxMockStitcher($this, marxMetadata());
    marxDb()->table('library')->insert([
        'book' => 'marxtest_' . Str::lower(Str::random(8)), 'title' => 'Marxtest Already Here', 'url' => MARXTEST_ROOT . '1916/here/index.htm',
        'visibility' => 'public', 'has_nodes' => true, 'type' => 'book', 'creator' => 'marxtest_user',
        'timestamp' => round(microtime(true) * 1000), 'raw_json' => '{}',
    ]);
    $workId = marxWork('1916/here/index.htm');

    expect(app(MarxistsBulkImporter::class)->importWork($workId))->toBe('exists');
    Queue::assertNothingPushed();
    expect(marxDb()->table('library')->where('url', MARXTEST_ROOT . '1916/here/index.htm')->count())->toBe(1);
});

test('a listing page and a failed crawl are settled in the ledger and leave no book behind', function () {
    Queue::fake();

    // A subject collection that looked like a work on the listing: refused when read.
    $this->mock(MarxistsStitcher::class, fn ($m) => $m->shouldReceive('metadata')
        ->andReturn(['ok' => false, 'error' => 'not_a_single_work', 'detail' => 'links to works in 10 other folders']));
    $collection = marxWork('china/index.htm', 'trotsky');
    expect(app(MarxistsBulkImporter::class)->importWork($collection))->toBe('not_a_work');
    expect(marxDb()->table('marxists_works')->where('id', $collection)->value('reason'))->toBe('not_a_single_work');

    // The crawl fails after the page was read: a hiccup, retryable — and no row, no folder.
    Cache::flush();
    marxMockStitcher($this, marxMetadata(['title' => 'Marxtest Flaky', 'author' => 'Leon Trotsky', 'year' => 1930]),
        build: ['ok' => false, 'error' => 'stitch_failed', 'detail' => 'timeout']);
    $flaky = marxWork('1930/flaky/index.htm', 'trotsky');
    expect(app(MarxistsBulkImporter::class)->importWork($flaky))->toBe('failed');

    expect(marxDb()->table('library')->where('title', 'Marxtest Flaky')->exists())->toBeFalse()
        ->and(File::exists(resource_path('markdown/trotsky-1930-marxtest-flaky')))->toBeFalse();
    Queue::assertNothingPushed();

    // Only a QUEUED row is ever acted on — a settled one is not re-run by a stray job.
    expect(app(MarxistsBulkImporter::class)->importWork($collection))->toBe('not_a_work');
});

test('another version of the same work is still imported, and the ledger says so', function () {
    Queue::fake();
    Http::fake(['www.wikidata.org/*' => Http::response(['entities' => []])]);
    // An edition already on Marx's page under the same main title.
    $marx = app(\App\Services\Authors\AuthorRegistry::class)->ensure('marx', 'Karl Marx', 'Q9061');
    $penguin = 'marxtest_' . Str::lower(Str::random(8));
    marxDb()->table('library')->insert([
        'book' => $penguin, 'title' => 'Marxtest Capital: Volume 1 (Penguin Classics)', 'visibility' => 'public', 'has_nodes' => true,
        'type' => 'book', 'creator' => 'marxtest_user', 'timestamp' => round(microtime(true) * 1000), 'raw_json' => '{}',
    ]);
    app(\App\Services\Authors\AuthorLinker::class)->link($penguin, $marx->id);

    marxMockStitcher($this, marxMetadata(['title' => 'Marxtest Capital: A Critique of Political Economy, Volume One', 'author' => 'Karl Marx', 'year' => 1867]));
    $workId = marxWork('1867-c1/index.htm', 'marx');

    expect(app(MarxistsBulkImporter::class)->importWork($workId))->toBe('imported');
    $work = marxDb()->table('marxists_works')->where('id', $workId)->first();
    expect($work->same_title_as)->toBe($penguin)
        ->and($work->book)->not->toBe($penguin);

    expect(MarxistsBulkImporter::titleKey('Capital: A Critique of Political Economy, Volume One'))->toBe('capital')
        ->and(MarxistsBulkImporter::titleKey('Capital (Penguin Classics)'))->toBe('capital')
        ->and(MarxistsBulkImporter::titleKey('The Civil War in France'))->not->toBe(MarxistsBulkImporter::titleKey('The Class Struggles in France'));
});

test('a piece headed only by what it is takes the listing\'s fuller title', function () {
    expect(MarxistsBulkImporter::betterTitle('Afterword', 'Afterword to Letters from Prison to Sophie Liebknecht'))
        ->toBe('Afterword to Letters from Prison to Sophie Liebknecht')
        // A real title is kept, however the listing abbreviates or labels it.
        ->and(MarxistsBulkImporter::betterTitle('The Accumulation of Capital', 'Accumulation'))->toBe('The Accumulation of Capital')
        ->and(MarxistsBulkImporter::betterTitle('Imperialism, the Highest Stage of Capitalism', 'Imperialism (1916), a popular outline of it'))
            ->toBe('Imperialism, the Highest Stage of Capitalism')
        ->and(MarxistsBulkImporter::betterTitle('Capital', 'Contents'))->toBe('Capital')
        ->and(MarxistsBulkImporter::betterTitle('Capital', null))->toBe('Capital');
});

test('the Selected Works page flags works the listing found, and --selected imports only those', function () {
    Queue::fake();
    $listing = ['ok' => true, 'listing' => 'https://www.marxists.org/archive/lenin/by-date.htm', 'root' => '/archive/lenin/',
        'works' => [
            ['url' => MARXTEST_ROOT . '1893/letter.htm', 'title' => 'Marxtest letter', 'kind' => 'article'],
            ['url' => MARXTEST_ROOT . '1917/staterev/index.htm', 'title' => 'Preface', 'kind' => 'work_folder'],
        ], 'followed' => [], 'skipped' => []];
    // The editors' page links one listed work and one single chapter the listing never held.
    $selected = ['ok' => true, 'listing' => 'https://www.marxists.org/archive/lenin/works/sw/index.htm', 'root' => '/archive/lenin/',
        'works' => [
            ['url' => MARXTEST_ROOT . '1917/staterev/index.htm', 'title' => 'Marxtest State and Revolution', 'kind' => 'work_folder'],
            ['url' => MARXTEST_ROOT . '1899/devel/ch01.htm', 'title' => 'Marxtest chapter one', 'kind' => 'article'],
        ], 'followed' => [], 'skipped' => []];
    Process::fake(fn ($process) => Process::result(output: json_encode(
        str_contains(implode(' ', (array) $process->command), '/works/sw/') ? $selected : $listing
    )));
    marxDb()->table('marxists_works')->where('author', 'lenin')->where('url', 'NOT LIKE', '%/archive/marxtest/%')->where('status', 'listed')
        ->update(['status' => 'marxtest_parked']);

    try {
        $importer = app(MarxistsBulkImporter::class);
        // A dry run reports the match and writes nothing.
        expect($importer->listAuthor('lenin', dryRun: true)['selected'])->toMatchArray(['ok' => true, 'found' => 2, 'marked' => 1])
            ->and(marxDb()->table('marxists_works')->where('url', 'LIKE', '%/archive/marxtest/%')->count())->toBe(0);

        $result = $importer->listAuthor('lenin');
        expect($result['selected'])->toMatchArray(['ok' => true, 'found' => 2, 'marked' => 1, 'unlisted' => [MARXTEST_ROOT . '1899/devel/ch01.htm']]);
        $rows = marxDb()->table('marxists_works')->where('url', 'LIKE', '%/archive/marxtest/%')->orderBy('id')->get();
        // The chapter is not a work of its own: reported, never added. And the flagged work takes the
        // editors' title in place of the chapter name the by-date listing linked it by.
        expect($rows->pluck('selected', 'link_title')->all())->toBe(['Marxtest letter' => false, 'Marxtest State and Revolution' => true]);

        $this->artisan('marxists:import', ['author' => 'lenin', '--selected' => true, '--limit' => 10])->assertExitCode(0);
        expect(Queue::pushed(ImportMarxistsWorkJob::class)->map->workId->all())->toBe([(int) $rows[1]->id])
            ->and(marxDb()->table('marxists_works')->where('id', $rows[0]->id)->value('status'))->toBe('listed');
        $this->artisan('marxists:import', ['author' => 'lenin', '--selected' => true])->assertExitCode(0);
        expect(Queue::pushed(ImportMarxistsWorkJob::class))->toHaveCount(1);
        $this->artisan('marxists:status', ['author' => 'lenin'])->expectsOutputToContain('Selected works: 0 of 1 imported')->assertExitCode(0);
    } finally {
        marxDb()->table('marxists_works')->where('status', 'marxtest_parked')->update(['status' => 'listed']);
    }
});

test('a Selected Works page that cannot be read does not fail the listing', function () {
    Process::fake(fn ($process) => Process::result(output: json_encode(
        str_contains(implode(' ', (array) $process->command), '/works/sw/')
            ? ['ok' => false, 'error' => 'page_unavailable']
            : ['ok' => true, 'listing' => 'x', 'works' => [['url' => MARXTEST_ROOT . '1893/only.htm', 'title' => 'Marxtest only', 'kind' => 'article']], 'followed' => [], 'skipped' => []]
    ), exitCode: 0));

    $result = app(MarxistsBulkImporter::class)->listAuthor('lenin');
    expect($result)->toMatchArray(['ok' => true, 'new' => 1])
        ->and($result['selected'])->toMatchArray(['ok' => false, 'error' => 'page_unavailable']);
});

test('marxists:import claims a batch and queues it on the bulk lane, never twice', function () {
    Queue::fake();
    $a = marxWork('1916/a.htm', 'lenin', MarxistsBulkImporter::STATUS_LISTED);
    $b = marxWork('1916/b.htm', 'lenin', MarxistsBulkImporter::STATUS_LISTED);
    $c = marxWork('1916/c.htm', 'lenin', MarxistsBulkImporter::STATUS_LISTED);
    // Fence the batch to this test's rows: a dev ledger may hold real ones.
    marxDb()->table('marxists_works')->where('author', 'lenin')->whereNotIn('id', [$a, $b, $c])->where('status', 'listed')
        ->update(['status' => 'marxtest_parked']);

    try {
        $this->artisan('marxists:import', ['author' => 'lenin', '--limit' => 2, '--dry-run' => true])->assertExitCode(0);
        Queue::assertNothingPushed();

        $this->artisan('marxists:import', ['author' => 'lenin', '--limit' => 2])->assertExitCode(0);
        Queue::assertPushedOn('default', ImportMarxistsWorkJob::class);
        expect(Queue::pushed(ImportMarxistsWorkJob::class)->map->workId->all())->toBe([$a, $b])
            ->and(marxDb()->table('marxists_works')->whereIn('id', [$a, $b, $c])->orderBy('id')->pluck('status')->all())
            ->toBe(['queued', 'queued', 'listed']);

        // The next batch takes what is left; nothing is queued a second time.
        $this->artisan('marxists:import', ['author' => 'lenin', '--limit' => 5])->assertExitCode(0);
        expect(Queue::pushed(ImportMarxistsWorkJob::class)->map->workId->all())->toBe([$a, $b, $c]);

        $this->artisan('marxists:import', ['author' => 'nobody'])->assertExitCode(1);
    } finally {
        marxDb()->table('marxists_works')->where('status', 'marxtest_parked')->update(['status' => 'listed']);
    }
});

test('marxists:status runs for one author as well as for all', function () {
    // The per-author form joins `library`, which has an `author` column of its own — it died with
    // "column reference author is ambiguous" the first time it was run with an argument (prod 2026-11-24).
    marxWork('1916/status.htm', 'lenin', MarxistsBulkImporter::STATUS_LISTED);

    $this->artisan('marxists:status', ['author' => 'lenin'])->assertExitCode(0);
    $this->artisan('marxists:status')->assertExitCode(0);
});

test('marxists:status says what a running batch is on, how it is going and how long is left', function () {
    // The totals alone could not: a work reads `queued` from the moment it is queued until it
    // finishes, so a batch in flight looked the same as a batch that had not started.
    $done = fn (string $path, string $title, int $minutesAgo, string $status = MarxistsBulkImporter::STATUS_IMPORTED) =>
        marxDb()->table('marxists_works')->where('id', marxWork($path, 'trotsky', $status))
            ->update(['link_title' => $title, 'updated_at' => now()->subMinutes($minutesAgo)]);
    $done('1905/a.htm', 'Marxtest First', 9);
    $done('1905/b.htm', 'Marxtest Second', 6);
    $done('1905/c.htm', 'Marxtest Third', 3);
    $done('1905/d.htm', 'Marxtest Broken', 4, MarxistsBulkImporter::STATUS_FAILED);
    $running = marxWork('1905/e.htm', 'trotsky');
    marxDb()->table('marxists_works')->where('id', $running)->update(['link_title' => 'Marxtest Running']);
    $waiting = marxWork('1905/f.htm', 'trotsky');
    // Queueing stamps the whole batch at once; that stamp is how the batch is recognised.
    marxDb()->table('marxists_works')->whereIn('id', [$running, $waiting])->update(['updated_at' => now()->subMinutes(10)]);
    // …and a work finished BEFORE it belongs to an earlier batch, and is not counted.
    $done('1904/old.htm', 'Marxtest Earlier Batch', 45);
    $job = marxDb()->table('jobs')->insertGetId([
        'queue' => 'default', 'attempts' => 1, 'reserved_at' => time() - 120, 'available_at' => time(), 'created_at' => time(),
        'payload' => json_encode(['displayName' => ImportMarxistsWorkJob::class,
            'data' => ['command' => serialize(new ImportMarxistsWorkJob($running))]]),
    ]);

    try {
        $this->artisan('marxists:status', ['author' => 'trotsky'])
            // Three imported and one failed since the batch was queued, two still queued.
            ->expectsOutputToContain('This batch: 4 of 6 done, 2 to go — 1 FAILED')
            ->expectsOutputToContain('“Marxtest Running”  (2m so far)')
            // Four finishes over six minutes: two minutes a work, two works left.
            ->expectsOutputToContain('fetching left about 4m  (2m a work)')
            ->assertExitCode(0);
    } finally {
        marxDb()->table('jobs')->where('id', $job)->delete();
    }
});

test('a page whose licence statement is a long sentence still imports, on both lanes', function () {
    // MIA's real wording, 200+ characters. The short fixture sentence hid that it was being
    // written into a varchar(100) column, so every real Lenin letter failed at the insert.
    Queue::fake();
    $evidence = 'Public Domain: Lenin Internet Archive. You may freely copy, distribute, display and perform this work, as well as make derivative and commercial works. Please credit “Marxists Internet Archive” as your source.';
    marxMockStitcher($this, marxMetadata(['title' => 'Marxtest To His Sister Maria', 'author' => 'V.I. Lenin', 'year' => 1893,
        'licence' => ['code' => 'PDM', 'url' => null, 'evidence' => $evidence]]));
    $workId = marxWork('1893/oct/00mu.htm', 'lenin');

    expect(app(MarxistsBulkImporter::class)->importWork($workId))->toBe(MarxistsBulkImporter::STATUS_IMPORTED);

    $row = marxDb()->table('library')->where('book', marxDb()->table('marxists_works')->where('id', $workId)->value('book'))->first();
    expect($row->license)->toBe('PDM')->and($row->work_license)->toBe('PDM');
});
