<?php

/**
 * Single-work import — a DOI / OpenAlex id handed to the web URL importer or MCP
 * `import_document` rides the open-access acquisition ladder (SingleWorkImporter →
 * ImportWorkJob → AutoVersionCreator).
 *
 * AutoVersionCreator, WorkOcrCharger and OaLocationResolver are mocked (no network, no OCR,
 * no billing). The front door's decisions, the job's two legs, the delivery rule (commons if
 * hostable, else a private personal copy) and the real PersonalCopyMaker are the code under test.
 *
 * Seeds via pgsql_admin with beforeEach-only cleanup (an afterEach admin delete deadlocks
 * against the still-open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use App\Jobs\ImportWorkJob;
use App\Jobs\ProcessDocumentImportJob;
use App\Models\User;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\WorkOcrCharger;
use App\Services\SourceImport\Content\OaLocationResolver;
use App\Services\SourceImport\Identifier\Doi;
use App\Services\SourceImport\Metadata\SourceMetadata;
use App\Services\SourceImport\PersonalCopyMaker;
use App\Services\SourceImport\SingleWorkImporter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function swiDb()
{
    return DB::connection('pgsql_admin');
}

function swiCleanup(): void
{
    $db = swiDb();
    $books = $db->table('library')->where('title', 'LIKE', 'SWI %')->pluck('book')->all();
    foreach (array_merge($books, $db->table('work_imports')->where('id', 'LIKE', 'swi-%')->pluck('id')->all()) as $dir) {
        File::deleteDirectory(resource_path("markdown/{$dir}"));
    }
    $db->table('work_imports')->where('id', 'LIKE', 'swi-%')->delete();
    if ($books) {
        $db->table('nodes')->whereIn('book', $books)->delete();
        $db->table('bibliography')->whereIn('book', $books)->delete();
        $db->table('shelf_items')->whereIn('book', $books)->delete();
        $db->table('library')->whereIn('book', $books)->delete();
    }
    $db->table('shelves')->where('creator', 'LIKE', 'swi_%')->delete();
    $db->table('canonical_source')->where('title', 'LIKE', 'SWI %')->delete();
    $db->table('users')->where('name', 'LIKE', 'swi_%')->delete();
}

beforeEach(function () {
    swiCleanup();
    Queue::fake();
});

function swiUser(string $status = 'premium'): User
{
    $id = swiDb()->table('users')->insertGetId([
        'name'              => 'swi_' . Str::lower(Str::random(8)),
        'email'             => 'swi_' . Str::lower(Str::random(10)) . '@swi.local',
        'email_verified_at' => now(),
        'password'          => Hash::make('password'),
        'user_token'        => (string) Str::uuid(),
        'status'            => $status,
        'created_at'        => now(),
        'updated_at'        => now(),
    ]);

    return User::on('pgsql_admin')->findOrFail($id);
}

function swiMetadata(bool $isOa = true): SourceMetadata
{
    $suffix = Str::lower(Str::random(8));
    $doi = '10.5555/swi.' . $suffix;
    $openalexId = 'W9' . random_int(100000000, 999999999);

    // The canonical is committed up front through pgsql_admin: ingestExternal() then finds it
    // by identifier. Left to mint its own, the row would sit inside RefreshDatabase's open
    // default-connection transaction, invisible to the admin connection the job writes on.
    swiDb()->table('canonical_source')->insert([
        'id'          => (string) Str::uuid(),
        'title'       => 'SWI Work ' . $suffix,
        'doi'         => $doi,
        'openalex_id' => $openalexId,
        'is_oa'       => $isOa,
        'created_at'  => now(),
        'updated_at'  => now(),
    ]);

    return new SourceMetadata([
        'title'       => 'SWI Work ' . $suffix,
        'author'      => 'Tester, A.',
        'year'        => 2020,
        'doi'         => $doi,
        'openalex_id' => $openalexId,
        'is_oa'       => $isOa,
        'oa_status'   => $isOa ? 'gold' : 'closed',
        'type'        => 'article',
    ], 'openalex');
}

/** A system version row for a canonical, as SystemVersionMinter would leave it once filled. */
function swiSystemBook(string $canonicalId, string $title, string $visibility = 'public', array $extra = []): string
{
    $book = (string) Str::uuid();
    swiDb()->table('library')->insert($extra + [
        'book'                => $book,
        'title'               => $title,
        'visibility'          => $visibility,
        'listed'              => false,
        'has_nodes'           => true,
        'type'                => 'article',
        'raw_json'            => '[]',
        'timestamp'           => 0,
        'creator'             => AutoVersionResolver::CREATOR,
        'conversion_method'   => 'jats_fulltext',
        'foundation_source'   => AutoVersionResolver::FOUNDATION_SOURCE,
        'canonical_source_id' => $canonicalId,
        'license'             => 'CC-BY-4.0',
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);

    return $book;
}

function swiStart(SourceMetadata $meta, string $id, ?User $user, string $surface = SingleWorkImporter::SURFACE_WEB): array
{
    return app(SingleWorkImporter::class)->start(
        new Doi($meta->doi()),
        $meta,
        $id,
        $user,
        ['creator' => $user?->name, 'creator_token' => null],
        $surface,
    );
}

function swiRunJob(string $id): void
{
    app()->call([new ImportWorkJob($id), 'handle']);
}

function swiRow(string $id): ?object
{
    return swiDb()->table('work_imports')->where('id', $id)->first();
}

function swiProgress(string $id): array
{
    return json_decode(File::get(resource_path("markdown/{$id}/progress.json")), true);
}

function swiCanonicalId(SourceMetadata $meta): string
{
    return swiDb()->table('canonical_source')->where('doi', $meta->doi())->value('id');
}

// ── The front door ───────────────────────────────────────────────────────────

test('an open work is queued on the interactive lane and recorded', function () {
    $user = swiUser();
    $meta = swiMetadata();
    $id = 'swi-' . Str::lower(Str::random(8));

    $result = swiStart($meta, $id, $user);

    expect($result)->toMatchArray(['ok' => true, 'status' => 'queued', 'import' => $id]);
    Queue::assertPushedOn(ProcessDocumentImportJob::QUEUE_INTERACTIVE, ImportWorkJob::class);
    expect(swiRow($id))
        ->user_id->toBe($user->id)
        ->surface->toBe('web')
        ->status->toBe('queued');
    expect(swiProgress($id)['status'])->toBe('queued');
});

test('a work that is already readable is returned without fetching, and shelved', function () {
    $user = swiUser();
    $meta = swiMetadata();
    $book = swiSystemBook(swiCanonicalId($meta), $meta->title());

    $result = swiStart($meta, 'swi-' . Str::lower(Str::random(8)), $user);

    expect($result)->toMatchArray(['ok' => true, 'status' => 'already_available', 'book' => $book, 'outcome' => 'commons']);
    Queue::assertNothingPushed();
    $shelf = swiDb()->table('shelves')->where('creator', $user->name)->where('name', HarvestShelf::IMPORTS_NAME)->first();
    expect($shelf)->not->toBeNull()
        ->and($shelf->visibility)->toBe('private')
        ->and(swiDb()->table('shelf_items')->where('shelf_id', $shelf->id)->where('book', $book)->exists())->toBeTrue();
});

test('a closed work with no open copy anywhere is refused', function () {
    $this->mock(OaLocationResolver::class, fn ($m) => $m->shouldReceive('resolve')->andReturn([]));

    $result = swiStart(swiMetadata(isOa: false), 'swi-' . Str::lower(Str::random(8)), swiUser());

    expect($result)->toMatchArray(['ok' => false, 'error' => 'closed_access_requires_upload']);
    Queue::assertNothingPushed();
});

test('a closed work with a repository copy is NOT refused on OpenAlex\'s word alone', function () {
    $this->mock(OaLocationResolver::class, fn ($m) => $m->shouldReceive('resolve')->andReturn([
        ['url' => 'https://figshare.com/x.pdf', 'kind' => 'pdf', 'host' => 'figshare.com', 'host_class' => 'repository', 'source' => 'unpaywall'],
    ]));

    $result = swiStart(swiMetadata(isOa: false), 'swi-' . Str::lower(Str::random(8)), swiUser());

    expect($result)->toMatchArray(['ok' => true, 'status' => 'queued']);
    Queue::assertPushed(ImportWorkJob::class, 1);
});

test('a second request for the same work joins the in-flight import', function () {
    $user = swiUser();
    $meta = swiMetadata();
    $first = 'swi-' . Str::lower(Str::random(8));
    swiStart($meta, $first, $user);

    $again = swiStart($meta, 'swi-' . Str::lower(Str::random(8)), $user);

    expect($again['import'])->toBe($first);
    Queue::assertPushed(ImportWorkJob::class, 1);
});

// ── The job ──────────────────────────────────────────────────────────────────

test('a hostable copy is delivered as the commons version on the importer\'s shelf', function () {
    $user = swiUser();
    $meta = swiMetadata();
    $id = 'swi-' . Str::lower(Str::random(8));
    swiStart($meta, $id, $user);
    $book = swiSystemBook(swiCanonicalId($meta), $meta->title(), 'public', ['has_nodes' => false]);

    $this->mock(AutoVersionCreator::class, fn ($m) => $m->shouldReceive('create')->once()
        ->andReturn(['status' => 'assigned', 'book' => $book, 'lane' => 'jats_fulltext', 'reason' => null, 'via' => 'from europepmc.org']));
    $this->mock(WorkOcrCharger::class, fn ($m) => $m->shouldReceive('charge')->once()->andReturn(0.0));

    swiRunJob($id);

    expect(swiRow($id))->status->toBe('completed')->book->toBe($book)->outcome->toBe('commons');
    expect(swiProgress($id))->toMatchArray(['status' => 'complete', 'book' => $book, 'outcome' => 'commons']);
    $shelf = swiDb()->table('shelves')->where('creator', $user->name)->where('name', HarvestShelf::IMPORTS_NAME)->first();
    expect(swiDb()->table('shelf_items')->where('shelf_id', $shelf->id)->where('book', $book)->exists())->toBeTrue();
});

test('a held copy is delivered as a private personal copy with its real licence', function () {
    $user = swiUser();
    $meta = swiMetadata();
    $id = 'swi-' . Str::lower(Str::random(8));
    swiStart($meta, $id, $user);
    $canonicalId = swiCanonicalId($meta);
    $held = swiSystemBook($canonicalId, $meta->title(), 'private', [
        'license'     => 'All-Rights-Reserved',
        'held_reason' => 'licence',
    ]);
    // The converted artifacts the ladder left behind. The image path embeds the book id.
    $dir = resource_path("markdown/{$held}");
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/nodes.jsonl", implode("\n", [
        json_encode(['content' => '<h1>SWI held work</h1>', 'plainText' => 'SWI held work', 'type' => 'h1']),
        json_encode(['content' => "<p>Body text <img src=\"/{$held}/media/a.jpg\"></p>", 'plainText' => 'Body text', 'type' => 'p']),
    ]));
    swiDb()->table('bibliography')->insert([
        'book' => $held, 'referenceId' => 'swiref1', 'content' => 'SWI ref', 'created_at' => now(), 'updated_at' => now(),
    ]);

    $this->mock(AutoVersionCreator::class, fn ($m) => $m->shouldReceive('create')->once()
        ->andReturn(['status' => 'assigned_existing', 'book' => $held, 'lane' => 'jats_fulltext', 'reason' => null]));
    $this->mock(WorkOcrCharger::class, fn ($m) => $m->shouldNotReceive('charge'));

    swiRunJob($id);

    $row = swiRow($id);
    expect($row)->status->toBe('completed')->outcome->toBe('personal_copy')->book->toBe($id)->system_book->toBe($held);

    $copy = swiDb()->table('library')->where('book', $id)->first();
    expect($copy)
        ->creator->toBe($user->name)
        ->visibility->toBe('private')
        ->license->toBe('All-Rights-Reserved')
        ->canonical_source_id->toBe($canonicalId)
        ->conversion_method->toBe(PersonalCopyMaker::CONVERSION_METHOD)
        ->and((bool) $copy->has_nodes)->toBeTrue();
    // A personal copy must never be eligible as the canonical's auto version.
    expect(AutoVersionResolver::SYSTEM_CONVERSION_METHODS)->not->toContain(PersonalCopyMaker::CONVERSION_METHOD);

    $nodes = swiDb()->table('nodes')->where('book', $id)->orderBy('startLine')->pluck('content')->all();
    expect($nodes)->toHaveCount(2)
        ->and($nodes[1])->toContain("/{$id}/media/a.jpg")
        ->and($nodes[1])->not->toContain($held);
    expect(swiDb()->table('bibliography')->where('book', $id)->where('referenceId', 'swiref1')->exists())->toBeTrue();
    // The held system copy is untouched.
    expect(swiDb()->table('library')->where('book', $held)->value('visibility'))->toBe('private');
});

test('over MCP a PDF pauses for an OCR estimate, and OCR runs only after confirm', function () {
    $user = swiUser();
    $meta = swiMetadata();
    $id = 'swi-' . Str::lower(Str::random(8));
    swiStart($meta, $id, $user, SingleWorkImporter::SURFACE_MCP);
    $book = swiSystemBook(swiCanonicalId($meta), $meta->title(), 'public', ['has_nodes' => false]);
    File::ensureDirectoryExists(resource_path("markdown/{$book}"));
    File::put(resource_path("markdown/{$book}/original.pdf"), '%PDF-1.4 not really a pdf');

    $deferred = ['status' => 'deferred', 'book' => $book, 'lane' => null, 'reason' => 'stub has no converted content yet'];
    $this->mock(AutoVersionCreator::class, function ($m) use ($deferred, $book) {
        // Leg 1 (skipOcr) twice — once before the pause, once after confirm — and OCR exactly once.
        $m->shouldReceive('create')->with(Mockery::any(), true)->twice()->andReturn($deferred);
        $m->shouldReceive('create')->with(Mockery::any(), false)->once()
            ->andReturn(['status' => 'assigned', 'book' => $book, 'lane' => 'pdf_ocr_auto_raw', 'reason' => null]);
    });
    $this->mock(WorkOcrCharger::class, fn ($m) => $m->shouldReceive('charge')->once()->andReturn(0.12));

    swiRunJob($id);

    $paused = swiRow($id);
    expect($paused)->status->toBe('awaiting_confirmation')->and($paused->confirm_token)->not->toBeNull();
    expect(swiProgress($id))->toMatchArray(['status' => 'awaiting_confirmation', 'confirm_token' => $paused->confirm_token]);

    // Someone else's token, or a made-up one, confirms nothing.
    expect(app(SingleWorkImporter::class)->confirm($paused->confirm_token, swiUser())['ok'])->toBeFalse();

    $confirmed = app(SingleWorkImporter::class)->confirm($paused->confirm_token, $user);
    expect($confirmed)->toMatchArray(['ok' => true, 'import' => $id]);

    swiRunJob($id);

    expect(swiRow($id))->status->toBe('completed')->outcome->toBe('commons');
});

test('on the web a PDF needs a positive balance before OCR', function () {
    $user = swiUser('budget'); // no credits
    $meta = swiMetadata();
    $id = 'swi-' . Str::lower(Str::random(8));
    swiStart($meta, $id, $user);
    $book = swiSystemBook(swiCanonicalId($meta), $meta->title(), 'public', ['has_nodes' => false]);
    File::ensureDirectoryExists(resource_path("markdown/{$book}"));
    File::put(resource_path("markdown/{$book}/original.pdf"), '%PDF-1.4');

    $this->mock(AutoVersionCreator::class, function ($m) use ($book) {
        $m->shouldReceive('create')->with(Mockery::any(), true)->once()
            ->andReturn(['status' => 'deferred', 'book' => $book, 'lane' => null, 'reason' => 'stub has no converted content yet']);
        $m->shouldNotReceive('create')->with(Mockery::any(), false);
    });
    $this->mock(WorkOcrCharger::class, fn ($m) => $m->shouldNotReceive('charge'));

    swiRunJob($id);

    expect(swiRow($id))->status->toBe('failed')->reason->toBe('insufficient_balance');
});

test('a failed fetch keeps its reason and what was tried', function () {
    $user = swiUser();
    $meta = swiMetadata();
    $id = 'swi-' . Str::lower(Str::random(8));
    swiStart($meta, $id, $user);

    $this->mock(AutoVersionCreator::class, fn ($m) => $m->shouldReceive('create')->once()->andReturn([
        'status' => 'fetch_failed', 'book' => null, 'lane' => null,
        'reason' => 'cloudflare_block', 'via' => 'tried 3 OA locations',
    ]));
    $this->mock(WorkOcrCharger::class, fn ($m) => $m->shouldNotReceive('charge'));

    swiRunJob($id);

    expect(swiRow($id))->status->toBe('failed')->reason->toBe('cloudflare_block')->via->toBe('tried 3 OA locations');
    expect(swiProgress($id))->toMatchArray(['status' => 'failed', 'reason' => 'cloudflare_block', 'via' => 'tried 3 OA locations']);
    expect(swiProgress($id)['detail'])->toContain('cloudflare_block')->toContain('tried 3 OA locations');
});

test('a retry after a failure may reuse the same handle', function () {
    $user = swiUser();
    $meta = swiMetadata();
    $id = 'swi-' . Str::lower(Str::random(8));
    swiStart($meta, $id, $user);
    swiDb()->table('work_imports')->where('id', $id)->update(['status' => 'failed']);

    expect(swiStart($meta, $id, $user))->toMatchArray(['ok' => true, 'status' => 'queued', 'import' => $id]);
    // …but nobody else may take it over.
    swiDb()->table('work_imports')->where('id', $id)->update(['status' => 'failed']);
    expect(swiStart(swiMetadata(), $id, swiUser()))->toMatchArray(['ok' => false, 'error' => 'book_id_taken']);
});
