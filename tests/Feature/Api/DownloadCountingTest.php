<?php

/**
 * Download counting — one `downloads` row per (subject, format, identity,
 * day), the same unit as a view.
 *
 * Contract: the browser-built exports (markdown/docx/epub) are counted by the
 * beacon, which refuses every server-served format (those are counted at
 * their own routes — letting a client claim one would double-count); the PDF
 * route counts a GET and never the HEAD the source panel probes with; a
 * same-day repeat dedupes while a second format counts; no identity counts
 * nothing; sub-books roll up to their root; and totals show up for the owner
 * (creator stats) and the maintainer.
 *
 * Writes by controllers go through the DEFAULT connection (rolled back by
 * RefreshDatabase), so they are counted on the default connection; readers go
 * through pgsql_admin, so read-side fixtures are seeded committed and cleaned
 * by cleanupApiFixtures.
 */

use App\Services\Stats\DownloadRecorder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

function dlRows(string $subject, ?string $format = null): int
{
    $q = DB::table('downloads')->where('subject', $subject);
    if ($format !== null) {
        $q->where('format', $format);
    }

    return (int) $q->count();
}

function dlSeed(string $type, string $subject, string $format, string $userName, ?string $day = null): void
{
    DB::connection('pgsql_admin')->table('downloads')->insert([
        'subject_type' => $type,
        'subject' => $subject,
        'format' => $format,
        'user_name' => $userName,
        'download_date' => $day ?? now()->toDateString(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

test('a browser-built export is counted once per person per format per day', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    $this->postJson('/api/database-to-indexeddb/download', ['book' => $book, 'format' => 'epub'])->assertOk();
    $this->postJson('/api/database-to-indexeddb/download', ['book' => $book, 'format' => 'epub'])->assertOk();
    expect(dlRows($book))->toBe(1);

    // Same book, another format: a different download.
    $this->postJson('/api/database-to-indexeddb/download', ['book' => $book, 'format' => 'markdown'])->assertOk();
    expect(dlRows($book))->toBe(2)
        ->and(dlRows($book, 'markdown'))->toBe(1);

    // Another reader, same format: a different download.
    $this->actingAs($this->apiUser());
    $this->postJson('/api/database-to-indexeddb/download', ['book' => $book, 'format' => 'epub'])->assertOk();
    expect(dlRows($book, 'epub'))->toBe(2);
});

test('the beacon refuses server-served formats and unknown books', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    foreach (['pdf', 'm4b', 'markdown-vault', 'sqlite', 'mcp-markdown', ''] as $format) {
        $this->postJson('/api/database-to-indexeddb/download', ['book' => $book, 'format' => $format])->assertStatus(422);
    }
    $this->postJson('/api/database-to-indexeddb/download', ['book' => 'apitest_no_such_book', 'format' => 'epub'])->assertStatus(422);

    expect(dlRows($book))->toBe(0);
});

test('a sub-book download rolls up to its root book', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);

    $this->postJson('/api/database-to-indexeddb/download', ['book' => $book . '/Fn123', 'format' => 'docx'])->assertOk();

    expect(dlRows($book, 'docx'))->toBe(1)
        ->and(dlRows($book . '/Fn123'))->toBe(0);
});

test('no identity, no count', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    $this->postJson('/api/database-to-indexeddb/download', ['book' => $book, 'format' => 'epub'])->assertOk();

    expect(dlRows($book))->toBe(0);
});

test('an anonymous reader is counted by their anon token', function () {
    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);
    $token = Str::uuid()->toString();

    foreach ([1, 2] as $_) {
        $this->withCredentials()
            ->withUnencryptedCookie('anon_token', $token)
            ->postJson('/api/database-to-indexeddb/download', ['book' => $book, 'format' => 'epub'])
            ->assertOk();
    }

    expect(dlRows($book))->toBe(1)
        ->and(DB::table('downloads')->where('subject', $book)->whereNotNull('anon_token')->count())->toBe(1);
});

test('the original PDF counts a GET, never the HEAD probe', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public']);
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/original.pdf", "%PDF-1.4\n%fake\n");

    try {
        $this->call('HEAD', "/{$book}/original.pdf")->assertOk();
        expect(dlRows($book))->toBe(0);

        $this->get("/{$book}/original.pdf")->assertOk();
        $this->get("/{$book}/original.pdf")->assertOk();
        expect(dlRows($book, 'pdf'))->toBe(1);
    } finally {
        File::deleteDirectory($dir);
    }
});

test('the recorder never throws and skips nonsense', function () {
    $recorder = app(DownloadRecorder::class);

    expect($recorder->recordForUser('api_test_x', 'nonsense', 'apitest_b', 'epub'))->toBeFalse()
        ->and($recorder->recordForUser('api_test_x', DownloadRecorder::TYPE_BOOK, '', 'epub'))->toBeFalse()
        ->and($recorder->recordForUser('', DownloadRecorder::TYPE_BOOK, 'apitest_b', 'epub'))->toBeFalse()
        ->and($recorder->recordForUser('api_test_x', DownloadRecorder::TYPE_BOOK, 'apitest_b', 'epub'))->toBeTrue()
        ->and($recorder->recordForUser('api_test_x', DownloadRecorder::TYPE_BOOK, 'apitest_b', 'epub'))->toBeFalse();
});

test('creator stats carry download totals, raw plus rollups, split by format', function () {
    $creator = $this->loginUser();
    $book = $this->makeBook($creator, ['visibility' => 'public']);
    dlSeed('book', $book, 'epub', 'api_test_reader1');
    dlSeed('book', $book, 'epub', 'api_test_reader2');
    dlSeed('book', $book, 'pdf', 'api_test_reader1');
    DB::connection('pgsql_admin')->table('download_rollups')->insert([
        'subject_type' => 'book', 'subject' => $book, 'format' => 'epub',
        'download_date' => now()->subDays(200)->toDateString(), 'downloads' => 5,
    ]);

    $list = $this->getJson('/api/creator/stats')->assertOk()->json('books');
    $row = collect($list)->firstWhere('book', $book);
    expect($row['downloads'])->toBe(8);

    $detail = $this->getJson('/api/creator/stats/' . $book)->assertOk()->json();
    expect($detail['downloads'])->toBe(8)
        ->and($detail['downloads_by_format'])->toBe(['epub' => 7, 'pdf' => 1]);

    // Aggregates only: no downloader identity anywhere in the body.
    expect(json_encode($detail))->not->toContain('api_test_reader');
});

test('creator shelf stats: own shelves only, with views, downloads and library downloads', function () {
    $creator = $this->loginUser();
    $mine = (string) Str::uuid();
    $theirs = (string) Str::uuid();
    $admin = DB::connection('pgsql_admin');
    foreach ([[$mine, $creator->name], [$theirs, $this->apiUser()->name]] as [$id, $owner]) {
        $admin->table('shelves')->insert([
            'id' => $id, 'creator' => $owner, 'name' => 'Shelf ' . substr($id, 0, 6),
            'slug' => 'shelf-' . substr($id, 0, 6), 'visibility' => 'public',
            'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    foreach (['api_test_v1', 'api_test_v2'] as $viewer) {
        $admin->table('page_views')->insert([
            'page' => 'shelf:' . $mine, 'user_name' => $viewer,
            'view_date' => now()->toDateString(), 'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    dlSeed('shelf', $mine, 'zettlr', 'api_test_v1');
    dlSeed('library', $creator->name, 'sqlite', 'api_test_v1');

    $json = $this->getJson('/api/creator/stats/shelves')->assertOk()->json();
    $ids = array_column($json['shelves'], 'id');
    expect($ids)->toContain($mine)->not->toContain($theirs);

    $row = collect($json['shelves'])->firstWhere('id', $mine);
    expect($row['views'])->toBe(2)
        ->and($row['downloads'])->toBe(1)
        ->and($row['downloads_by_format'])->toBe(['zettlr' => 1])
        ->and($json['library']['downloads'])->toBe(1);

    expect(json_encode($json))->not->toContain('api_test_v1');
});

test('the maintainer sees shelf views and download totals, top shelves and top downloads', function () {
    $this->loginUser(['is_admin' => true]);
    $creator = $this->apiUser();
    $book = $this->makeBook($creator, ['visibility' => 'public']);
    $shelf = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('shelves')->insert([
        'id' => $shelf, 'creator' => $creator->name, 'name' => 'Maint shelf', 'slug' => 'maint-' . substr($shelf, 0, 6),
        'visibility' => 'public', 'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
    ]);
    DB::connection('pgsql_admin')->table('page_views')->insert([
        'page' => 'shelf:' . $shelf, 'user_name' => 'api_test_mv',
        'view_date' => now()->toDateString(), 'created_at' => now(), 'updated_at' => now(),
    ]);
    dlSeed('book', $book, 'epub', 'api_test_mv');
    dlSeed('shelf', $shelf, 'markdown', 'api_test_mv');

    $summary = $this->getJson('/api/maintainer/stats/summary')->assertOk()->json();
    expect($summary)->toHaveKeys(['shelf_views', 'downloads', 'downloads_by_type'])
        ->and($summary['shelf_views'])->toBeGreaterThanOrEqual(1)
        ->and($summary['downloads_by_type']['book'] ?? 0)->toBeGreaterThanOrEqual(1);

    $shelves = $this->getJson('/api/maintainer/stats/top-shelves')->assertOk()->json('shelves');
    $s = collect($shelves)->firstWhere('id', $shelf);
    expect($s)->not->toBeNull()
        ->and($s['views'])->toBe(1)
        ->and($s['downloads'])->toBe(1);

    $books = $this->getJson('/api/maintainer/stats/top-downloads')->assertOk()->json('books');
    $b = collect($books)->firstWhere('book', $book);
    expect($b)->not->toBeNull()
        ->and($b['by_format'])->toBe(['epub' => 1]);
});
