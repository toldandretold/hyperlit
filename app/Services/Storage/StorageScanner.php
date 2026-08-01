<?php

namespace App\Services\Storage;

use FilesystemIterator;
use Illuminate\Support\Facades\DB;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;

/**
 * Measures everything Hyperlit is storing, in one pass, aggregated per book.
 *
 * Two budgets, not one: in production the database is a DigitalOcean MANAGED
 * cluster, so `db_bytes` is NOT droplet disk. The scan reports both, and the
 * page must keep them visually separate.
 *
 * File trees, and why each exists:
 *   resources/markdown/<book>/          documents — originals + conversion artifacts
 *   storage/app/books/<book>/images/    images    — the private store (book_images)
 *   storage/app/books/<book>/audio/     audio     — per-node TTS (book_audio)
 *   storage/app/cache/books/<book>/     cache     — BookCache JSON, regenerable
 *   storage/app/public/books/<book>/    legacy    — pre-E2EE public image tree (LegacyImageMigrator)
 *   storage/app/{book,failure}-exports  other     — case bundles
 *   storage/logs, public/build          other
 *
 * Sub-books (`book_x/Fn1`) nest INSIDE the root book's directory, so a walk of
 * the top-level dirs attributes their bytes to the root book automatically —
 * which is what the owner-level view wants anyway.
 *
 * A per-book directory whose id has no `library` row is an ORPHAN: nothing in
 * the app deletes a book's files (BookDeletionService removes DB rows only), so
 * these accumulate forever and are the main reclaimable category. Their path is
 * recorded so `storage:reclaim` acts on exactly what was reported.
 */
class StorageScanner
{
    public const DATABASE = 'database';
    public const DOCUMENTS = 'documents';
    public const IMAGES = 'images';
    public const AUDIO = 'audio';
    public const CACHE = 'cache';
    public const LEGACY_IMAGES = 'legacy_images';
    public const OTHER = 'other';

    /** Categories that are safe to lose — regenerable or already migrated. */
    public const RECLAIMABLE = [self::CACHE, self::LEGACY_IMAGES];

    /**
     * The trees this scans, from config — NEVER hardcoded paths.
     *
     * config/storage.php points these inside storage/framework/testing/ under
     * the testing environment, so the folders switch with the database. A test
     * reads the test database AND the test folders; it cannot see, let alone
     * delete, real content. (Before this existed, a test did exactly that.)
     *
     * @return array<string, string>
     */
    public static function roots(): array
    {
        return config('storage.roots');
    }

    public static function root(string $name): string
    {
        return config("storage.roots.{$name}");
    }

    /**
     * Run a full scan.
     *
     * @return array{totals: array<string, mixed>, items: array<int, array<string, mixed>>}
     */
    public function scan(): array
    {
        $books = $this->libraryBooks();
        $items = [];

        foreach ($this->databaseItems() as $item) {
            $items[] = $item;
        }
        foreach ($this->fileItems($books) as $item) {
            $items[] = $item;
        }

        $dbBytes = $this->databaseBytes();
        $fileBytes = 0;
        $orphanBytes = 0;
        foreach ($items as $item) {
            if ($item['category'] === self::DATABASE) {
                continue;
            }
            $fileBytes += $item['bytes'];
            if ($item['is_orphan']) {
                $orphanBytes += $item['bytes'];
            }
        }

        $root = base_path();

        return [
            'totals' => [
                'db_bytes' => $dbBytes,
                'file_bytes' => $fileBytes,
                'orphan_bytes' => $orphanBytes,
                'total_bytes' => $dbBytes + $fileBytes,
                'disk_free_bytes' => @disk_free_space($root) ?: null,
                'disk_total_bytes' => @disk_total_space($root) ?: null,
                // What the app THINKS it stores, for drift against the disk walk:
                // bytes on disk with no owning row are untracked blobs.
                'images_tracked_bytes' => $this->trackedBytes('book_images'),
                'audio_tracked_bytes' => $this->trackedBytes('book_audio'),
            ],
            'items' => $items,
        ];
    }

    // ── Database ──────────────────────────────────────────────────────────

    /** Total size of the database, including indexes and catalogs. */
    public function databaseBytes(): int
    {
        return (int) DB::connection('pgsql_admin')
            ->selectOne('SELECT pg_database_size(current_database()) AS bytes')->bytes;
    }

    /**
     * Per-table sizes. pg_total_relation_size includes the table's indexes and
     * TOAST, which is why these exceed any naive "rows × width" estimate — the
     * page says so, because the difference is usually most of the number.
     *
     * @return array<int, array<string, mixed>>
     */
    private function databaseItems(): array
    {
        $rows = DB::connection('pgsql_admin')->select("
            SELECT c.relname AS table_name,
                   pg_total_relation_size(c.oid) AS bytes,
                   pg_relation_size(c.oid) AS heap_bytes,
                   c.reltuples::bigint AS approx_rows
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
            ORDER BY pg_total_relation_size(c.oid) DESC
        ");

        return array_map(fn ($r) => $this->item([
            'category' => self::DATABASE,
            'subtype' => $r->table_name,
            'bytes' => (int) $r->bytes,
            'file_count' => max(0, (int) $r->approx_rows),  // rows, not files
        ]), $rows);
    }

    /** Bytes the app has RECORDED for a blob table — compare against the disk walk. */
    private function trackedBytes(string $table): int
    {
        return (int) DB::connection('pgsql_admin')->table($table)->sum('bytes');
    }

    // ── Files ─────────────────────────────────────────────────────────────

    /**
     * @param  array<string, string|null>  $books  root book id => owner
     * @return array<int, array<string, mixed>>
     */
    private function fileItems(array $books): array
    {
        $items = [];

        // Documents: per book, broken down by extension so originals (pdf/epub)
        // are distinguishable from conversion artifacts (json/jsonl/html).
        foreach ($this->bookDirs(self::root('markdown')) as $book => $dir) {
            $scan = $this->walk($dir);
            foreach ($scan['by_extension'] as $ext => $agg) {
                $items[] = $this->bookItem($book, $books, self::DOCUMENTS, $ext, $agg, $dir);
            }
        }

        // Images + audio share storage/app/books/<book>/, split by sub-directory.
        foreach ($this->bookDirs(self::root('books')) as $book => $dir) {
            foreach ([self::IMAGES => 'images', self::AUDIO => 'audio'] as $category => $sub) {
                if (! is_dir("{$dir}/{$sub}")) {
                    continue;
                }
                $agg = $this->walk("{$dir}/{$sub}");
                $items[] = $this->bookItem($book, $books, $category, null, $agg, "{$dir}/{$sub}");
            }
            // Anything else under the book dir (progress files, stray artifacts).
            $loose = $this->walk($dir, ['images', 'audio']);
            if ($loose['bytes'] > 0) {
                $items[] = $this->bookItem($book, $books, self::OTHER, 'book-dir', $loose, $dir);
            }
        }

        foreach ([
            self::CACHE => self::root('cache'),
            self::LEGACY_IMAGES => self::root('legacy_images'),
        ] as $category => $root) {
            foreach ($this->bookDirs($root) as $book => $dir) {
                $items[] = $this->bookItem($book, $books, $category, null, $this->walk($dir), $dir);
            }
        }

        // Non-book buckets: never orphans, never owned.
        foreach ([
            'book-exports' => storage_path('app/book-exports'),
            'failure-exports' => storage_path('app/failure-exports'),
            'logs' => storage_path('logs'),
            'build' => public_path('build'),
            'storage-root-files' => storage_path('app'),
        ] as $label => $dir) {
            if (! is_dir($dir)) {
                continue;
            }
            // storage/app itself: only the loose files at its root (citation
            // review dumps and friends), never the sub-trees counted above.
            $agg = $label === 'storage-root-files'
                ? $this->walk($dir, ['books', 'public', 'cache', 'book-exports', 'failure-exports'], maxDepth: 0)
                : $this->walk($dir);

            if ($agg['bytes'] > 0) {
                $items[] = $this->item([
                    'category' => self::OTHER,
                    'subtype' => $label,
                    'bytes' => $agg['bytes'],
                    'file_count' => $agg['files'],
                    'path' => $dir,
                ]);
            }
        }

        return $items;
    }

    /**
     * Book-id => directory for every immediate child of a tree root.
     *
     * @return array<string, string>
     */
    private function bookDirs(string $root): array
    {
        if (! is_dir($root)) {
            return [];
        }

        $dirs = [];
        foreach (new FilesystemIterator($root, FilesystemIterator::SKIP_DOTS) as $entry) {
            if ($entry->isDir()) {
                $dirs[$entry->getFilename()] = $entry->getPathname();
            }
        }
        ksort($dirs);

        return $dirs;
    }

    /**
     * Recursively total a directory.
     *
     * @param  array<int, string>  $skipDirs  immediate child dirs to exclude
     * @param  int|null  $maxDepth  null = unlimited, 0 = this directory's own files
     * @return array{bytes: int, files: int, by_extension: array<string, array{bytes: int, files: int}>}
     */
    private function walk(string $dir, array $skipDirs = [], ?int $maxDepth = null): array
    {
        $out = ['bytes' => 0, 'files' => 0, 'by_extension' => []];
        if (! is_dir($dir)) {
            return $out;
        }

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::LEAVES_ONLY,
        );
        if ($maxDepth !== null) {
            $iterator->setMaxDepth($maxDepth);
        }

        $skip = array_map(fn ($d) => rtrim($dir, '/') . '/' . $d . '/', $skipDirs);

        foreach ($iterator as $file) {
            if (! $file->isFile()) {
                continue;
            }
            $path = $file->getPathname();
            foreach ($skip as $prefix) {
                if (str_starts_with($path, $prefix)) {
                    continue 2;
                }
            }

            $size = $file->getSize() ?: 0;
            $out['bytes'] += $size;
            $out['files']++;

            $ext = strtolower($file->getExtension()) ?: 'no-extension';
            $out['by_extension'][$ext] ??= ['bytes' => 0, 'files' => 0];
            $out['by_extension'][$ext]['bytes'] += $size;
            $out['by_extension'][$ext]['files']++;
        }

        return $out;
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /**
     * Root book id => owner, for every library row. Sub-book rows collapse onto
     * their root, since that is how the directories nest.
     *
     * @return array<string, string|null>
     */
    private function libraryBooks(): array
    {
        $books = [];
        foreach (DB::connection('pgsql_admin')->table('library')->select('book', 'creator')->cursor() as $row) {
            $root = explode('/', (string) $row->book)[0];
            // A root row's own creator wins over a sub-book's.
            if (! array_key_exists($root, $books) || $row->book === $root) {
                $books[$root] = $row->creator;
            }
        }

        return $books;
    }

    /**
     * @param  array<string, string|null>  $books
     * @param  array{bytes: int, files: int}  $agg
     * @return array<string, mixed>
     */
    private function bookItem(string $book, array $books, string $category, ?string $subtype, array $agg, string $path): array
    {
        $known = array_key_exists($book, $books);

        return $this->item([
            'book' => $book,
            'owner' => $known ? $books[$book] : null,
            'category' => $category,
            'subtype' => $subtype,
            'bytes' => $agg['bytes'],
            'file_count' => $agg['files'],
            // Only orphans carry a path: it is what storage:reclaim deletes, and
            // recording it for live books would invite acting on them.
            'path' => $known ? null : $path,
            'is_orphan' => ! $known,
        ]);
    }

    /** @return array<string, mixed> */
    private function item(array $attrs): array
    {
        return array_merge([
            'book' => null,
            'owner' => null,
            'category' => self::OTHER,
            'subtype' => null,
            'bytes' => 0,
            'file_count' => 0,
            'path' => null,
            'is_orphan' => false,
        ], $attrs);
    }
}
