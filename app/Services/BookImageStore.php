<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

/**
 * The single write/read seam for book images (docs/e2ee.md).
 *
 * Bytes live on the private `book_images` disk (storage/app/books/{book}/images/),
 * metadata + lifecycle in the `book_images` table. All conversion paths funnel
 * their extracted images through ingestFromDirectory(); the media route reads
 * via path(). DB writes go through the pgsql_admin (BYPASSRLS) connection — this
 * is a trusted server-side seam and the ingest runs in queue workers that have
 * no RLS session.
 */
class BookImageStore
{
    /** Same allowlist as the media route's filename regex. */
    public const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];

    private const DISK = 'book_images';

    /** Absolute path to a book's image directory. */
    public function dir(string $book): string
    {
        return Storage::disk(self::DISK)->path($this->relative($book, ''));
    }

    /**
     * Traversal-safe absolute path to one image file. Throws on a filename that
     * could escape the book's directory.
     */
    public function path(string $book, string $filename): string
    {
        $this->assertSafeFilename($filename);

        return Storage::disk(self::DISK)->path($this->relative($book, $filename));
    }

    private function relative(string $book, string $filename): string
    {
        $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book) ?? '';

        return $filename === '' ? "{$book}/images" : "{$book}/images/{$filename}";
    }

    private function assertSafeFilename(string $filename): void
    {
        if ($filename === '' || str_contains($filename, '/') || str_contains($filename, '\\')
            || str_contains($filename, '..')) {
            throw new \InvalidArgumentException("Unsafe image filename: {$filename}");
        }
    }

    private function extension(string $filename): string
    {
        return strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    }

    /**
     * Move every allowed image from a conversion handoff dir (the book's
     * markdown `media/` dir) into the private store and upsert its row.
     * `prune` deletes rows+files whose filename isn't in THIS batch, so the
     * store mirrors the latest conversion (closes the reconvert-accumulation
     * gap). Returns the number of images ingested.
     */
    public function ingestFromDirectory(string $book, string $handoffDir, bool $prune = false): int
    {
        if (! is_dir($handoffDir)) {
            if ($prune) {
                $this->pruneToFilenames($book, []);
            }

            return 0;
        }

        $destDir = $this->dir($book);
        File::ensureDirectoryExists($destDir, 0755);

        $ingested = [];
        foreach (File::files($handoffDir) as $file) {
            $filename = $file->getFilename();
            if (! in_array($this->extension($filename), self::ALLOWED_EXTENSIONS, true)) {
                continue;
            }
            $this->assertSafeFilename($filename);

            $source = $file->getPathname();
            [$width, $height] = $this->dimensions($source);
            $mime = $this->mimeFor($source, $filename);

            // Move the bytes into the private store (overwrite any prior copy).
            $dest = "{$destDir}/{$filename}";
            File::move($source, $dest);
            @chmod($dest, 0644);

            DB::connection('pgsql_admin')->table('book_images')->upsert(
                [[
                    'id' => (string) \Illuminate\Support\Str::uuid(),
                    'book' => $book,
                    'filename' => $filename,
                    'mime' => $mime,
                    'bytes' => filesize($dest) ?: 0,
                    'width' => $width,
                    'height' => $height,
                    'encrypted' => false, // fresh conversion is always plaintext
                    'created_at' => now(),
                    'updated_at' => now(),
                ]],
                ['book', 'filename'],
                ['mime', 'bytes', 'width', 'height', 'encrypted', 'updated_at'],
            );

            $ingested[] = $filename;
        }

        if ($prune) {
            $this->pruneToFilenames($book, $ingested);
        }

        return count($ingested);
    }

    /**
     * Overwrite one image's bytes in place (atomic tmp+rename) and set its
     * encrypted flag. Used by the E2EE lock/publish upload endpoint (Phase II).
     */
    public function replaceBytes(string $book, string $filename, string $bytesPath, bool $encrypted): void
    {
        $dest = $this->path($book, $filename);
        File::ensureDirectoryExists(dirname($dest), 0755);

        $tmp = $dest.'.tmp'.bin2hex(random_bytes(4));
        File::copy($bytesPath, $tmp);
        @chmod($tmp, 0644);
        File::move($tmp, $dest); // atomic replace within the same filesystem

        DB::connection('pgsql_admin')->table('book_images')
            ->where('book', $book)->where('filename', $filename)
            ->update([
                'encrypted' => $encrypted,
                'bytes' => filesize($dest) ?: 0,
                'updated_at' => now(),
            ]);
    }

    /**
     * Store a single client-uploaded image (the "Phase III upload"): mint a
     * collision-free filename from the user's original name, move the bytes
     * into the store, and insert the row. For an encrypted upload the bytes
     * are an HLENC1 blob the server can't measure, so the client supplies
     * width/height (plaintext dims are an accepted leak — docs/e2ee.md) and
     * the mime is derived from the extension.
     *
     * @return array{filename: string, mime: string, bytes: int, width: ?int, height: ?int}
     */
    public function storeUploaded(string $book, string $originalName, string $bytesPath, bool $encrypted, ?int $width, ?int $height): array
    {
        $ext = $this->extension($originalName);
        if (! in_array($ext, self::ALLOWED_EXTENSIONS, true)) {
            throw new \InvalidArgumentException("Disallowed image extension: {$ext}");
        }

        $base = \Illuminate\Support\Str::slug(pathinfo($originalName, PATHINFO_FILENAME));
        if ($base === '') {
            $base = 'image';
        }
        $base = substr($base, 0, 80);

        $destDir = $this->dir($book);
        File::ensureDirectoryExists($destDir, 0755);

        // Random prefix keeps repeat uploads of the same name distinct
        // (harvest precedent: ArticleImageHarvester::filenameFor).
        $filename = null;
        for ($attempt = 0; $attempt < 3; $attempt++) {
            $candidate = bin2hex(random_bytes(4))."-{$base}.{$ext}";
            $this->assertSafeFilename($candidate);
            $rowExists = DB::connection('pgsql_admin')->table('book_images')
                ->where('book', $book)->where('filename', $candidate)->exists();
            if (! $rowExists && ! File::exists("{$destDir}/{$candidate}")) {
                $filename = $candidate;
                break;
            }
        }
        if ($filename === null) {
            throw new \RuntimeException('Could not mint a unique image filename');
        }

        if (! $encrypted) {
            [$width, $height] = $this->dimensions($bytesPath);
            $mime = $this->mimeFor($bytesPath, $filename);
        } else {
            $mime = $this->mimeForExtension($ext);
        }

        // Atomic tmp+rename within the store's filesystem (replaceBytes pattern).
        $dest = "{$destDir}/{$filename}";
        $tmp = $dest.'.tmp'.bin2hex(random_bytes(4));
        File::copy($bytesPath, $tmp);
        @chmod($tmp, 0644);
        File::move($tmp, $dest);

        $bytes = filesize($dest) ?: 0;

        DB::connection('pgsql_admin')->table('book_images')->insert([
            'id' => (string) \Illuminate\Support\Str::uuid(),
            'book' => $book,
            'filename' => $filename,
            'mime' => $mime,
            'bytes' => $bytes,
            'width' => $width,
            'height' => $height,
            'encrypted' => $encrypted,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return [
            'filename' => $filename,
            'mime' => $mime,
            'bytes' => $bytes,
            'width' => $width,
            'height' => $height,
        ];
    }

    /** Delete a book's image directory + all its rows (best-effort callers). */
    public function purgeBook(string $book): void
    {
        DB::connection('pgsql_admin')->table('book_images')->where('book', $book)->delete();
        File::deleteDirectory($this->dir($book));
    }

    /** Remove rows+files for this book whose filename isn't in $keep. */
    private function pruneToFilenames(string $book, array $keep): void
    {
        $stale = DB::connection('pgsql_admin')->table('book_images')
            ->where('book', $book)
            ->when(! empty($keep), fn ($q) => $q->whereNotIn('filename', $keep))
            ->pluck('filename');

        foreach ($stale as $filename) {
            try {
                File::delete($this->path($book, $filename));
            } catch (\Throwable $e) {
                Log::warning('BookImageStore prune: could not delete file', [
                    'book' => $book, 'filename' => $filename, 'error' => $e->getMessage(),
                ]);
            }
        }

        DB::connection('pgsql_admin')->table('book_images')
            ->where('book', $book)
            ->when(! empty($keep), fn ($q) => $q->whereNotIn('filename', $keep))
            ->delete();
    }

    /**
     * @return array{0: ?int, 1: ?int} width/height, null for SVG or unreadable.
     *
     * EXIF-aware: getimagesize reads the RAW pixel grid, but browsers render
     * JPEGs rotated per EXIF orientation (image-orientation: from-image is the
     * default). iPhone portrait photos are stored landscape with orientation
     * 5-8 — without the swap, the stored width/height (and the aspect-ratio
     * the renderer derives from them) describe the wrong box, and the photo
     * displays stretched.
     */
    private function dimensions(string $path): array
    {
        if ($this->extension($path) === 'svg') {
            return [null, null];
        }
        $info = @getimagesize($path);
        if (! $info) {
            return [null, null];
        }
        [$width, $height] = [$info[0], $info[1]];

        if (($info['mime'] ?? null) === 'image/jpeg' && function_exists('exif_read_data')) {
            $orientation = (int) (@exif_read_data($path)['Orientation'] ?? 0);
            if (in_array($orientation, [5, 6, 7, 8], true)) {
                [$width, $height] = [$height, $width];
            }
        }

        return [$width, $height];
    }

    /** Mime by extension alone — for encrypted uploads, whose bytes are ciphertext. */
    private function mimeForExtension(string $ext): string
    {
        return match ($ext) {
            'jpg', 'jpeg' => 'image/jpeg',
            'png' => 'image/png',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'svg' => 'image/svg+xml',
            default => 'application/octet-stream',
        };
    }

    private function mimeFor(string $path, string $filename): string
    {
        if ($this->extension($filename) === 'svg') {
            return 'image/svg+xml'; // mime_content_type often reports text/plain for svg
        }

        return mime_content_type($path) ?: 'application/octet-stream';
    }
}
