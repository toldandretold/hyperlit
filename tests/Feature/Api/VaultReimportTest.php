<?php

/**
 * Re-importing a vault: a dropped folder's own metadata reaches the library
 * row, and notes that are ALREADY books in Hyperlit are recognised.
 *
 * Invariants pinned here:
 *  - FrontMatter::split reads the exporter's block and returns the body
 *    without it — and leaves a document that merely opens with `---` alone.
 *  - POST /api/import-batches/resolve matches by book id, by a Hyperlit URL
 *    (slug matches must also agree on the title; other hosts mean nothing) and
 *    by DOI — but ONLY books the caller can read. A stranger's private book, a
 *    deleted book and an unknown id all come back `new`, indistinguishably.
 *  - POST /api/import-batches with existing_books shelves the readable ones
 *    (silently dropping forged ids), registers NO batch when there is nothing
 *    to upload, and a second drop onto the same shelf adds no duplicates.
 *  - POST /import-file stores the vault's doi/licence, and with version_of
 *    inherits the original's citation details and canonical link
 *    (`vault_reimport`) — unless the caller cannot read the original.
 *  - ProcessDocumentImportJob::updateLibraryMetadata fills blanks from front
 *    matter with NO RLS session vars set (the queue-worker context it runs in).
 *
 * Admin-connection fixtures commit outside the test transaction, so cleanup
 * runs in beforeEach (see ImportBatchTest for why not afterEach).
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Services\DocumentImport\FrontMatter;
use App\Services\DocumentImport\MetadataExtractor;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class);

function vaultReimportCleanup(): void
{
    $admin = DB::connection('pgsql_admin');
    $shelfIds = $admin->table('shelves')->where('name', 'like', 'vaulttest%')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        $admin->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        $admin->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    $testUsers = $admin->table('users')->where('email', 'like', 'vault\_%@test.local')->pluck('name');
    $importShelves = $admin->table('shelves')->whereIn('creator', $testUsers)->pluck('id');
    if ($importShelves->isNotEmpty()) {
        $admin->table('shelf_items')->whereIn('shelf_id', $importShelves)->delete();
        $admin->table('shelves')->whereIn('id', $importShelves)->delete();
    }
    $admin->table('library')->where('book', 'like', 'vaulttest\_%')->delete();
    $admin->table('canonical_source')->where('title', 'like', 'vaulttest %')->delete();
    $admin->table('users')->where('email', 'like', 'vault\_%@test.local')->delete();

    foreach (glob(resource_path('markdown/vaulttest_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
}

beforeEach(function () {
    vaultReimportCleanup();
    config(['app.url' => 'https://hyperlit.test', 'import.vault_hosts' => ['hyperlit.io']]);
});

afterEach(function () {
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");
    foreach (glob(resource_path('markdown/vaulttest_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
});

/** A readable-shaped library row (has content) seeded past RLS; cleaned by the vaulttest_ prefix. */
function vaultBook(array $attrs = []): string
{
    $book = $attrs['book'] ?? 'vaulttest_' . Str::lower(Str::random(10));

    DB::connection('pgsql_admin')->table('library')->updateOrInsert(['book' => $book], array_merge([
        'title' => 'Abolition as Method',
        'visibility' => 'public',
        'has_nodes' => true,
        'type' => 'book',
        'raw_json' => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $attrs, ['book' => $book]));

    return $book;
}

function vaultShelf(string $creator): string
{
    $id = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('shelves')->insert([
        'id' => $id, 'creator' => $creator, 'name' => 'vaulttest ' . Str::random(5),
        'slug' => 'vaulttest-' . Str::lower(Str::random(5)), 'visibility' => 'private',
        'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
    ]);

    return $id;
}

/* ----------------  front matter  ---------------- */

test('front matter is split from the body, lists and quoted values included', function () {
    $note = "---\ntitle: \"He said \\\"no\\\"\"\nauthors:\n  - \"Paul Langley\"\n  - \"Andrew Leyshon\"\nyear: \"2017\"\ntags: [a, \"b c\"]\nhyperlit: \"https://hyperlit.io/some-slug\"\n---\n\n# Heading\n\nBody.";
    $fm = FrontMatter::split($note);

    expect($fm['hasBlock'])->toBeTrue()
        ->and($fm['fields']['title'])->toBe('He said "no"')
        ->and($fm['fields']['authors'])->toBe(['Paul Langley', 'Andrew Leyshon'])
        ->and($fm['fields']['tags'])->toBe(['a', 'b c'])
        ->and($fm['body'])->toBe("# Heading\n\nBody.");
});

test('a document that only OPENS with a horizontal rule keeps every word', function () {
    $prose = "---\nThis is the opening paragraph of an essay, not metadata.\n\n---\n\nSecond section.";

    expect(FrontMatter::split($prose))->toMatchArray(['hasBlock' => false, 'body' => $prose]);
    expect(FrontMatter::split("---\ntitle: x\nnever closes")['hasBlock'])->toBeFalse();
    expect(FrontMatter::split("# No block\n\ntext")['hasBlock'])->toBeFalse();
});

test('the metadata extractor reads an authors LIST and the publisher', function () {
    $dir = resource_path('markdown/vaulttest_extract');
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/original.md", "---\ntitle: \"Abolition as Method\"\nauthors:\n  - \"Kay Gabriel\"\n  - \"Second Author\"\nyear: \"2022\"\npublisher: \"Dissent Magazine\"\n---\n\n# A different heading\n");

    expect(app(MetadataExtractor::class)->extract("{$dir}/original.md", 'md'))->toMatchArray([
        'title' => 'Abolition as Method',
        'author' => 'Kay Gabriel; Second Author',
        'year' => '2022',
        'publisher' => 'Dissent Magazine',
    ]);
});

/* ----------------  resolve  ---------------- */

test('resolve finds a readable book by id, by Hyperlit URL slug, and by DOI', function () {
    $user = $this->seedUser(['email' => 'vault_resolve@test.local']);
    $this->actingAs($user);

    $byId = vaultBook(['title' => 'Platform capitalism']);
    $slug = 'vaulttest-' . Str::lower(Str::random(8));
    $bySlug = vaultBook(['slug' => $slug, 'title' => 'Abolition as Method']);
    $byDoi = vaultBook(['doi' => '10.9999/vaulttest.' . Str::lower(Str::random(6)), 'title' => 'A DOI work']);
    $doi = DB::connection('pgsql_admin')->table('library')->where('book', $byDoi)->value('doi');

    $results = collect($this->postJson('/api/import-batches/resolve', ['items' => [
        ['key' => 'id', 'book' => $byId, 'title' => 'anything'],
        // The filename-shaped title a vault note has before its front matter is read.
        ['key' => 'slug', 'hyperlit_url' => "https://hyperlit.io/{$slug}", 'title' => 'Kay Gabriel - Abolition as Method'],
        ['key' => 'doi', 'doi' => 'https://doi.org/' . strtoupper($doi), 'title' => 'x'],
    ]])->assertOk()->json('results'))->keyBy('key');

    expect($results['id'])->toMatchArray(['status' => 'existing', 'book' => $byId, 'matched_by' => 'hyperlit'])
        ->and($results['slug'])->toMatchArray(['status' => 'existing', 'book' => $bySlug, 'slug' => $slug])
        ->and($results['doi'])->toMatchArray(['status' => 'existing', 'book' => $byDoi, 'matched_by' => 'doi']);
});

test('resolve reports unreadable, deleted, unknown and wrong-host books all as new', function () {
    $owner = $this->seedUser(['email' => 'vault_owner@test.local']);
    $stranger = $this->seedUser(['email' => 'vault_stranger@test.local']);

    $private = vaultBook(['visibility' => 'private', 'creator' => $owner->name]);
    $deleted = vaultBook(['visibility' => 'deleted']);
    $empty = vaultBook(['has_nodes' => false]);
    $slug = 'vaulttest-' . Str::lower(Str::random(8));
    vaultBook(['slug' => $slug, 'title' => 'Abolition as Method']);
    $public = vaultBook();

    $items = [
        ['key' => 'private', 'book' => $private, 'title' => 'x'],
        ['key' => 'deleted', 'book' => $deleted, 'title' => 'x'],
        ['key' => 'empty', 'book' => $empty, 'title' => 'x'],
        ['key' => 'unknown', 'book' => 'vaulttest_does_not_exist', 'title' => 'x'],
        // A slug that now names a DIFFERENT work must not match on the name alone.
        ['key' => 'reused-slug', 'hyperlit_url' => "https://hyperlit.io/{$slug}", 'title' => 'An entirely unrelated essay'],
        // Another site's URL says nothing about this library, whatever its path.
        ['key' => 'other-host', 'hyperlit_url' => "https://example.org/{$public}", 'title' => 'Abolition as Method'],
        // /a/{archive} is a page, not a book.
        ['key' => 'archive-page', 'hyperlit_url' => "https://hyperlit.io/a/{$public}", 'title' => 'Abolition as Method'],
    ];

    $this->actingAs($stranger);
    $statuses = collect($this->postJson('/api/import-batches/resolve', ['items' => $items])->assertOk()->json('results'))
        ->pluck('status', 'key')->all();
    expect(array_unique(array_values($statuses)))->toBe(['new']);

    // The OWNER can resolve their own private book.
    $this->actingAs($owner);
    $own = $this->postJson('/api/import-batches/resolve', ['items' => [['key' => 'private', 'book' => $private, 'title' => 'x']]])
        ->assertOk()->json('results.0');
    expect($own)->toMatchArray(['status' => 'existing', 'book' => $private]);
});

/* ----------------  shelving existing books  ---------------- */

test('existing_books go straight onto the shelf, forged ids are dropped, and no batch is registered', function () {
    $user = $this->seedUser(['email' => 'vault_shelve@test.local']);
    $other = $this->seedUser(['email' => 'vault_other@test.local']);
    $this->actingAs($user);

    $a = vaultBook();
    $b = vaultBook();
    $foreignPrivate = vaultBook(['visibility' => 'private', 'creator' => $other->name]);
    $shelfId = vaultShelf($user->name);

    $resp = $this->postJson('/api/import-batches', [
        'label' => 'vaulttest drop', 'source' => 'vault', 'shelf_id' => $shelfId,
        'items' => [],
        'existing_books' => [$a, $b, $foreignPrivate, 'vaulttest_never_existed'],
    ])->assertStatus(201);

    expect($resp->json('id'))->toBeNull()
        ->and($resp->json('existing_added'))->toBe(2)
        ->and($resp->json('shelf_url'))->toBeString();

    $onShelf = fn () => DB::table('shelf_items')->where('shelf_id', $shelfId)->pluck('book')->sort()->values()->all();
    expect($onShelf())->toBe(collect([$a, $b])->sort()->values()->all());
    expect(DB::table('import_batches')->where('label', 'vaulttest drop')->count())->toBe(0);

    // Two exported shelves merged into one folder / the same folder dropped
    // twice: one shelf, each original book on it once.
    $c = vaultBook();
    $this->postJson('/api/import-batches', [
        'label' => 'vaulttest drop', 'source' => 'vault', 'shelf_id' => $shelfId,
        'items' => [], 'existing_books' => [$a, $c],
    ])->assertStatus(201);
    expect($onShelf())->toBe(collect([$a, $b, $c])->sort()->values()->all());
});

test('existing books and uploads share one auto-shelf', function () {
    $user = $this->seedUser(['email' => 'vault_mixed@test.local']);
    $this->actingAs($user);
    $existing = vaultBook();

    $resp = $this->postJson('/api/import-batches', [
        'label' => 'vaulttest mixed ' . Str::random(4), 'source' => 'vault', 'auto_shelf' => true,
        'items' => [['book' => 'vaulttest_' . Str::lower(Str::random(8)), 'title' => 'New note', 'filename' => 'n.md']],
        'existing_books' => [$existing],
    ])->assertStatus(201);

    expect($resp->json('id'))->toBeString()->and($resp->json('existing_added'))->toBe(1);
    expect(DB::table('shelf_items')->where('shelf_id', $resp->json('shelf.id'))->pluck('book')->all())->toBe([$existing]);
});

test('a single existing book is filed on the caller\'s own "Imported works" shelf', function () {
    $user = $this->seedUser(['email' => 'vault_imports@test.local']);
    $this->actingAs($user);
    $book = vaultBook();

    $post = fn () => $this->postJson('/api/import-batches', [
        'label' => 'vaulttest single', 'source' => 'files', 'imports_shelf' => true,
        'items' => [], 'existing_books' => [$book],
    ])->assertStatus(201);

    $first = $post();
    expect($first->json('id'))->toBeNull()
        ->and($first->json('existing_added'))->toBe(1)
        ->and($first->json('shelf.name'))->toBe(\App\Services\SourceHarvest\HarvestShelf::IMPORTS_NAME);

    $shelf = DB::connection('pgsql_admin')->table('shelves')->where('id', $first->json('shelf.id'))->first();
    expect($shelf->creator)->toBe($user->name)->and($shelf->visibility)->toBe('private');

    // Uploading the same file again reuses the shelf and adds nothing twice.
    expect($post()->json('shelf.id'))->toBe($shelf->id);
    // Default connection: the append ran under the caller's own RLS context.
    expect(DB::table('shelf_items')->where('shelf_id', $shelf->id)->pluck('book')->all())->toBe([$book]);
});

test('a batch with neither items nor existing books is still refused', function () {
    $this->actingAs($this->seedUser(['email' => 'vault_empty@test.local']));

    $this->postJson('/api/import-batches', ['label' => 'vaulttest none', 'source' => 'vault', 'items' => []])
        ->assertStatus(422);
});

/* ----------------  /import-file metadata + own versions  ---------------- */

test('import-file stores the vault’s doi and licence, and an unrecognised licence stays Unknown', function () {
    Queue::fake();
    $this->actingAs($this->seedUser(['email' => 'vault_meta@test.local']));

    $book = 'vaulttest_' . Str::lower(Str::random(10));
    $lib = $this->post('/import-file', [
        'book' => $book, 'title' => 'Platform capitalism', 'author' => 'Paul Langley; Andrew Leyshon', 'year' => '2017',
        'doi' => 'https://doi.org/10.2218/finsoc.v3i1.1936', 'license' => 'CC-BY-NC-ND-4.0',
        'markdown_file' => [UploadedFile::fake()->createWithContent('n.md', "# Hello\n\nBody.")],
    ], ['Accept' => 'application/json'])->assertStatus(200)->json('library');

    expect($lib['doi'])->toBe('10.2218/finsoc.v3i1.1936')
        ->and($lib['license'])->toBe('CC-BY-NC-ND-4.0')
        ->and($lib['visibility'])->toBe('private');

    $other = 'vaulttest_' . Str::lower(Str::random(10));
    $lib = $this->post('/import-file', [
        'book' => $other, 'title' => 'Mystery', 'license' => 'Totally Made Up 9.0',
        'markdown_file' => [UploadedFile::fake()->createWithContent('n.md', "# Hello\n\nBody.")],
    ], ['Accept' => 'application/json'])->assertStatus(200)->json('library');

    expect($lib['license'])->toBe(\App\Support\Licenses::UNKNOWN);
});

/** The form data the queued import job was handed for $book (it is what the worker acts on). */
function vaultQueuedFormData(string $book): array
{
    $found = null;
    Queue::assertPushed(\App\Jobs\ProcessDocumentImportJob::class, function ($job) use ($book, &$found) {
        $read = fn (string $prop) => (new ReflectionProperty($job, $prop))->getValue($job);
        if ($read('bookId') !== $book) {
            return false;
        }
        $found = $read('formData');

        return true;
    });

    return (array) $found;
}

test('version_of inherits the original’s citation details and canonical work', function () {
    Queue::fake();
    $user = $this->seedUser(['email' => 'vault_version@test.local']);
    $this->actingAs($user);

    $canonicalId = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('canonical_source')->insert([
        'id' => $canonicalId, 'title' => 'vaulttest ' . Str::random(6), 'created_at' => now(), 'updated_at' => now(),
    ]);
    $original = vaultBook([
        'title' => 'Platform capitalism', 'author' => 'Paul Langley; Andrew Leyshon', 'year' => '2017',
        'journal' => 'Finance and Society', 'doi' => '10.2218/vaulttest.1', 'license' => 'CC-BY-NC-ND-4.0',
        'canonical_source_id' => $canonicalId,
    ]);

    $book = 'vaulttest_' . Str::lower(Str::random(10));
    $lib = $this->post('/import-file', [
        'book' => $book, 'title' => 'Platform capitalism', 'version_of' => $original,
        // The vault says a different year: what the upload supplies wins.
        'year' => '2018',
        'markdown_file' => [UploadedFile::fake()->createWithContent('n.md', "# Hello\n\nBody.")],
    ], ['Accept' => 'application/json'])->assertStatus(200)->json('library');

    expect($lib['author'])->toBe('Paul Langley; Andrew Leyshon')
        ->and((string) $lib['year'])->toBe('2018')
        ->and($lib['journal'])->toBe('Finance and Society')
        ->and($lib['doi'])->toBe('10.2218/vaulttest.1')
        ->and($lib['license'])->toBe('CC-BY-NC-ND-4.0')
        ->and($lib['creator'])->toBe($user->name)
        ->and($lib['visibility'])->toBe('private')
        ->and($lib['canonical_source_id'])->toBe($canonicalId)
        ->and($lib['canonical_match_method'])->toBe('vault_reimport');

    // The worker is told whose reference matches the copy inherits (VaultRoundTripTest
    // covers the inheriting itself).
    expect(vaultQueuedFormData($book)['inherit_citations_from'] ?? null)->toBe($original);
});

test('version_of naming a book the caller cannot read is ignored', function () {
    Queue::fake();
    $owner = $this->seedUser(['email' => 'vault_vowner@test.local']);
    $this->actingAs($this->seedUser(['email' => 'vault_vstranger@test.local']));

    $private = vaultBook([
        'visibility' => 'private', 'creator' => $owner->name, 'author' => 'Secret Author', 'doi' => '10.2218/vaulttest.secret',
    ]);

    $book = 'vaulttest_' . Str::lower(Str::random(10));
    $lib = $this->post('/import-file', [
        'book' => $book, 'title' => 'Mine', 'version_of' => $private,
        'markdown_file' => [UploadedFile::fake()->createWithContent('n.md', "# Hello\n\nBody.")],
    ], ['Accept' => 'application/json'])->assertStatus(200)->json('library');

    expect($lib['author'] ?? null)->toBeNull()
        ->and($lib['doi'] ?? null)->toBeNull()
        ->and($lib['canonical_source_id'] ?? null)->toBeNull();

    // Nor may the worker be pointed at it: it reads on the admin connection, past RLS.
    expect(vaultQueuedFormData($book))->not->toHaveKey('inherit_citations_from');
});

/* ----------------  the worker-context metadata fill  ---------------- */

test('the import job fills blank metadata from front matter with no RLS context (queue worker)', function () {
    $user = $this->seedUser(['email' => 'vault_worker@test.local']);
    $book = 'vaulttest_' . Str::lower(Str::random(10));
    // A PRIVATE row — what every import is born as, and what a var-less
    // default connection cannot see.
    $this->seedLibrary(['book' => $book, 'title' => 'Untitled', 'visibility' => 'private', 'creator' => $user->name]);

    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/original.md", "---\ntitle: \"Abolition as Method\"\nauthors:\n  - \"Kay Gabriel\"\nyear: \"2022\"\npublisher: \"Dissent Magazine\"\n---\n\n# Abolition as Method\n\nBody.");

    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");

    $job = new ProcessDocumentImportJob($book, 'md', $user->id, [], ['creator' => $user->name, 'creator_token' => null, 'valid' => true]);
    $fill = new ReflectionMethod($job, 'updateLibraryMetadata');
    $fill->setAccessible(true);
    $fill->invoke($job, $dir, app(MetadataExtractor::class));

    $row = DB::connection('pgsql_admin')->table('library')->where('book', $book)->first(['title', 'author', 'year', 'publisher']);
    expect($row->title)->toBe('Abolition as Method')
        ->and($row->author)->toBe('Kay Gabriel')
        ->and($row->year)->toBe('2022')
        ->and($row->publisher)->toBe('Dissent Magazine');
});

/* ----------------  the converter never sees the front matter  ---------------- */

test('a converted note carries no front matter in its body, and the original file keeps it', function () {
    $book = 'vaulttest_' . Str::lower(Str::random(10));
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    $note = "---\ntitle: \"Abolition as Method\"\ncitekey: \"gabriel2022abolition\"\nauthors:\n  - \"Kay Gabriel\"\nhyperlit: \"https://hyperlit.io/abolition-as-method-gabriel-2022\"\n---\n\n# Abolition as Method\n\nRuth Wilson Gilmore’s Abolition Geography is written to be used.\n\n---\n\nA second section after a real horizontal rule.\n";
    File::put("{$dir}/original.md", $note);

    app(\App\Services\DocumentImport\Processors\MarkdownProcessor::class)->process("{$dir}/original.md", $dir, $book);

    $nodes = File::get("{$dir}/nodes.jsonl");
    expect($nodes)->toContain('written to be used')
        ->toContain('A second section after a real horizontal rule')
        ->not->toContain('citekey')
        ->not->toContain('gabriel2022abolition')
        ->not->toContain('hyperlit.io/abolition-as-method');
    // The first node is the heading, not an <hr> left behind by the block.
    expect(json_decode(strtok($nodes, "\n"), true)['content'] ?? '')->toContain('Abolition as Method');

    // Untouched on disk: MetadataExtractor and a later reconvert both re-read it.
    expect(File::get("{$dir}/original.md"))->toBe($note)
        ->and(File::exists("{$dir}/conversion_input.md"))->toBeFalse();
});

test('a note with an inline raster image passes validation; other data: links are still refused', function () {
    $validator = app(\App\Services\DocumentImport\ValidationService::class);
    $file = fn (string $body) => \Illuminate\Http\UploadedFile::fake()->createWithContent('note.md', $body);

    // What the vault export writes for an embedded image (a publisher logo, here).
    expect($validator->validateMarkdownFile($file("# T\n\n[![Logo](data:image/png;base64,iVBORw0KGgo=)](https://example.org)\n")))->toBeTrue();
    expect($validator->validateMarkdownFile($file("![x](data:image/jpeg;base64,/9j/4AAQ)\n")))->toBeTrue();

    expect($validator->validateMarkdownFile($file("[x](data:text/html;base64,PHNjcmlwdD4=)\n")))->toBeFalse();
    expect($validator->validateMarkdownFile($file("![x](data:image/svg+xml;base64,PHN2Zz4=)\n")))->toBeFalse();
    expect($validator->validateMarkdownFile($file("![x](data:image/png,raw)\n")))->toBeFalse();
});
