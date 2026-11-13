<?php

/**
 * Archive export artifacts — the build/status/download loop behind the
 * #archiveRef panel. Contract:
 *   - POST build (sync queue in tests) produces the artifact; status flips to
 *     ready; GET /exports/... serves it;
 *   - visitor artifact contains PUBLIC books only; the owner's artifact
 *     additionally contains private books AND lives at a different path the
 *     visitor download route never serves;
 *   - E2EE books are skipped and named in the vault README / sqlite manifest;
 *   - the SQLite file mirrors library/nodes/hyperlights/hypercites minus
 *     secret columns (creator_token, wrapped_dek, raw embedding), and carries
 *     embeddings as packed float32 BLOBs;
 *   - a second build for an unchanged corpus short-circuits on the digest.
 */

use App\Jobs\BuildArchiveExportJob;
use App\Models\User;
use App\Services\Export\ArchiveCorpusResolver;
use App\Services\Export\ArchiveExportStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

function aexDb()
{
    return DB::connection('pgsql_admin');
}

function aexCleanup(): void
{
    aexDb()->table('nodes')->where('book', 'LIKE', 'aexbook_%')->delete();
    aexDb()->table('hyperlights')->where('book', 'LIKE', 'aexbook_%')->delete();
    aexDb()->table('library')->whereRaw("creator IN (SELECT name FROM users WHERE email LIKE '%@aextest.test')")->delete();
    aexDb()->table('users')->where('email', 'LIKE', '%@aextest.test')->delete();
}

beforeEach(function () {
    aexCleanup();
    // Scoped to this suite's own seeded users — the tests share storage_path
    // with the dev machine, and deleting the whole archive-exports directory
    // nukes REAL cached artifacts (it did).
    foreach (glob(storage_path('app/archive-exports/user-aex_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
});

function aexUser(): User
{
    $unique = 'aex_' . Str::random(8);
    $id = aexDb()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@aextest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'budget',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return User::on('pgsql_admin')->find($id);
}

function aexBook(User $user, string $suffix, string $visibility, array $extra = []): string
{
    $book = 'aexbook_' . $suffix . '_' . Str::random(6);
    aexDb()->table('library')->insert(array_merge([
        'book'       => $book,
        'title'      => 'Aex ' . ucfirst($suffix) . ' Title',
        'author'     => 'Aex Author',
        'creator'    => $user->name,
        'visibility' => $visibility,
        'listed'     => false,
        'type'       => 'book',
        'raw_json'   => '[]',
        'timestamp'  => (int) round(microtime(true) * 1000),
        'created_at' => now(),
        'updated_at' => now(),
    ], $extra));
    aexDb()->table('nodes')->insert([
        'book'       => $book,
        'node_id'    => $book . '_n1',
        'chunk_id'   => 0,
        'startLine'  => 100,
        'content'    => '<p>Body of the ' . $suffix . ' book.</p>',
        'plainText'  => 'Body of the ' . $suffix . ' book.',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    return $book;
}

function aexZipNames(string $path): array
{
    $zip = new ZipArchive();
    expect($zip->open($path))->toBeTrue();
    $names = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $names[] = $zip->getNameIndex($i);
    }
    $zip->close();

    return $names;
}

test('markdown vault: build → status ready → download; visitor gets public books only', function () {
    $owner = aexUser();
    aexBook($owner, 'pub', 'public');
    aexBook($owner, 'priv', 'private');
    $scope = 'user/' . rawurlencode($owner->name);

    $this->postJson("/api/archive-export/{$scope}/build", ['kind' => 'markdown'])
        ->assertStatus(202);

    $this->getJson("/api/archive-export/{$scope}/status?kind=markdown")
        ->assertOk()
        ->assertJsonPath('state', 'ready');

    $res = $this->get("/exports/{$scope}/markdown");
    $res->assertOk();
    $path = $res->baseResponse->getFile()->getPathname();

    $names = aexZipNames($path);
    $joined = implode("\n", $names);
    expect($joined)->toContain('README.md')
        ->toContain('Aex Pub Title')
        ->not->toContain('Aex Priv Title');
});

test('owner artifact includes private books at a distinct path the visitor route never serves', function () {
    $owner = aexUser();
    aexBook($owner, 'pub', 'public');
    aexBook($owner, 'priv', 'private');
    $scope = 'user/' . rawurlencode($owner->name);

    // Owner build: private book included.
    $this->actingAs($owner)->postJson("/api/archive-export/{$scope}/build", ['kind' => 'markdown'])
        ->assertStatus(202);
    $ownerRes = $this->actingAs($owner)->get("/exports/{$scope}/markdown");
    $ownerRes->assertOk();
    $ownerPath = $ownerRes->baseResponse->getFile()->getPathname();
    expect(implode("\n", aexZipNames($ownerPath)))->toContain('Aex Priv Title');
    expect($ownerPath)->toContain('/owner/');

    // A visitor asking the SAME url gets 404 (no public artifact built) —
    // never the owner file. actingAs pins the user on the resolved guards for
    // the rest of the test, so drop them to become a guest again.
    auth('web')->logout();
    $this->app['auth']->forgetGuards();
    $this->flushSession();
    $this->get("/exports/{$scope}/markdown")->assertNotFound();
});

test('E2EE books are skipped and named in the vault README', function () {
    $owner = aexUser();
    aexBook($owner, 'plain', 'public');
    aexBook($owner, 'secret', 'private', ['encrypted' => true]);
    $scope = 'user/' . rawurlencode($owner->name);

    $this->actingAs($owner)->postJson("/api/archive-export/{$scope}/build", ['kind' => 'markdown'])->assertStatus(202);
    $res = $this->actingAs($owner)->get("/exports/{$scope}/markdown");
    $res->assertOk();
    $path = $res->baseResponse->getFile()->getPathname();

    $names = aexZipNames($path);
    expect(implode("\n", $names))->not->toContain('Aex Secret Title');

    $zip = new ZipArchive();
    $zip->open($path);
    $readme = collect($names)->first(fn ($n) => str_ends_with($n, 'README.md'));
    $content = $zip->getFromName($readme);
    $zip->close();
    expect($content)->toContain('Aex Secret Title')
        ->toContain('end-to-end encrypted');
});

test('sqlite export: mirrored tables minus secrets, float32 BLOB embeddings, manifest', function () {
    $owner = aexUser();
    $book = aexBook($owner, 'pub', 'public');
    aexDb()->table('hyperlights')->insert([
        'book'            => $book,
        'hyperlight_id'   => 'hl_1',
        'highlightedText' => 'Body of the',
        'raw_json'        => '{}',
        'creator'         => $owner->name,
        'creator_token'   => (string) Str::uuid(),
        'created_at'      => now(),
        'updated_at'      => now(),
    ]);
    $vector = '[' . implode(',', array_fill(0, 768, 0.5)) . ']';
    aexDb()->statement('UPDATE nodes SET embedding = ?::vector WHERE book = ?', [$vector, $book]);

    $scope = 'user/' . rawurlencode($owner->name);
    $this->postJson("/api/archive-export/{$scope}/build", ['kind' => 'sqlite'])->assertStatus(202);
    $res = $this->get("/exports/{$scope}/sqlite");
    $res->assertOk();
    $path = $res->baseResponse->getFile()->getPathname();

    $pdo = new PDO('sqlite:' . $path);
    $tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(PDO::FETCH_COLUMN);
    expect($tables)->toContain('library', 'nodes', 'hyperlights', 'hypercites', 'embeddings', 'manifest');

    $libCols = array_column($pdo->query('PRAGMA table_info(library)')->fetchAll(PDO::FETCH_ASSOC), 'name');
    expect($libCols)->not->toContain('creator_token')->not->toContain('wrapped_dek');
    $nodeCols = array_column($pdo->query('PRAGMA table_info(nodes)')->fetchAll(PDO::FETCH_ASSOC), 'name');
    expect($nodeCols)->not->toContain('embedding');
    $hlCols = array_column($pdo->query('PRAGMA table_info(hyperlights)')->fetchAll(PDO::FETCH_ASSOC), 'name');
    expect($hlCols)->not->toContain('creator_token');

    $emb = $pdo->query('SELECT dim, embedding FROM embeddings LIMIT 1')->fetch(PDO::FETCH_ASSOC);
    expect($emb)->not->toBeFalse();
    expect((int) $emb['dim'])->toBe(768);
    expect(strlen($emb['embedding']))->toBe(768 * 4);
    $floats = unpack('g768', $emb['embedding']);
    expect(round($floats[1], 3))->toEqualWithDelta(0.5, 0.001);

    $manifest = [];
    foreach ($pdo->query('SELECT key, value FROM manifest') as $row) {
        $manifest[$row['key']] = $row['value'];
    }
    expect($manifest['audience'])->toBe('public');
    expect($manifest['embedding_dim'])->toBe('768');
});

test('a second build for an unchanged corpus short-circuits on the digest', function () {
    $owner = aexUser();
    aexBook($owner, 'pub', 'public');
    $scope = 'user/' . rawurlencode($owner->name);

    $this->postJson("/api/archive-export/{$scope}/build", ['kind' => 'markdown'])->assertStatus(202);

    $resolver = app(ArchiveCorpusResolver::class);
    $store = app(ArchiveExportStore::class);
    $corpus = $resolver->resolve('user', $owner->name, false);
    $digest = $store->digest($corpus, 'public', 'markdown');
    $path = $store->artifactPath('user', $owner->name, 'public', 'markdown', $digest);
    expect(is_file($path))->toBeTrue();
    $mtime = filemtime($path);

    sleep(1);
    // Re-press: with the artifact present the endpoint answers ready without
    // dispatching, and even a direct job run short-circuits.
    $this->postJson("/api/archive-export/{$scope}/build", ['kind' => 'markdown'])
        ->assertOk()
        ->assertJsonPath('state', 'ready');
    (new BuildArchiveExportJob('user', $owner->name, 'public', 'markdown'))
        ->handle($resolver, $store);
    clearstatcache();
    expect(filemtime($path))->toBe($mtime);
});

test('empty corpus is unavailable, build 422s', function () {
    $owner = aexUser(); // no books
    $scope = 'user/' . rawurlencode($owner->name);

    $this->getJson("/api/archive-export/{$scope}/status?kind=markdown")
        ->assertOk()->assertJsonPath('state', 'unavailable');
    $this->postJson("/api/archive-export/{$scope}/build", ['kind' => 'sqlite'])->assertStatus(422);
    $this->postJson("/api/archive-export/{$scope}/build", ['kind' => 'nonsense'])->assertStatus(422);
});

test('vault notes open with citation front matter and a link back to hyperlit', function () {
    $owner = aexUser();
    $book = aexBook($owner, 'meta', 'public', [
        'title'   => 'Aex "Quoted" Title',
        'author'  => 'Ann Author; Bob Writer',
        'year'    => '2020',
        'journal' => 'Aex Journal',
        'volume'  => '18',
        'doi'     => '10.1234/aex.1',
        'license' => 'CC-BY-NC-ND',
    ]);
    aexBook($owner, 'bare', 'public', ['author' => null, 'license' => 'Unknown']);
    $scope = 'user/' . rawurlencode($owner->name);

    $this->postJson("/api/archive-export/{$scope}/build", ['kind' => 'markdown'])->assertStatus(202);
    $path = $this->get("/exports/{$scope}/markdown")->assertOk()->baseResponse->getFile()->getPathname();

    $zip = new ZipArchive();
    expect($zip->open($path))->toBeTrue();
    $notes = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $notes[$zip->getNameIndex($i)] = $zip->getFromIndex($i);
    }
    $zip->close();

    $meta = collect($notes)->first(fn ($body, $name) => str_contains($name, 'Quoted'));
    expect($meta)->toStartWith("---\n")
        ->toContain('title: "Aex \"Quoted\" Title"')
        ->toContain("authors:\n  - \"Ann Author\"\n  - \"Bob Writer\"")
        ->toContain('year: "2020"')
        ->toContain('journal: "Aex Journal"')
        ->toContain('doi: "10.1234/aex.1"')
        ->toContain('source: "https://doi.org/10.1234/aex.1"')
        ->toContain('license: "CC-BY-NC-ND"')
        ->toContain('hyperlit: "' . url('/' . $book) . '"')
        ->toContain('archive: "')
        ->toContain("---\n\nBody of the meta book.");

    // Only what the row has: no empty keys, and "Unknown" is not a licence to assert.
    $bare = collect($notes)->first(fn ($body, $name) => str_contains($name, 'Aex Bare Title'));
    expect($bare)->toStartWith("---\n")
        ->not->toContain('authors:')
        ->not->toContain('license:')
        ->not->toContain('doi:');
});

test('the vault README follows the archive page: the pinned book is the README only when it is the about text', function () {
    $owner = aexUser();
    $reading = aexBook($owner, 'reading', 'public', ['slug' => 'aex-reading-' . Str::lower(Str::random(5))]);
    $other = aexBook($owner, 'second', 'public');
    $overview = aexBook($owner, 'overview', 'public', ['has_nodes' => true]);
    $readingSlug = aexDb()->table('library')->where('book', $reading)->value('slug');
    $host = rtrim(config('app.url'), '/');
    aexDb()->table('nodes')->where('book', $overview)->update([
        'content' => '<p>Week 1: read <a href="' . $host . '/' . $readingSlug . '">the first reading</a>, then <a href="/' . $other . '#intro">the second</a>. Background: <a href="https://example.org/' . $reading . '">elsewhere</a>.</p>',
    ]);

    $shelfId = (string) Str::uuid();
    aexDb()->table('shelves')->insert([
        'id' => $shelfId, 'creator' => $owner->name, 'name' => 'Aex Course', 'slug' => 'aex-course-' . Str::lower(Str::random(5)),
        'visibility' => 'public', 'default_sort' => 'recent', 'overview_book' => $overview,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    foreach ([$reading, $other, $overview] as $b) {
        aexDb()->table('shelf_items')->insert(['shelf_id' => $shelfId, 'book' => $b, 'added_at' => now()]);
    }
    $slug = 'aex-course-arch-' . Str::lower(Str::random(5));
    aexDb()->table('archive_sources')->insert([
        'shelf_id' => $shelfId, 'slug' => $slug, 'display_name' => null, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $readVault = function () use ($slug) {
        $this->postJson("/api/archive-export/archive/{$slug}/build", ['kind' => 'markdown'])->assertStatus(202);
        $path = $this->get("/exports/archive/{$slug}/markdown")->assertOk()->baseResponse->getFile()->getPathname();
        $zip = new ZipArchive();
        expect($zip->open($path))->toBeTrue();
        $notes = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $notes[basename($zip->getNameIndex($i))] = $zip->getFromIndex($i);
        }
        $zip->close();

        return $notes;
    };
    $overviewNote = 'Aex Author - Aex Overview Title.md';

    try {
        // DEFAULT (overview_as_about off): the pinned book is an ordinary
        // note, listed FIRST; the README is the generated one.
        $corpus = app(ArchiveCorpusResolver::class)->resolve('archive', $slug, false);
        expect($corpus->hub)->toBeNull()
            ->and($corpus->bookIds()[0])->toBe($overview)
            ->and($corpus->bookIds())->toContain($reading)->toContain($other);

        $notes = $readVault();
        expect(array_keys($notes))->toHaveCount(4)->toContain($overviewNote);
        expect($notes['README.md'])->toContain('3 texts in this vault')->not->toContain('Week 1: read');
        expect($notes[$overviewNote])->toContain('Week 1: read');

        // OPTED IN: the pinned book IS the README — renamed only: it keeps
        // its own citation front matter and its own link back.
        $about = app(\App\Services\Archives\ArchiveAboutBook::class);
        $about->ensure(aexDb()->table('shelves')->where('id', $shelfId)->first(['id', 'name', 'description', 'creator']));
        $about->saveSettings($shelfId, ['overview_as_about' => true]);

        $corpus = app(ArchiveCorpusResolver::class)->resolve('archive', $slug, false);
        expect($corpus->hub?->book)->toBe($overview)
            ->and($corpus->bookIds())->toContain($reading)->toContain($other)->not->toContain($overview);

        $notes = $readVault();
        expect(array_keys($notes))->toHaveCount(3)->not->toContain($overviewNote);

        $hub = $notes['README.md'];
        expect($hub)->toStartWith("---\ntitle: \"Aex Overview Title\"")
            ->toContain('hyperlit: "' . url('/' . $overview) . '"')
            ->toContain('archive: "' . url('/a/' . $slug) . '"')
            ->toContain('[the first reading](' . rawurlencode('Aex Author - Aex Reading Title.md') . ')')
            ->toContain('[the second](' . rawurlencode('Aex Author - Aex Second Title.md') . ')')
            // Another site's URL is never rewritten, even if it names a book id.
            ->toContain('[elsewhere](https://example.org/' . $reading . ')')
            ->toContain('## About this vault')
            ->toContain('2 texts in this vault');
    } finally {
        app(\App\Services\Archives\ArchiveAboutBook::class)->delete($shelfId);
        aexDb()->table('archive_sources')->where('shelf_id', $shelfId)->delete();
        aexDb()->table('shelf_items')->where('shelf_id', $shelfId)->delete();
        aexDb()->table('shelves')->where('id', $shelfId)->delete();
        File::deleteDirectory(storage_path('app/archive-exports/archive-' . $slug));
        foreach (glob(storage_path('app/archive-exports/archive-' . $slug . '*')) ?: [] as $dir) {
            File::deleteDirectory($dir);
        }
    }
});

test('the vault zip is flushed mid-build without losing a note (bounded memory)', function () {
    // ZipArchive holds every addFromString payload until close(); the builder
    // closes + reopens past flushBytes so peak RAM is one window, not the
    // corpus. Force a flush after EVERY note and prove nothing is dropped.
    $owner = aexUser();
    foreach (['one', 'two', 'three', 'four'] as $suffix) {
        aexBook($owner, $suffix, 'public');
    }
    $this->app->resolving(\App\Services\Export\MarkdownVaultBuilder::class, function ($builder) {
        $builder->flushBytes = 1;
    });
    $scope = 'user/' . rawurlencode($owner->name);

    $this->postJson("/api/archive-export/{$scope}/build", ['kind' => 'markdown'])->assertStatus(202);

    $res = $this->get("/exports/{$scope}/markdown");
    $res->assertOk();
    $names = aexZipNames($res->baseResponse->getFile()->getPathname());
    $joined = implode("\n", $names);

    expect($names)->toHaveCount(5); // README + four notes, each exactly once
    expect($joined)->toContain('README.md')
        ->toContain('Aex One Title')->toContain('Aex Two Title')
        ->toContain('Aex Three Title')->toContain('Aex Four Title');
});
