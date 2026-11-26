<?php

/**
 * /maintainer/shelf-import — the journal-import console generalized to a public shelf.
 * The lane nesting comes from the shared BuildsImportLanes trait (canonical join, so
 * sibling lanes NOT on the shelf still appear), `run` fires the same
 * JournalImportActionJob with shelf_id on the run row, and promote gains an optional
 * shelf_id that swaps the winner onto the scope shelf.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (an afterEach admin delete deadlocks
 * against the still-open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function siDb()
{
    return DB::connection('pgsql_admin');
}

function siCleanup(): void
{
    $siShelfNames = fn ($q) => $q
        ->where('name', 'LIKE', 'SI %')
        ->orWhere('name', 'LIKE', 'Cited by: SI %')
        ->orWhere('name', 'LIKE', 'Case import: SI %');
    siDb()->table('journal_import_runs')->whereIn(
        'shelf_id',
        siDb()->table('shelves')->where($siShelfNames)->pluck('id')
    )->delete();
    siDb()->table('shelf_items')->whereIn(
        'shelf_id',
        siDb()->table('shelves')->where($siShelfNames)->pluck('id')
    )->delete();
    siDb()->table('conversion_lint_snapshots')->whereIn(
        'scope_id',
        siDb()->table('shelves')->where($siShelfNames)->pluck('id')
    )->delete();
    siDb()->table('shelves')->where($siShelfNames)->delete();
    siDb()->table('nodes')->where('book', 'LIKE', 'book_si%')->delete();
    siDb()->table('conversion_lint_results')->where('book', 'LIKE', 'book_si%')->delete();
    siDb()->table('conversion_lint_reviews')->where('book', 'LIKE', 'book_si%')->delete();
    siDb()->table('conversion_flags')->where('book', 'LIKE', 'book_si%')->delete();
    siDb()->table('jobs')->where('payload', 'LIKE', '%si-backlog-marker%')->delete();
    siDb()->table('canonical_source')->where('title', 'LIKE', 'SI %')->delete();
    siDb()->table('library')->where('book', 'LIKE', 'book_si%')->delete();
    siDb()->table('journal_sources')->where('display_name', 'LIKE', 'SI %')->delete();
}

beforeEach(fn () => siCleanup());

function siSeedShelf(string $visibility = 'public', array $opts = []): object
{
    $row = array_merge([
        'id'         => (string) Str::uuid(),
        'creator'    => 'si_shelf_owner',
        'name'       => 'SI Shelf ' . Str::random(6),
        'slug'       => 'si-shelf-' . Str::lower(Str::random(8)),
        'visibility' => $visibility,
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts);
    siDb()->table('shelves')->insert($row);

    return (object) $row;
}

/** A canonical plus one library row per requested lane; first lane's book goes on the shelf. */
function siSeedShelvedWork(object $shelf, array $lanes, array $canonical = []): array
{
    $canonicalId = (string) Str::uuid();
    $books = [];

    foreach ($lanes as $lane) {
        $book = 'book_si_' . Str::lower(Str::random(8));
        siDb()->table('library')->insert(array_merge([
            'book'                => $book,
            'title'               => 'SI Version',
            'visibility'          => 'public',
            'listed'              => false,
            'has_nodes'           => true,
            'type'                => 'book',
            'raw_json'            => '[]',
            'timestamp'           => 0,
            'canonical_source_id' => $canonicalId,
            'creator'             => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR,
            'created_at'          => now(),
        ], $lane));
        $books[$lane['foundation_source'] ?? 'unknown'] = $book;
    }

    siDb()->table('canonical_source')->insert(array_merge([
        'id'             => $canonicalId,
        'title'          => 'SI Work',
        'is_oa'          => true,
        'pdf_url'        => 'https://example.org/si.pdf',
        'cited_by_count' => 10,
        'created_at'     => now(),
        'updated_at'     => now(),
    ], $canonical));

    if ($books !== []) {
        siDb()->table('shelf_items')->insert([
            'shelf_id' => $shelf->id,
            'book'     => array_values($books)[0],
            'added_at' => now(),
        ]);
    }

    return ['canonical_id' => $canonicalId, 'books' => $books];
}

// ── Gating ──

test('the pages 404 for guests and non-admins, and for unknown or private shelves', function () {
    $public = siSeedShelf('public');
    $private = siSeedShelf('private');

    $this->get('/maintainer/shelf-import')->assertNotFound();
    $this->get('/maintainer/shelf-import/' . $public->id)->assertNotFound();

    $this->loginUser();
    $this->get('/maintainer/shelf-import')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/shelf-import')->assertOk()->assertViewIs('maintainer-shelf-import');
    $this->get('/maintainer/shelf-import/' . $public->id)->assertOk()->assertViewIs('maintainer-shelf-import');
    $this->get('/maintainer/shelf-import/' . $private->id)->assertNotFound();
    $this->get('/maintainer/shelf-import/' . Str::uuid())->assertNotFound();
});

test('the API endpoints are admin-gated and refuse a private shelf', function () {
    $private = siSeedShelf('private');

    $this->loginUser(); // authenticated, not admin
    $this->getJson('/api/maintainer/shelf-import/shelves')->assertStatus(403);
    $this->getJson('/api/maintainer/shelf-import/' . Str::uuid() . '/articles')->assertStatus(403);

    $this->loginUser(['is_admin' => true]);
    $this->getJson('/api/maintainer/shelf-import/' . $private->id . '/articles')->assertStatus(404);
    $this->postJson('/api/maintainer/shelf-import/' . $private->id . '/run')->assertStatus(404);
});

test('a journal slug redirects to that journal cited shelf when one exists, else 404s', function () {
    $this->loginUser(['is_admin' => true]);

    $journal = (object) [
        'id'           => (string) Str::uuid(),
        'display_name' => 'SI Aliased Journal',
        'slug'         => 'si-alias-' . Str::lower(Str::random(8)),
    ];
    siDb()->table('journal_sources')->insert([
        'id'                 => $journal->id,
        'openalex_source_id' => 'SSI' . Str::upper(Str::random(6)),
        'display_name'       => $journal->display_name,
        'slug'               => $journal->slug,
        'created_at'         => now(),
        'updated_at'         => now(),
    ]);

    // No cited shelf yet → 404.
    $this->get('/maintainer/shelf-import/' . $journal->slug)->assertNotFound();

    $shelf = app(\App\Services\SourceHarvest\HarvestShelf::class)->ensureCitedShelfFor($journal->display_name);
    $this->get('/maintainer/shelf-import/' . $journal->slug)
        ->assertRedirect('/maintainer/shelf-import/' . $shelf->id);

    $this->get('/maintainer/shelf-import/no-such-thing')->assertNotFound();
});

// ── Index payload ──

test('shelves lists public shelves with counts, system collection shelves first', function () {
    $this->loginUser(['is_admin' => true]);

    $plain = siSeedShelf('public');
    siSeedShelf('private'); // never listed
    $system = siSeedShelf('public', [
        'name'    => 'Cited by: SI Some Journal',
        'creator' => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR,
    ]);
    // The book:import-cases vacuum shelf counts as a system collection too.
    $caseShelf = siSeedShelf('public', ['name' => 'Case import: SI 2026-08-27 10:00']);

    // One canonical-linked item and one canonical-less item on the plain shelf.
    siSeedShelvedWork($plain, [['foundation_source' => 'canonical_pdf_vacuum']]);
    $bare = 'book_si_bare' . Str::lower(Str::random(4));
    siDb()->table('library')->insert([
        'book'       => $bare,
        'title'      => 'SI Bare Book',
        'visibility' => 'public',
        'listed'     => true,
        'has_nodes'  => true,
        'type'       => 'book',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
    ]);
    siDb()->table('shelf_items')->insert(['shelf_id' => $plain->id, 'book' => $bare, 'added_at' => now()]);

    $rows = collect($this->getJson('/api/maintainer/shelf-import/shelves')->assertOk()->json('shelves'));

    $plainRow = $rows->firstWhere('id', $plain->id);
    expect($plainRow['item_count'])->toBe(2);
    expect($plainRow['linked_count'])->toBe(1);
    expect($plainRow['is_system'])->toBeFalse();

    $systemRow = $rows->firstWhere('id', $system->id);
    expect($systemRow['is_system'])->toBeTrue();
    expect($rows->firstWhere('id', $caseShelf->id)['is_system'])->toBeTrue();

    // System shelves sort before non-system ones regardless of size.
    $ours = $rows->filter(fn ($s) => in_array($s['id'], [$plain->id, $system->id], true))->values();
    expect($ours[0]['id'])->toBe($system->id);

    expect($rows->pluck('id'))->not->toContain(
        siDb()->table('shelves')->where('visibility', 'private')->where('name', 'LIKE', 'SI %')->value('id')
    );
});

// ── Articles payload ──

test('articles nests ALL sibling lanes of a shelved work, and counts canonical-less items', function () {
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');

    // The PDF lane is on the shelf; the HTML sibling is NOT — it must still appear.
    $work = siSeedShelvedWork($shelf, [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'pdf_ocr_auto_raw'],
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html'],
    ]);
    siDb()->table('canonical_source')->where('id', $work['canonical_id'])
        ->update(['auto_version_book' => $work['books']['canonical_pdf_vacuum']]);

    // A deleted lane is skipped.
    $deleted = siSeedShelvedWork($shelf, [
        ['foundation_source' => 'canonical_pdf_vacuum'],
        ['foundation_source' => 'journal_html', 'visibility' => 'deleted'],
    ], ['title' => 'SI Deleted Lane Work']);

    // A canonical-less shelf item still counts in unlinked_count, but now ALSO
    // appears as a synthetic standalone article (the vacuum-shelf case).
    $bare = 'book_si_bare' . Str::lower(Str::random(4));
    siDb()->table('library')->insert([
        'book'       => $bare,
        'title'      => 'SI Bare Book',
        'visibility' => 'public',
        'listed'     => true,
        'has_nodes'  => true,
        'type'       => 'book',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
    ]);
    siDb()->table('shelf_items')->insert(['shelf_id' => $shelf->id, 'book' => $bare, 'added_at' => now()]);

    $body = $this->getJson('/api/maintainer/shelf-import/' . $shelf->id . '/articles')->assertOk()->json();

    expect($body['shelf']['id'])->toBe($shelf->id);
    expect($body['shelf']['item_count'])->toBe(3);
    expect($body['shelf']['unlinked_count'])->toBe(1);
    expect($body['articles'])->toHaveCount(3);
    expect(collect($body['articles'])->pluck('canonical_id'))->toContain('book:' . $bare);

    $article = collect($body['articles'])->firstWhere('canonical_id', $work['canonical_id']);
    $lanes = collect($article['lanes']);
    expect($lanes)->toHaveCount(2);
    expect($lanes->pluck('lane')->sort()->values()->all())->toBe(['html', 'pdf']);
    expect($lanes->firstWhere('lane', 'pdf')['is_version'])->toBeTrue();
    expect($lanes->firstWhere('lane', 'html')['is_version'])->toBeFalse();

    $deletedArticle = collect($body['articles'])->firstWhere('canonical_id', $deleted['canonical_id']);
    expect(collect($deletedArticle['lanes'])->pluck('lane'))->not->toContain('html');
});

test('a vacuum lane is labelled by what the fetch ladder actually won with, not "pdf"', function () {
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');

    // The vacuum lane runs the whole ContentFetchService ladder: JATS (strategy 0) and the
    // browser page fetch (strategy 5) never touch a PDF, so labelling their rows 'pdf' lies.
    $jats = siSeedShelvedWork($shelf, [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'jats_fulltext'],
    ], ['title' => 'SI Jats Work']);
    $web = siSeedShelvedWork($shelf, [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'paste_engine_html'],
    ], ['title' => 'SI Web Work']);

    $body = $this->getJson('/api/maintainer/shelf-import/' . $shelf->id . '/articles')->assertOk()->json();
    $laneFor = fn (array $work) => collect($body['articles'])
        ->firstWhere('canonical_id', $work['canonical_id'])['lanes'][0]['lane'];

    expect($laneFor($jats))->toBe('jats');
    expect($laneFor($web))->toBe('web');
});

test('a canonical-less shelf book folds to a standalone article: unfetchable, no false approval flag, unimportable', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');

    // A claimed case book: private, canonical-less, converter-produced.
    $case = 'book_si_case' . Str::lower(Str::random(4));
    siDb()->table('library')->insert([
        'book'              => $case,
        'title'             => 'SI Case Book',
        'visibility'        => 'private',
        'listed'            => false,
        'has_nodes'         => true,
        'type'              => 'book',
        'raw_json'          => '[]',
        'timestamp'         => 0,
        'conversion_method' => 'pdf_ocr_auto_raw',
        'created_at'        => now(),
    ]);
    siDb()->table('shelf_items')->insert(['shelf_id' => $shelf->id, 'book' => $case, 'added_at' => now()]);

    // A deleted canonical-less book is excluded entirely.
    $gone = 'book_si_gone' . Str::lower(Str::random(4));
    siDb()->table('library')->insert([
        'book'       => $gone,
        'title'      => 'SI Gone Book',
        'visibility' => 'deleted',
        'listed'     => false,
        'has_nodes'  => true,
        'type'       => 'book',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
    ]);
    siDb()->table('shelf_items')->insert(['shelf_id' => $shelf->id, 'book' => $gone, 'added_at' => now()]);

    $body = $this->getJson('/api/maintainer/shelf-import/' . $shelf->id . '/articles')->assertOk()->json();

    $article = collect($body['articles'])->firstWhere('canonical_id', 'book:' . $case);
    expect($article)->not->toBeNull();
    expect($article['title'])->toBe('SI Case Book');
    expect($article['fetchable'])->toBeFalse();          // null doi/urls → import bar disabled

    $lanes = collect($article['lanes']);
    expect($lanes)->toHaveCount(1);
    expect($lanes[0]['book'])->toBe($case);
    expect($lanes[0]['conversion_method'])->toBe('pdf_ocr_auto_raw');
    expect($lanes[0]['is_version'])->toBeTrue();         // auto_version_book = the book itself
    expect($lanes[0]['needs_approval'])->toBeFalse();    // no false "⚑ needs approval"
    expect($lanes[0]['fixture'])->toBeNull();
    expect($lanes[0]['golden_complete'])->toBeFalse();

    expect(collect($body['articles'])->firstWhere('canonical_id', 'book:' . $gone))->toBeNull();

    // The synthetic id is not a uuid, so run's import validation refuses it.
    $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', [
        'action'       => 'import',
        'canonical_id' => 'book:' . $case,
    ])->assertStatus(422);
    Queue::assertNothingPushed();
});

// ── Run ──

test('run refuses journal-registry actions and canonicals not on the shelf', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    siSeedShelvedWork($shelf, [['foundation_source' => 'canonical_pdf_vacuum']]);

    foreach (['enumerate', 'import_all'] as $action) {
        $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', ['action' => $action])
            ->assertStatus(422);
    }
    $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', ['action' => 'nonsense'])
        ->assertStatus(422);

    // A canonical that exists but is not on this shelf.
    $offShelfId = (string) Str::uuid();
    siDb()->table('canonical_source')->insert([
        'id'         => $offShelfId,
        'title'      => 'SI Off-Shelf Work',
        'is_oa'      => true,
        'pdf_url'    => 'https://example.org/off.pdf',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', [
        'action'       => 'import',
        'canonical_id' => $offShelfId,
    ])->assertStatus(422);

    Queue::assertNothingPushed();
});

test('run inserts a shelf-keyed row, dispatches the shared job, and guards its target', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $work = siSeedShelvedWork($shelf, [['foundation_source' => 'canonical_pdf_vacuum']]);

    $body = $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', [
        'action'       => 'import',
        'lanes'        => 'html',
        'canonical_id' => $work['canonical_id'],
    ])->assertOk()->json();
    expect($body['already_running'])->toBeFalse();
    Queue::assertPushed(\App\Jobs\JournalImportActionJob::class, 1);

    $run = siDb()->table('journal_import_runs')->where('id', $body['run_id'])->first();
    expect($run->shelf_id)->toBe($shelf->id);
    expect($run->journal_source_id)->toBeNull();
    expect($run->action)->toBe('import');
    expect($run->lanes)->toBe('html');
    expect($run->canonical_source_id)->toBe($work['canonical_id']);

    // A second press on the same canonical joins the in-flight run.
    $second = $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', [
        'action'       => 'import',
        'lanes'        => 'html',
        'canonical_id' => $work['canonical_id'],
    ])->assertOk()->json();
    expect($second['already_running'])->toBeTrue();
    expect($second['run_id'])->toBe($body['run_id']);
    Queue::assertPushed(\App\Jobs\JournalImportActionJob::class, 1);
});

test('reconvert_html targets an existing html lane only', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $work = siSeedShelvedWork($shelf, [
        ['foundation_source' => 'canonical_pdf_vacuum'],
        ['foundation_source' => 'journal_html'],
    ]);

    // A PDF lane must be refused — its reconvert is the shared /api/books path.
    $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', [
        'action' => 'reconvert_html',
        'book'   => $work['books']['canonical_pdf_vacuum'],
    ])->assertStatus(422);

    $ok = $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', [
        'action' => 'reconvert_html',
        'book'   => $work['books']['journal_html'],
    ])->assertOk()->json();
    $run = siDb()->table('journal_import_runs')->where('id', $ok['run_id'])->first();
    expect($run->book)->toBe($work['books']['journal_html']);
    expect($run->shelf_id)->toBe($shelf->id);
    expect($run->canonical_source_id)->toBe($work['canonical_id']);

    $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', [
        'action' => 'reconvert_html',
        'book'   => 'book_si_missing',
    ])->assertStatus(404);
});

// ── Promote with a scope shelf ──

test('promote with shelf_id swaps the winner onto the scope shelf in place of demoted siblings', function () {
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');

    $work = siSeedShelvedWork($shelf, [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'pdf_ocr_auto_raw', 'listed' => true],
        ['foundation_source' => 'journal_html', 'conversion_method' => 'paste_engine_html'],
    ]);
    $pdf = $work['books']['canonical_pdf_vacuum'];   // on the shelf, currently the version
    $html = $work['books']['journal_html'];          // not on the shelf yet
    siDb()->table('canonical_source')->where('id', $work['canonical_id'])
        ->update(['auto_version_book' => $pdf]);

    $this->postJson("/api/maintainer/journal-import/promote/{$html}", ['shelf_id' => $shelf->id])
        ->assertOk()
        ->assertJsonPath('promoted', true)
        ->assertJsonPath('demoted', [$pdf]);

    $onShelf = siDb()->table('shelf_items')->where('shelf_id', $shelf->id)->pluck('book');
    expect($onShelf)->toContain($html);
    expect($onShelf)->not->toContain($pdf);
});

test('promote ignores an unknown or private shelf_id and journal behavior is unchanged without one', function () {
    $this->loginUser(['is_admin' => true]);
    $private = siSeedShelf('private');

    $work = siSeedShelvedWork($private, [
        ['foundation_source' => 'canonical_pdf_vacuum', 'conversion_method' => 'pdf_ocr_auto_raw'],
    ]);
    $pdf = $work['books']['canonical_pdf_vacuum'];

    // A private shelf id is ignored: promote succeeds, membership untouched.
    $before = siDb()->table('shelf_items')->where('shelf_id', $private->id)->pluck('book')->all();
    $this->postJson("/api/maintainer/journal-import/promote/{$pdf}", ['shelf_id' => $private->id])
        ->assertOk()
        ->assertJsonPath('promoted', true);
    expect(siDb()->table('shelf_items')->where('shelf_id', $private->id)->pluck('book')->all())
        ->toBe($before);

    // No shelf_id at all: plain promote still works (the journal console's path).
    siDb()->table('canonical_source')->where('id', $work['canonical_id'])
        ->update(['auto_version_book' => null]);
    $this->postJson("/api/maintainer/journal-import/promote/{$pdf}", ['shelf_id' => 'not-a-uuid'])
        ->assertOk()
        ->assertJsonPath('promoted', true);
});

test('reconvert_all on a shelf reaches books that have no canonical source', function () {
    // The marxists.org archive shelf: system-minted books with no canonical_source row. The run
    // joined canonical_source INNER, matched nothing, and reported "0 book(s) queued" (prod 2026-11-24).
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $linked = siSeedShelvedWork($shelf, [['foundation_source' => 'canonical_pdf_vacuum']])['books']['canonical_pdf_vacuum'];
    $unlinked = 'book_si_' . Str::lower(Str::random(8));
    siDb()->table('library')->insert([
        'book' => $unlinked, 'title' => 'SI Unlinked', 'visibility' => 'public', 'listed' => false, 'has_nodes' => true,
        'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0, 'canonical_source_id' => null,
        'creator' => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR, 'created_at' => now(),
    ]);
    siDb()->table('shelf_items')->insert(['shelf_id' => $shelf->id, 'book' => $unlinked, 'added_at' => now()]);

    $asked = [];
    $this->mock(\App\Services\Conversion\BookReconverter::class, function ($mock) use (&$asked) {
        $mock->shouldReceive('queue')->andReturnUsing(function (string $book) use (&$asked) {
            $asked[] = $book;

            return ['queued' => true, 'reason' => null, 'source' => 'epub'];
        });
    });

    Queue::fake();
    $runId = $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/run', ['action' => 'reconvert_all', 'lanes' => 'both'])
        ->assertOk()->json('run_id');
    app()->call([new \App\Jobs\JournalImportActionJob($runId), 'handle']);

    expect($asked)->toEqualCanonicalizing([$linked, $unlinked]);
    $run = siDb()->table('journal_import_runs')->where('id', $runId)->first();
    expect($run->status)->toBe('completed')
        ->and(json_decode($run->counts, true)['queued'])->toBe(2);
});

// ── Scope-wide run feedback: the same signals the journal console carries ──
//
// reconvert_all has been on this console since it was on the journal one, but every piece of
// feedback built afterwards (re-attach after a reload, the drain count, the lint before/after)
// shipped journal-only. These hold the shelf scope to the same contract, through the same code
// (App\Services\Conversion\ImportConsoleScope).

/**
 * A queued conversion job row for `$book`, serialized the way the queue really does it — the
 * count reads the job's own `bookId` property out of this payload, so a hand-written stub would
 * only prove the regex matches the stub.
 */
function siQueuedConversion(string $queue, string $book): array
{
    $job = new \App\Jobs\ProcessDocumentImportJob($book, 'pdf', null, ['marker' => 'si-backlog-marker'], []);

    return [
        'queue'        => $queue,
        'payload'      => json_encode([
            'uuid'        => (string) Str::uuid(),
            'displayName' => \App\Jobs\ProcessDocumentImportJob::class,
            'data'        => ['commandName' => \App\Jobs\ProcessDocumentImportJob::class, 'command' => serialize($job)],
        ]),
        'attempts'     => 0,
        'available_at' => time(),
        'created_at'   => time(),
    ];
}

function siSeedNodes(string $book, array $htmls): void
{
    siDb()->table('nodes')->where('book', $book)->delete();
    foreach ($htmls as $i => $html) {
        siDb()->table('nodes')->insert([
            'book'      => $book,
            'startLine' => ($i + 1) * 100,
            'chunk_id'  => 0,
            'node_id'   => $book . '_n' . $i,
            'content'   => $html,
            'plainText' => strip_tags($html),
        ]);
    }
}

/** A page-break fragment wrapped as a blockquote — one `fragment_blockquote` finding. */
function siBrokenNodes(): array
{
    return [
        '<p>Alternative voices are less heard or read on the Internet than Mainstream ones. The assignment of</p>',
        '<blockquote><p>domain names (such as microsoft.com) has been commodified. Formerly a state-owned foundation was in control of this area.</p></blockquote>',
    ];
}

function siCleanNodes(): array
{
    return [
        '<p>Alternative voices are less heard or read on the Internet than Mainstream ones.</p>',
        '<p>The assignment of domain names (such as microsoft.com) has been commodified entirely.</p>',
    ];
}

test('the new shelf-scoped endpoints are admin-gated and refuse a private shelf', function () {
    $private = siSeedShelf('private');
    $base = '/api/maintainer/shelf-import/' . $private->id;

    $this->loginUser();
    $this->getJson("{$base}/reconvert-backlog")->assertStatus(403);
    $this->getJson("{$base}/lint")->assertStatus(403);
    $this->postJson("{$base}/lint/snapshot")->assertStatus(403);
    $this->deleteJson("{$base}/lint/snapshot")->assertStatus(403);
    $this->postJson("{$base}/lint/review")->assertStatus(403);
    $this->getJson("{$base}/lint/cases")->assertStatus(403);

    $this->loginUser(['is_admin' => true]);
    $this->getJson("{$base}/reconvert-backlog")->assertNotFound();
    $this->getJson("{$base}/lint")->assertNotFound();
    $this->postJson("{$base}/lint/snapshot")->assertNotFound();
});

test('the articles payload carries an in-flight shelf-wide run so a reload can re-attach', function () {
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $work = siSeedShelvedWork($shelf, [['foundation_source' => 'journal_html']]);
    $url = '/api/maintainer/shelf-import/' . $shelf->id . '/articles';

    expect($this->getJson($url)->assertOk()->json('active_run'))->toBeNull();

    $run = fn (array $o) => array_merge([
        'id' => (string) Str::uuid(), 'shelf_id' => $shelf->id, 'action' => 'reconvert_all',
        'lanes' => 'both', 'status' => 'running', 'counts' => '{}',
        'created_at' => now(), 'updated_at' => now(),
    ], $o);

    // One article's action reports into its own bar — it is not the shelf-wide run.
    siDb()->table('journal_import_runs')->insert($run([
        'action' => 'reconvert_html', 'canonical_source_id' => $work['canonical_id'],
        'book' => $work['books']['journal_html'],
    ]));
    expect($this->getJson($url)->json('active_run'))->toBeNull();

    $wide = $run([
        'step_detail' => 'queueing reconversions: 25 of 60',
        'progress'    => json_encode(['phase' => 'reconvert', 'n' => 25, 'total' => 60, 'queued' => 24, 'skipped' => 1]),
    ]);
    siDb()->table('journal_import_runs')->insert($wide);

    $active = $this->getJson($url)->json('active_run');
    expect($active['id'])->toBe($wide['id']);
    expect($active['action'])->toBe('reconvert_all');
    expect($active['progress']['total'])->toBe(60);

    // Finished queueing: nothing to re-attach to (the drain count takes over from here).
    siDb()->table('journal_import_runs')->where('id', $wide['id'])->update(['status' => 'completed']);
    expect($this->getJson($url)->json('active_run'))->toBeNull();
});

test('a draining shelf reconvert_all is countable, whatever shape the book ids are', function () {
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $other = siSeedShelf('public');

    // A shelf holds both kinds of id: harvested lanes are uuids, case / marxists / uploaded
    // books are `book_…`. The journal-only count matched uuids and would have missed the latter.
    $uuidBook = (string) Str::uuid();
    siDb()->table('library')->insert([
        'book' => $uuidBook, 'title' => 'SI Version', 'visibility' => 'public', 'listed' => false,
        'has_nodes' => true, 'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0,
        'creator' => 'si_shelf_owner', 'created_at' => now(),
    ]);
    siDb()->table('shelf_items')->insert(['shelf_id' => $shelf->id, 'book' => $uuidBook, 'added_at' => now()]);
    $mine    = siSeedShelvedWork($shelf, [['foundation_source' => 'canonical_pdf_vacuum']])['books']['canonical_pdf_vacuum'];
    // A sibling lane that is LISTED on this shelf's page but is not a member: reconvert all does
    // not touch it, so its queued job is not this shelf's drain.
    $sibling = siSeedShelvedWork($shelf, [
        ['foundation_source' => 'canonical_pdf_vacuum'],
        ['foundation_source' => 'journal_html'],
    ])['books']['journal_html'];
    $foreign = siSeedShelvedWork($other, [['foundation_source' => 'canonical_pdf_vacuum']])['books']['canonical_pdf_vacuum'];

    try {
        siDb()->table('jobs')->insert([
            siQueuedConversion('default', $mine),       // the bulk fan-out lane
            siQueuedConversion('default', $uuidBook),
            siQueuedConversion('imports', $mine),       // a hand reconvert of one of its books
            siQueuedConversion('default', $sibling),
            siQueuedConversion('default', $foreign),    // another shelf's drain
        ]);

        $this->getJson('/api/maintainer/shelf-import/' . $shelf->id . '/reconvert-backlog')
            ->assertOk()->assertJson(['pending' => 3]);
        expect($this->getJson('/api/maintainer/shelf-import/' . $shelf->id . '/articles')->json('reconvert_backlog'))
            ->toBe(3);
        $this->getJson('/api/maintainer/shelf-import/' . $other->id . '/reconvert-backlog')
            ->assertOk()->assertJson(['pending' => 1]);
    } finally {
        siDb()->table('jobs')->where('payload', 'LIKE', '%si-backlog-marker%')->delete();
        siDb()->table('library')->where('book', $uuidBook)->delete();
    }
});

test('a second shelf reconvert_all is refused while the first is still draining', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $book = siSeedShelvedWork($shelf, [['foundation_source' => 'canonical_pdf_vacuum']])['books']['canonical_pdf_vacuum'];
    $url = '/api/maintainer/shelf-import/' . $shelf->id . '/run';

    try {
        // The first run has finished QUEUEING (no run row in flight) but its job is still waiting.
        siDb()->table('jobs')->insert([siQueuedConversion('default', $book)]);

        $this->postJson($url, ['action' => 'reconvert_all', 'lanes' => 'both'])
            ->assertStatus(409)
            ->assertJsonPath('pending', 1);
        Queue::assertNothingPushed();
        expect(siDb()->table('journal_import_runs')->where('shelf_id', $shelf->id)->exists())->toBeFalse();

        // Drained: the same press goes through.
        siDb()->table('jobs')->where('payload', 'LIKE', '%si-backlog-marker%')->delete();
        $body = $this->postJson($url, ['action' => 'reconvert_all', 'lanes' => 'html'])->assertOk()->json();
        expect($body['already_running'])->toBeFalse();
        $run = siDb()->table('journal_import_runs')->where('id', $body['run_id'])->first();
        expect($run->shelf_id)->toBe($shelf->id);
        expect($run->canonical_source_id)->toBeNull();
        expect($run->lanes)->toBe('html');
    } finally {
        siDb()->table('jobs')->where('payload', 'LIKE', '%si-backlog-marker%')->delete();
    }
});

test('a shelf-wide reconvert_all and a single-article action hold each other off', function () {
    Queue::fake();
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $work = siSeedShelvedWork($shelf, [['foundation_source' => 'journal_html']]);
    $url = '/api/maintainer/shelf-import/' . $shelf->id . '/run';

    $wide = $this->postJson($url, ['action' => 'reconvert_all'])->assertOk()->json();
    $single = $this->postJson($url, ['action' => 'reconvert_html', 'book' => $work['books']['journal_html']])
        ->assertOk()->json();

    expect($single['already_running'])->toBeTrue();
    expect($single['run_id'])->toBe($wide['run_id']);
    expect($single['action'])->toBe('reconvert_all');
    Queue::assertPushed(\App\Jobs\JournalImportActionJob::class, 1);
});

test('lint covers the shelf MEMBERS, and a snapshot turns it into a before/after', function () {
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $work = siSeedShelvedWork($shelf, [
        ['foundation_source' => 'canonical_pdf_vacuum', 'timestamp' => 1000],
        ['foundation_source' => 'journal_html', 'timestamp' => 1000],     // sibling, not on the shelf
    ]);
    $member  = $work['books']['canonical_pdf_vacuum'];
    $sibling = $work['books']['journal_html'];
    siSeedNodes($member, siBrokenNodes());
    siSeedNodes($sibling, siBrokenNodes());
    $base = '/api/maintainer/shelf-import/' . $shelf->id;

    $body = $this->getJson("{$base}/lint")->assertOk()->json();
    expect($body['pending'])->toBe(0);
    expect($body['total'])->toBe(1);
    expect($body['books'])->toHaveKey($member);
    expect($body['books'])->not->toHaveKey($sibling);
    expect($body['books'][$member]['counts'])->toBe(['fragment_blockquote' => 1]);
    expect($body['compare'])->toBeNull();

    $this->postJson("{$base}/lint/snapshot")->assertOk()->assertJsonPath('snapshot.books', 1);
    expect(siDb()->table('conversion_lint_snapshots')->where('scope_id', $shelf->id)->exists())->toBeTrue();

    // The reconvert fixed it: content changes and the content clock moves.
    siSeedNodes($member, siCleanNodes());
    siDb()->table('library')->where('book', $member)->update(['timestamp' => 2000]);

    $compare = $this->getJson("{$base}/lint")->assertOk()->json('compare');
    expect($compare['books'])->toBe(1);
    expect($compare['changed'])->toBe(1);
    expect($compare['gone'])->toBe(1);
    expect($compare['new_total'])->toBe(0);

    // A verdict on a book that is not a member of this shelf is refused.
    $this->postJson("{$base}/lint/review", [
        'book' => $sibling, 'detector' => 'fragment_blockquote', 'excerpt' => 'domain names', 'verdict' => 'real',
    ])->assertNotFound();

    $this->deleteJson("{$base}/lint/snapshot")->assertOk();
    expect(siDb()->table('conversion_lint_snapshots')->where('scope_id', $shelf->id)->exists())->toBeFalse();
});

test('a shelf snapshot is refused while its conversions are still queued', function () {
    $this->loginUser(['is_admin' => true]);
    $shelf = siSeedShelf('public');
    $book = siSeedShelvedWork($shelf, [['foundation_source' => 'canonical_pdf_vacuum']])['books']['canonical_pdf_vacuum'];
    siSeedNodes($book, siCleanNodes());

    try {
        siDb()->table('jobs')->insert([siQueuedConversion('default', $book)]);

        $this->postJson('/api/maintainer/shelf-import/' . $shelf->id . '/lint/snapshot')->assertStatus(409);
        expect(siDb()->table('conversion_lint_snapshots')->where('scope_id', $shelf->id)->exists())->toBeFalse();
    } finally {
        siDb()->table('jobs')->where('payload', 'LIKE', '%si-backlog-marker%')->delete();
    }
});

