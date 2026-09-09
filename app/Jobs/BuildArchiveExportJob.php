<?php

namespace App\Jobs;

use App\Services\Export\ArchiveCorpusResolver;
use App\Services\Export\ArchiveExportStore;
use App\Services\Export\MarkdownVaultBuilder;
use App\Services\Export\SqliteArchiveBuilder;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * Builds an archive export artifact (markdown vault zip or SQLite data file)
 * for a user library / journal / archive corpus. Queued because a big corpus
 * is minutes of HTML→markdown CPU; the client polls the status endpoint the
 * same way audiobook packaging does.
 *
 * Runs on its own `archive-export` queue. Invariant (BuildAudiobookJob's
 * lesson): a queue nobody listens on silently never runs — this queue name,
 * the Supervisor conf, the package.json dev workers, and queue:probe's QUEUES
 * list must stay in sync.
 *
 * RLS: the corpus is re-resolved here through ArchiveCorpusResolver, which
 * reads pgsql_admin with EXPLICIT visibility filters — deliberately not RLS
 * session vars, which workers have twice forgotten to set, silently yielding
 * empty results (the worst failure for a cached artifact). $audience was
 * computed server-side by the controller and decides includePrivate.
 */
class BuildArchiveExportJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;

    public int $tries = 1; // pressing download again re-dispatches; the cache makes that cheap

    public function __construct(
        private string $scopeType,
        private string $scopeId,
        private string $audience,
        private string $kind,
    ) {
        $this->onQueue('archive-export');
    }

    public function handle(ArchiveCorpusResolver $resolver, ArchiveExportStore $store): void
    {
        try {
            $this->build($resolver, $store);
        } finally {
            $this->releaseLock();
        }
    }

    private function build(ArchiveCorpusResolver $resolver, ArchiveExportStore $store): void
    {
        $corpus = $resolver->resolve($this->scopeType, $this->scopeId, $this->audience === 'owner');
        if (!$corpus || $corpus->books === []) {
            $this->progress($store, 'failed', 0, 'Nothing to export.');

            return;
        }

        $digest = $store->digest($corpus, $this->audience, $this->kind);
        $finalPath = $store->artifactPath($this->scopeType, $this->scopeId, $this->audience, $this->kind, $digest);
        if (is_file($finalPath)) {
            $this->progress($store, 'ready', 1.0, null, basename($finalPath), (int) (filesize($finalPath) ?: 0));

            return;
        }

        $this->progress($store, 'building', 0);
        $workPath = $store->workPath($this->scopeType, $this->scopeId, $this->audience, $this->kind, $digest);
        $onProgress = fn (float $fraction) => $this->progress($store, 'building', $fraction);

        try {
            $path = $this->kind === 'markdown'
                ? app(MarkdownVaultBuilder::class)->build($corpus, $workPath, $finalPath, $onProgress)
                : app(SqliteArchiveBuilder::class)->build($corpus, $this->audience, $workPath, $finalPath, $onProgress);
        } catch (\Throwable $e) {
            Log::error('BuildArchiveExportJob failed', [
                'scope' => "{$this->scopeType}/{$this->scopeId}",
                'kind' => $this->kind,
                'error' => $e->getMessage(),
            ]);
            @unlink($workPath);
            $this->progress($store, 'failed', 0, 'Export packaging failed.');

            return;
        }

        $store->cleanupStale($this->scopeType, $this->scopeId, $this->audience, $this->kind, $path);
        $this->progress($store, 'ready', 1.0, null, basename($path), (int) (filesize($path) ?: 0));
    }

    private function progress(ArchiveExportStore $store, string $status, float $fraction, ?string $message = null, ?string $filename = null, int $bytes = 0): void
    {
        $store->writeProgress($this->scopeType, $this->scopeId, $this->audience, $this->kind, $status, $fraction, $message, $filename, $bytes);
    }

    public function failed(\Throwable $e): void
    {
        // Release FIRST — writing progress can itself throw (stale-worker
        // lesson from BuildAudiobookJob), and a stranded lock blocks every
        // re-press for its full TTL.
        $this->releaseLock();
        try {
            $this->progress(app(ArchiveExportStore::class), 'failed', 0, 'Export packaging failed.');
        } catch (\Throwable) {
            // nothing left to do — the lock is already free
        }
    }

    private function releaseLock(): void
    {
        Cache::lock(ArchiveExportStore::lockKey($this->scopeType, $this->scopeId, $this->audience, $this->kind))->forceRelease();
    }
}
