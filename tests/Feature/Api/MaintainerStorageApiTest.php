<?php

/**
 * /maintainer/storage + its API, and the reclaim command's guard rails.
 *
 * The page is admin-only like its siblings, and the scan attributes bytes per
 * book so the future per-user view is a filter over this same data.
 *
 * The reclaim tests matter most: that command deletes user content with no
 * undo, so each guard gets its own test — dry-run by default, a live library
 * row is never a candidate, a young directory is skipped (an import writes
 * files BEFORE its library row exists), and --dry-run beats --force when both
 * are given.
 */

use App\Services\Storage\StorageScanner;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

afterEach(function () {
    foreach (['storagetest_live', 'storagetest_orphan', 'storagetest_young'] as $book) {
        File::deleteDirectory(StorageScanner::root('markdown') . "/{$book}");
        File::deleteDirectory(StorageScanner::root('books') . "/{$book}");
    }
    DB::connection('pgsql_admin')->table('library')->where('book', 'like', 'storagetest_%')->delete();
    // Snapshots these tests took; items cascade.
    DB::table('storage_scans')->delete();
});

/** A book directory with one file of known size. */
function seedBookDir(string $book, int $bytes = 2048, string $ext = 'pdf'): string
{
    // The SANDBOX markdown root (config/storage.php), never the real tree —
    // these tests run a --force delete.
    $dir = StorageScanner::root('markdown') . "/{$book}";
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/original.{$ext}", str_repeat('x', $bytes));

    return $dir;
}

function seedLibraryRow(string $book): void
{
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => $book,
        'title' => 'Storage test',
        'creator' => 'storagetester',
        'visibility' => 'private',
        'timestamp' => now()->timestamp,
        // library kept raw_json (NOT NULL) when nodes dropped theirs.
        'raw_json' => json_encode([]),
    ]);
}

// ── Page + API gating ─────────────────────────────────────────────────────

test('the /maintainer/storage page 404s for guests and non-admins, renders for admins', function () {
    $this->get('/maintainer/storage')->assertNotFound();

    $this->loginUser(); // authenticated but NOT admin
    $this->get('/maintainer/storage')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/storage')->assertOk()->assertViewIs('maintainer-storage')->assertSee('Storage');
});

test('every storage API endpoint is admin-gated', function () {
    $this->loginUser();

    $this->getJson('/api/maintainer/storage/summary')->assertStatus(403);
    $this->getJson('/api/maintainer/storage/detail/documents')->assertStatus(403);
    $this->postJson('/api/maintainer/storage/rescan')->assertStatus(403);
});

// ── The scan ──────────────────────────────────────────────────────────────

test('the scanner attributes a book\'s files to its owner, split by extension', function () {
    seedLibraryRow('storagetest_live');
    seedBookDir('storagetest_live', 4096, 'pdf');

    $items = collect(app(StorageScanner::class)->scan()['items'])
        ->where('book', 'storagetest_live')
        ->where('category', StorageScanner::DOCUMENTS);

    $pdf = $items->firstWhere('subtype', 'pdf');

    expect($pdf)->not->toBeNull()
        ->and($pdf['bytes'])->toBe(4096)
        ->and($pdf['owner'])->toBe('storagetester')   // the seam the user page will filter on
        ->and($pdf['is_orphan'])->toBeFalse()
        ->and($pdf['path'])->toBeNull();              // live books carry no reclaim path
});

test('a directory with no library row is an orphan and carries its path', function () {
    seedBookDir('storagetest_orphan', 1024);

    $item = collect(app(StorageScanner::class)->scan()['items'])
        ->firstWhere('book', 'storagetest_orphan');

    expect($item)->not->toBeNull()
        ->and($item['is_orphan'])->toBeTrue()
        ->and($item['owner'])->toBeNull()
        ->and($item['path'])->toBe(StorageScanner::root('markdown') . '/storagetest_orphan');
});

test('the database is measured per table and separately from files', function () {
    $scan = app(StorageScanner::class)->scan();

    $tables = collect($scan['items'])->where('category', StorageScanner::DATABASE);

    expect($tables->count())->toBeGreaterThan(5)
        ->and($tables->firstWhere('subtype', 'library'))->not->toBeNull()
        ->and($scan['totals']['db_bytes'])->toBeGreaterThan(0)
        // db bytes must NOT be folded into file bytes: in prod they are
        // different machines and different bills.
        ->and($scan['totals']['file_bytes'])->toBeLessThan($scan['totals']['total_bytes']);
});

test('the summary endpoint serves the latest snapshot grouped by category', function () {
    seedLibraryRow('storagetest_live');
    seedBookDir('storagetest_live', 8192);
    Artisan::call('storage:scan');

    $this->loginUser(['is_admin' => true]);
    $body = $this->getJson('/api/maintainer/storage/summary')->assertOk()->json();

    expect($body['scan'])->not->toBeNull()
        ->and($body['totals']['total_bytes'])->toBeGreaterThan(0)
        ->and(collect($body['categories'])->pluck('category'))->toContain('documents')
        ->and(collect($body['categories'])->firstWhere('category', 'cache')['reclaimable'] ?? true)->toBeTrue();
});

// ── Reclaim guard rails (this command deletes irreversibly) ───────────────

test('reclaim is a dry run by default and deletes nothing', function () {
    $dir = seedBookDir('storagetest_orphan', 1024);
    touch("{$dir}/original.pdf", now()->subDays(30)->getTimestamp());
    touch($dir, now()->subDays(30)->getTimestamp());

    Artisan::call('storage:reclaim');

    expect(File::exists($dir))->toBeTrue()
        ->and(Artisan::output())->toContain('Would delete');
});

test('reclaim never touches a book that still has a library row', function () {
    seedLibraryRow('storagetest_live');
    $dir = seedBookDir('storagetest_live', 1024);
    touch($dir, now()->subDays(30)->getTimestamp());

    Artisan::call('storage:reclaim', ['--force' => true]);

    expect(File::exists($dir))->toBeTrue();
});

test('reclaim skips directories younger than the age guard', function () {
    // An import writes its files BEFORE the library row exists — deleting a
    // fresh orphan would destroy a book being created right now.
    $dir = seedBookDir('storagetest_young', 1024);

    Artisan::call('storage:reclaim', ['--force' => true, '--min-age-days' => 7]);

    expect(File::exists($dir))->toBeTrue()
        ->and(Artisan::output())->toContain('modified within 7d');
});

test('--dry-run beats --force when both are given', function () {
    $dir = seedBookDir('storagetest_orphan', 1024);
    touch("{$dir}/original.pdf", now()->subDays(30)->getTimestamp());
    touch($dir, now()->subDays(30)->getTimestamp());

    Artisan::call('storage:reclaim', ['--force' => true, '--dry-run' => true]);

    expect(File::exists($dir))->toBeTrue();
});

test('reclaim deletes a genuinely orphaned, aged directory with --force', function () {
    $dir = seedBookDir('storagetest_orphan', 1024);
    touch("{$dir}/original.pdf", now()->subDays(30)->getTimestamp());
    touch($dir, now()->subDays(30)->getTimestamp());

    Artisan::call('storage:reclaim', ['--force' => true, '--category' => StorageScanner::DOCUMENTS]);

    expect(File::exists($dir))->toBeFalse();
});
