<?php

namespace App\Jobs;

use App\Services\Audiobook\AudiobookBuilder;
use App\Services\Audiobook\AudiobookUnavailable;
use App\Services\BookAudioStore;
use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Packages a book's per-node MP3s into one downloadable .m4b with chapters.
 *
 * Queued because the AAC re-encode is minutes of CPU on a long book (measured:
 * ~133x realtime, so a 6-hour book is a few minutes here and longer on the
 * droplet). The client polls audiobookStatus() the same way playback generation
 * polls progress().
 *
 * Runs on its own `audio-package` queue (Supervisor hyperlit-audio-package.conf,
 * `npm run queue:audio-package` in dev). It originally shared `audio` with
 * GenerateBookAudioJob, which head-of-line-blocked a ~2-minute packaging behind
 * up to an hour of someone else's narration (observed on prod 2026-08-13: a
 * download sat at "0%" for 18 minutes waiting for a narration job to finish).
 * Invariant: a queue nobody listens on silently never runs — this queue name,
 * the supervisor conf, the package.json dev workers, and queue:probe's QUEUES
 * list must stay in sync.
 */
class BuildAudiobookJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;

    public int $tries = 1; // pressing download again re-dispatches; the cache makes that cheap

    public function __construct(private string $bookId)
    {
        $this->onQueue('audio-package');
    }

    public function handle(AudiobookBuilder $builder, BookAudioStore $store): void
    {
        try {
            $this->build($builder, $store);
        } finally {
            $this->releaseLock();
        }
    }

    private function build(AudiobookBuilder $builder, BookAudioStore $store): void
    {
        // Defense in depth — the controller gates these too.
        if (str_contains($this->bookId, '/') || EncryptedBookGuard::isEncrypted($this->bookId)) {
            $this->writeProgress($store, 'failed', 0, 'This book cannot be packaged.');

            return;
        }

        $this->writeProgress($store, 'building', 0);

        try {
            $segments = $builder->segments($this->bookId);
            $path = $builder->build(
                $this->bookId,
                $segments,
                $this->bookMeta(),
                function (float $fraction) use ($store) {
                    $this->writeProgress($store, 'building', $fraction);
                },
            );
        } catch (AudiobookUnavailable $e) {
            $this->writeProgress($store, 'failed', 0, $e->getMessage());

            return;
        } catch (\Throwable $e) {
            Log::error('BuildAudiobookJob failed', ['book' => $this->bookId, 'error' => $e->getMessage()]);
            $this->writeProgress($store, 'failed', 0, 'Audiobook packaging failed.');

            return;
        }

        // Older digests are dead the moment a new one exists — the audio they
        // packaged has been regenerated. Sweep them so a book keeps at most one.
        foreach (glob($store->dir($this->bookId).'/audiobook-*.m4b') ?: [] as $old) {
            if ($old !== $path) {
                @unlink($old);
            }
        }

        $this->writeProgress($store, 'ready', 1.0, null, basename($path), (int) (filesize($path) ?: 0));
    }

    /** Title/author for the file's own metadata, so players display it properly. */
    private function bookMeta(): array
    {
        $row = DB::connection('pgsql_admin')->table('library')
            ->where('book', $this->bookId)
            ->first(['title', 'author', 'creator']);

        return [
            'title' => trim((string) ($row->title ?? '')) ?: $this->bookId,
            'author' => trim((string) ($row->author ?? $row->creator ?? '')),
        ];
    }

    private function writeProgress(
        BookAudioStore $store,
        string $status,
        float $fraction,
        ?string $message = null,
        ?string $filename = null,
        int $bytes = 0,
    ): void {
        $path = $store->audiobookProgressPath($this->bookId);
        File::ensureDirectoryExists(dirname($path), 0755);
        File::put($path, json_encode([
            'status' => $status,                       // building | ready | failed
            'progress' => round(min(1.0, max(0.0, $fraction)), 3),
            'message' => $message,
            'filename' => $filename,
            'bytes' => $bytes,
            'updated_at' => now()->toIso8601String(),
        ]));
    }

    public function failed(\Throwable $e): void
    {
        // Release FIRST. Writing progress can itself throw (a stale worker
        // running pre-deploy code did exactly that), and a lock stranded for
        // its full 3900s TTL leaves the button spinning on a build that will
        // never happen.
        $this->releaseLock();
        try {
            $this->writeProgress(app(BookAudioStore::class), 'failed', 0, 'Audiobook packaging failed.');
        } catch (\Throwable) {
            // nothing left to do — the lock is already free
        }
    }

    private function releaseLock(): void
    {
        Cache::lock(self::lockKey($this->bookId))->forceRelease();
    }

    /** Distinct from GenerateBookAudioJob's "book-audio:{book}" — they can overlap. */
    public static function lockKey(string $book): string
    {
        return "book-audiobook:{$book}";
    }
}
