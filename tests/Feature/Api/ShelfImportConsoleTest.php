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
    siDb()->table('journal_import_runs')->whereIn(
        'shelf_id',
        siDb()->table('shelves')->where('name', 'LIKE', 'SI %')->orWhere('name', 'LIKE', 'Cited by: SI %')->pluck('id')
    )->delete();
    siDb()->table('shelf_items')->whereIn(
        'shelf_id',
        siDb()->table('shelves')
            ->where(fn ($q) => $q->where('name', 'LIKE', 'SI %')->orWhere('name', 'LIKE', 'Cited by: SI %'))
            ->pluck('id')
    )->delete();
    siDb()->table('shelves')
        ->where(fn ($q) => $q->where('name', 'LIKE', 'SI %')->orWhere('name', 'LIKE', 'Cited by: SI %'))
        ->delete();
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

    // A canonical-less shelf item is excluded from articles, surfaced in unlinked_count.
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
    expect($body['articles'])->toHaveCount(2);

    $article = collect($body['articles'])->firstWhere('canonical_id', $work['canonical_id']);
    $lanes = collect($article['lanes']);
    expect($lanes)->toHaveCount(2);
    expect($lanes->pluck('lane')->sort()->values()->all())->toBe(['html', 'pdf']);
    expect($lanes->firstWhere('lane', 'pdf')['is_version'])->toBeTrue();
    expect($lanes->firstWhere('lane', 'html')['is_version'])->toBeFalse();

    $deletedArticle = collect($body['articles'])->firstWhere('canonical_id', $deleted['canonical_id']);
    expect(collect($deletedArticle['lanes'])->pluck('lane'))->not->toContain('html');
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
