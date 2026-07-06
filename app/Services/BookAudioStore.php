<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * The single write/read seam for per-node TTS audio (mirrors BookImageStore).
 *
 * Bytes live on the private `book_audio` disk (storage/app/books/{book}/audio/),
 * metadata in the `book_audio` table. The audio route reads via path(); the
 * generation job writes via putNodeAudio(). DB writes go through the
 * pgsql_admin (BYPASSRLS) connection — generation runs in queue workers that
 * have no RLS session.
 */
class BookAudioStore
{
    private const DISK = 'book_audio';

    /** Absolute path to a book's audio directory. */
    public function dir(string $book): string
    {
        return Storage::disk(self::DISK)->path($this->relative($book, ''));
    }

    /**
     * Traversal-safe absolute path to one audio file. Throws on a filename
     * that could escape the book's directory.
     */
    public function path(string $book, string $filename): string
    {
        $this->assertSafeFilename($filename);

        return Storage::disk(self::DISK)->path($this->relative($book, $filename));
    }

    /** Path to the generation progress file (read by the polling endpoint). */
    public function progressPath(string $book): string
    {
        return $this->dir($book).'/audio_progress.json';
    }

    /** Path to the cancel sentinel (touched by the cancel endpoint). */
    public function cancelPath(string $book): string
    {
        return $this->dir($book).'/audio_cancel';
    }

    private function relative(string $book, string $filename): string
    {
        $book = preg_replace('/[^a-zA-Z0-9_-]/', '', $book) ?? '';

        return $filename === '' ? "{$book}/audio" : "{$book}/audio/{$filename}";
    }

    private function assertSafeFilename(string $filename): void
    {
        if ($filename === '' || str_contains($filename, '/') || str_contains($filename, '\\')
            || str_contains($filename, '..')) {
            throw new \InvalidArgumentException("Unsafe audio filename: {$filename}");
        }
    }

    /**
     * Write one node's synthesized MP3 (atomic tmp+rename) and upsert its row.
     * Deletes the superseded file when the filename changed (regeneration).
     * Returns the stored filename.
     */
    public function putNodeAudio(
        string $book,
        string $nodeId,
        string $bytes,
        string $sourceHash,
        string $voice,
        int $chars,
        ?int $durationMs,
    ): string {
        $filename = $this->filenameFor($nodeId, $sourceHash);
        $dest = $this->path($book, $filename);
        File::ensureDirectoryExists(dirname($dest), 0755);

        $tmp = $dest.'.tmp'.bin2hex(random_bytes(4));
        File::put($tmp, $bytes);
        @chmod($tmp, 0644);
        File::move($tmp, $dest); // atomic replace within the same filesystem

        $previous = DB::connection('pgsql_admin')->table('book_audio')
            ->where('book', $book)->where('node_id', $nodeId)->value('filename');

        DB::connection('pgsql_admin')->table('book_audio')->upsert(
            [[
                'id' => (string) Str::uuid(),
                'book' => $book,
                'node_id' => $nodeId,
                'filename' => $filename,
                'source_hash' => $sourceHash,
                'voice' => $voice,
                'chars' => $chars,
                'duration_ms' => $durationMs,
                'bytes' => strlen($bytes),
                'created_at' => now(),
                'updated_at' => now(),
            ]],
            ['book', 'node_id'],
            ['filename', 'source_hash', 'voice', 'chars', 'duration_ms', 'bytes', 'updated_at'],
        );

        if ($previous !== null && $previous !== $filename) {
            @File::delete($this->path($book, $previous));
        }

        return $filename;
    }

    /**
     * The (node_id, source_hash) pairs that already have audio — the job skips
     * these, which makes generation idempotent, resumable, and IS the
     * regenerate-changed-nodes path.
     *
     * @return array<string, string> node_id => source_hash
     */
    public function existingHashes(string $book): array
    {
        return DB::connection('pgsql_admin')->table('book_audio')
            ->where('book', $book)
            ->pluck('source_hash', 'node_id')
            ->all();
    }

    /** Delete rows + files for nodes that no longer exist in the book. */
    public function pruneToNodeIds(string $book, array $keepNodeIds): void
    {
        $stale = DB::connection('pgsql_admin')->table('book_audio')
            ->where('book', $book)
            ->when(! empty($keepNodeIds), fn ($q) => $q->whereNotIn('node_id', $keepNodeIds))
            ->pluck('filename');

        foreach ($stale as $filename) {
            try {
                File::delete($this->path($book, $filename));
            } catch (\Throwable) {
                // best-effort: the row delete below is what matters
            }
        }

        DB::connection('pgsql_admin')->table('book_audio')
            ->where('book', $book)
            ->when(! empty($keepNodeIds), fn ($q) => $q->whereNotIn('node_id', $keepNodeIds))
            ->delete();
    }

    /** Delete a book's audio directory + all its rows (best-effort callers). */
    public function purgeBook(string $book): void
    {
        DB::connection('pgsql_admin')->table('book_audio')->where('book', $book)->delete();
        DB::connection('pgsql_admin')->table('book_audio_meta')->where('book', $book)->delete();
        File::deleteDirectory($this->dir($book));
    }

    private function filenameFor(string $nodeId, string $sourceHash): string
    {
        // node_id is generateDataNodeId() output (alnum/underscore) but sanitize
        // anyway — the filename must survive assertSafeFilename round-trips.
        $safe = preg_replace('/[^a-zA-Z0-9_-]/', '', $nodeId) ?? '';

        return $safe.'-'.substr($sourceHash, 0, 8).'.mp3';
    }
}
