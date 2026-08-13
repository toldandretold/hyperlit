<?php

/**
 * The second lane: a work can carry BOTH a vacuumed-PDF version and a publisher-HTML one, and
 * something has to choose which readers get.
 *
 * HtmlLaneCreator mints the sibling (foundation_source `journal_html`, the ar5iv-shaped
 * precedent) and selects work on its own predicate — deliberately NOT
 * HarvestEligibility::eligibleCanonicalsForJournal, which requires `auto_version_book IS NULL`
 * and so skips every work the PDF pass already claimed, i.e. exactly the ones worth comparing.
 *
 * JournalVersionPromoter makes the choice explicit. Without it the winner is whichever lane was
 * created first (AutoVersionResolver orders by created_at) — arbitrary and invisible.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (docs/journal-harvest.md).
 */

use App\Models\CanonicalSource;
use App\Services\JournalHarvest\HtmlLaneCreator;
use App\Services\JournalHarvest\JournalVersionPromoter;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

function jlaneDb()
{
    return DB::connection('pgsql_admin');
}

function jlaneCleanup(): void
{
    $db = jlaneDb();
    $journalIds = $db->table('journal_sources')->where('display_name', 'LIKE', 'JLane %')->pluck('id');
    if ($journalIds->isNotEmpty()) {
        $db->table('journal_import_runs')->whereIn('journal_source_id', $journalIds)->delete();
    }
    $shelfIds = $db->table('shelves')->where('name', 'LIKE', 'Journal: JLane%')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        $db->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        $db->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    $db->table('canonical_source')->where('title', 'LIKE', 'JLane %')->delete();
    $db->table('library')->where('book', 'LIKE', 'book_jlane%')->delete();
    $db->table('journal_sources')->where('display_name', 'LIKE', 'JLane %')->delete();
}

beforeEach(fn () => jlaneCleanup());

function jlaneSeedJournal(?string $shelfId = null): object
{
    $row = [
        'id'                 => (string) Str::uuid(),
        'openalex_source_id' => 'SJLANE' . Str::upper(Str::random(6)),
        'display_name'       => 'JLane Journal',
        'slug'               => 'jlane-' . Str::lower(Str::random(8)),
        'is_diamond'         => true,
        'shelf_id'           => $shelfId,
        'created_at'         => now(),
        'updated_at'         => now(),
    ];
    jlaneDb()->table('journal_sources')->insert($row);

    return (object) $row;
}

function jlaneSeedCanonical(string $journalId, array $opts = []): string
{
    $id = (string) Str::uuid();
    jlaneDb()->table('canonical_source')->insert(array_merge([
        'id'                => $id,
        'title'             => 'JLane Work ' . Str::random(4),
        'journal_source_id' => $journalId,
        'is_oa'             => true,
        'doi'               => '10.9999/jlane-' . Str::lower(Str::random(6)),
        'cited_by_count'    => 5,
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $opts));

    return $id;
}

function jlaneSeedLane(string $canonicalId, string $foundation, array $opts = []): string
{
    $book = 'book_jlane_' . Str::lower(Str::random(8));
    jlaneDb()->table('library')->insert(array_merge([
        'book'                => $book,
        'title'               => 'JLane Version',
        'visibility'          => 'public',
        'listed'              => false,
        'has_nodes'           => true,
        'type'                => 'book',
        'raw_json'            => '[]',
        'timestamp'           => 0,
        'canonical_source_id' => $canonicalId,
        'foundation_source'   => $foundation,
        'conversion_method'   => $foundation === 'journal_html' ? 'paste_engine_html' : 'pdf_ocr_auto_raw',
        'creator'             => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR,
        'created_at'          => now(),
    ], $opts));

    return $book;
}

// ── Selection: which works still need an HTML lane ──

test('pending includes works the PDF pass already claimed', function () {
    $journal = jlaneSeedJournal();

    // Claimed by the PDF lane — invisible to the normal eligibility predicate, which is exactly
    // why the HTML pass needs its own.
    $claimed = jlaneSeedCanonical($journal->id);
    $pdfBook = jlaneSeedLane($claimed, 'canonical_pdf_vacuum');
    jlaneDb()->table('canonical_source')->where('id', $claimed)->update(['auto_version_book' => $pdfBook]);

    $pending = app(HtmlLaneCreator::class)->pendingForJournal($journal->id);

    expect($pending->pluck('id'))->toContain($claimed);
});

test('pending excludes works whose HTML lane is already converted, and un-fetchable works', function () {
    $journal = jlaneSeedJournal();

    $done = jlaneSeedCanonical($journal->id);
    jlaneSeedLane($done, 'journal_html');

    $noUrl = jlaneSeedCanonical($journal->id, ['doi' => null, 'oa_url' => null]);

    $stub = jlaneSeedCanonical($journal->id);
    jlaneSeedLane($stub, 'journal_html', ['has_nodes' => false]); // minted but never converted

    $ids = app(HtmlLaneCreator::class)->pendingForJournal($journal->id)->pluck('id');

    expect($ids)->not->toContain($done);
    expect($ids)->not->toContain($noUrl);
    expect($ids)->toContain($stub); // a content-less stub must be retried
});

test('an already-converted HTML lane is never re-fetched', function () {
    $journal = jlaneSeedJournal();
    $canonicalId = jlaneSeedCanonical($journal->id);
    $book = jlaneSeedLane($canonicalId, 'journal_html');

    $result = app(HtmlLaneCreator::class)->create(CanonicalSource::on('pgsql_admin')->find($canonicalId));

    expect($result['status'])->toBe('already_imported');
    expect($result['book'])->toBe($book);
});

// ── Promotion ──

test('promoting a lane points the canonical at it, lists it, and unlists its sibling', function () {
    $journal = jlaneSeedJournal();
    $canonicalId = jlaneSeedCanonical($journal->id);
    $pdf  = jlaneSeedLane($canonicalId, 'canonical_pdf_vacuum', ['listed' => true]);
    $html = jlaneSeedLane($canonicalId, 'journal_html');
    jlaneDb()->table('canonical_source')->where('id', $canonicalId)->update(['auto_version_book' => $pdf]);

    $result = app(JournalVersionPromoter::class)->promote($html);

    expect($result['promoted'])->toBeTrue();
    expect($result['demoted'])->toBe([$pdf]);
    expect(jlaneDb()->table('canonical_source')->where('id', $canonicalId)->value('auto_version_book'))->toBe($html);
    expect((bool) jlaneDb()->table('library')->where('book', $html)->value('listed'))->toBeTrue();
    expect((bool) jlaneDb()->table('library')->where('book', $pdf)->value('listed'))->toBeFalse();
});

test('promotion swaps the winner onto the journal shelf in place of the loser', function () {
    // The shelf sync is additive, so without this the feed keeps serving the demoted lane.
    $shelfId = (string) Str::uuid();
    jlaneDb()->table('shelves')->insert([
        'id' => $shelfId, 'creator' => 'canonicalizer_v1', 'name' => 'Journal: JLane Shelf',
        'slug' => 'jlane-' . Str::lower(Str::random(8)), 'visibility' => 'public',
        'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
    ]);
    $journal = jlaneSeedJournal($shelfId);
    $canonicalId = jlaneSeedCanonical($journal->id);
    $pdf  = jlaneSeedLane($canonicalId, 'canonical_pdf_vacuum', ['listed' => true]);
    $html = jlaneSeedLane($canonicalId, 'journal_html');
    jlaneDb()->table('shelf_items')->insert(['shelf_id' => $shelfId, 'book' => $pdf, 'added_at' => now()]);

    app(JournalVersionPromoter::class)->promote($html);

    $onShelf = jlaneDb()->table('shelf_items')->where('shelf_id', $shelfId)->pluck('book')->all();
    expect($onShelf)->toBe([$html]);
});

test('promotion refuses a lane with no content or a non-system conversion method', function () {
    $journal = jlaneSeedJournal();
    $canonicalId = jlaneSeedCanonical($journal->id);

    $empty = jlaneSeedLane($canonicalId, 'journal_html', ['has_nodes' => false]);
    expect(app(JournalVersionPromoter::class)->promote($empty)['reason'])->toBe('no_content');

    // The authenticity gate did not confirm the page IS the article.
    $unverified = jlaneSeedLane($canonicalId, 'journal_html', ['conversion_method' => 'html_scrape_unverified']);
    expect(app(JournalVersionPromoter::class)->promote($unverified)['reason'])
        ->toBe('not_a_system_version:html_scrape_unverified');

    expect(app(JournalVersionPromoter::class)->promote('book_jlane_missing')['reason'])->toBe('not_found');
});

// ── Reconvert must not quietly demote ──

/**
 * Every re-import path ends in ContentFetchService::persistArticle, which rewrites the library row
 * with `listed = false`. On the lane readers are actually served, that is a SILENT demotion: the
 * article vanishes from /j and the journal shelf and nothing reports it. Caught live — a reconvert
 * of the promoted GSCJ lane left it unlisted.
 */
test('reconverting the promoted lane keeps it promoted', function () {
    $journal = jlaneSeedJournal();
    $canonicalId = jlaneSeedCanonical($journal->id);
    $htmlBook = jlaneSeedLane($canonicalId, 'journal_html');

    app(JournalVersionPromoter::class)->promote($htmlBook);
    expect((bool) jlaneDb()->table('library')->where('book', $htmlBook)->value('listed'))->toBeTrue();

    // Stand in for the converter: report success while doing what persistArticle really does.
    $fetcher = Mockery::mock(\App\Services\ContentFetchService::class);
    $fetcher->shouldReceive('reconvertHtmlLaneFromStoredPage')
        ->once()
        ->andReturnUsing(function (object $record) {
            jlaneDb()->table('library')->where('book', $record->book)->update(['listed' => false]);

            return ['status' => 'imported', 'reason' => 'imported', 'node_count' => 12];
        });
    app()->instance(\App\Services\ContentFetchService::class, $fetcher);

    $runId = (string) Str::uuid();
    jlaneDb()->table('journal_import_runs')->insert([
        'id'                  => $runId,
        'journal_source_id'   => $journal->id,
        'canonical_source_id' => $canonicalId,
        'action'              => 'reconvert_html',
        'lanes'               => 'html',
        'status'              => 'pending',
        'book'                => $htmlBook,
        'counts'              => '{}',
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);

    \App\Jobs\JournalImportActionJob::dispatchSync($runId);

    $run = jlaneDb()->table('journal_import_runs')->where('id', $runId)->first();
    expect($run->status)->toBe('completed');
    expect((bool) jlaneDb()->table('library')->where('book', $htmlBook)->value('listed'))->toBeTrue();
    expect(jlaneDb()->table('canonical_source')->where('id', $canonicalId)->value('auto_version_book'))
        ->toBe($htmlBook);
});

test('reconverting a lane that was never promoted leaves the pointer alone', function () {
    $journal = jlaneSeedJournal();
    $canonicalId = jlaneSeedCanonical($journal->id);
    $pdfBook  = jlaneSeedLane($canonicalId, 'canonical_pdf_vacuum');
    $htmlBook = jlaneSeedLane($canonicalId, 'journal_html');

    app(JournalVersionPromoter::class)->promote($pdfBook);

    $fetcher = Mockery::mock(\App\Services\ContentFetchService::class);
    $fetcher->shouldReceive('reconvertHtmlLaneFromStoredPage')
        ->once()
        ->andReturn(['status' => 'imported', 'reason' => 'imported', 'node_count' => 5]);
    app()->instance(\App\Services\ContentFetchService::class, $fetcher);

    $runId = (string) Str::uuid();
    jlaneDb()->table('journal_import_runs')->insert([
        'id'                  => $runId,
        'journal_source_id'   => $journal->id,
        'canonical_source_id' => $canonicalId,
        'action'              => 'reconvert_html',
        'lanes'               => 'html',
        'status'              => 'pending',
        'book'                => $htmlBook,
        'counts'              => '{}',
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);

    \App\Jobs\JournalImportActionJob::dispatchSync($runId);

    // Reconverting the loser must never steal the pointer.
    expect(jlaneDb()->table('canonical_source')->where('id', $canonicalId)->value('auto_version_book'))
        ->toBe($pdfBook);
    expect((bool) jlaneDb()->table('library')->where('book', $htmlBook)->value('listed'))->toBeFalse();
});

// ── The case bundle has to say WHICH lane, and of which journal ──

/**
 * A journal article carries sibling lanes, so "which book is this" doesn't tell the importing
 * side which one broke, nor whether the other is fine — and for a harvest case that IS the
 * diagnosis. canonical_source.json alone gives dev a bare journal_source_id uuid it cannot
 * resolve, so the manifest names the journal and the lane.
 */
test('the exported manifest names the lane, its siblings and the journal', function () {
    $journal = jlaneSeedJournal();
    $canonicalId = jlaneSeedCanonical($journal->id);
    $pdfBook  = jlaneSeedLane($canonicalId, 'canonical_pdf_vacuum');
    $htmlBook = jlaneSeedLane($canonicalId, 'journal_html');

    app(JournalVersionPromoter::class)->promote($htmlBook);

    $out = storage_path('app/book-exports/jlane-test.tar.gz');
    $stage = storage_path('app/book-exports/.jlane-extract');

    try {
        $exit = Artisan::call('book:export', [
            'book'     => $htmlBook,
            '--kind'   => 'harvest',
            '--origin' => 'journal-import',
            '--out'    => $out,
        ]);
        expect($exit)->toBe(0);

        File::ensureDirectoryExists($stage);
        exec(sprintf('tar -xzf %s -C %s', escapeshellarg($out), escapeshellarg($stage)));
        $manifest = json_decode((string) file_get_contents("{$stage}/manifest.json"), true);

        expect($manifest['origin'])->toBe('journal-import');
        expect($manifest['lane']['foundation_source'])->toBe('journal_html');
        expect($manifest['lane']['is_promoted_version'])->toBeTrue();
        expect($manifest['journal']['slug'])->toBe($journal->slug);
        expect($manifest['journal']['display_name'])->toBe($journal->display_name);

        // The sibling PDF lane is named, so dev knows a second conversion of the same work exists.
        expect($manifest['lane']['siblings'])->toHaveCount(1);
        expect($manifest['lane']['siblings'][0]['book'])->toBe($pdfBook);
        expect($manifest['lane']['siblings'][0]['is_promoted_version'])->toBeFalse();

        // And the registry row travels too — without it the uuid resolves to nothing locally.
        expect(file_exists("{$stage}/db/journal_sources.json"))->toBeTrue();
    } finally {
        File::delete($out);
        File::deleteDirectory($stage);
    }
});

