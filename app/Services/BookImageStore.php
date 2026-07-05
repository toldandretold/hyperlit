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

    /** @return array{0: ?int, 1: ?int} width/height, null for SVG or unreadable. */
    private function dimensions(string $path): array
    {
        if ($this->extension($path) === 'svg') {
            return [null, null];
        }
        $info = @getimagesize($path);

        return $info ? [$info[0], $info[1]] : [null, null];
    }

    private function mimeFor(string $path, string $filename): string
    {
        if ($this->extension($filename) === 'svg') {
            return 'image/svg+xml'; // mime_content_type often reports text/plain for svg
        }

        return mime_content_type($path) ?: 'application/octet-stream';
    }
}
