<?php

namespace App\Jobs;

use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\StudyCitationRerunner;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;

/**
 * The workbench's "re-run this citation" button: runs StudyCitationRerunner
 * off the request thread (a single-citation pipeline still takes minutes) and
 * keeps the UI informed through a per-book status file the console polls —
 * {status: queued|running|completed|failed, run_id, error}.
 *
 * Never retried: a retry re-bills the LLM review, and the rerunner's own
 * guards make a clean re-press of the button the safer recovery.
 */
class StudyCitationRerunJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 1;
    public int $timeout = 2 * 3600;

    public function __construct(
        public readonly string $corpus,
        public readonly string $slug,
        public readonly string $citation,
    ) {}

    public function handle(StudyCitationRerunner $rerunner): void
    {
        $manifest = CorpusManifest::load($this->corpus);
        self::writeStatus($manifest, $this->slug, [
            'status' => 'running',
            'citation' => $this->citation,
            'started_at' => now()->toIso8601String(),
        ]);

        try {
            $result = $rerunner->rerun(
                $manifest,
                $this->slug,
                $this->citation,
                false,
                fn (string $line) => Log::info("study:rerun {$this->slug}: {$line}"),
            );
            self::writeStatus($manifest, $this->slug, [
                'status' => 'completed',
                'citation' => $this->citation,
                'run_id' => $result['run_id'],
                'reference_id' => $result['reference_id'],
                'finished_at' => now()->toIso8601String(),
            ]);
        } catch (\Throwable $e) {
            self::writeStatus($manifest, $this->slug, [
                'status' => 'failed',
                'citation' => $this->citation,
                'error' => $e->getMessage(),
                'finished_at' => now()->toIso8601String(),
            ]);
            Log::warning("study:rerun {$this->slug} failed", ['error' => $e->getMessage()]);
        }
    }

    public function failed(\Throwable $e): void
    {
        // Covers deaths handle()'s catch cannot see (timeout, worker kill).
        try {
            self::writeStatus(CorpusManifest::load($this->corpus), $this->slug, [
                'status' => 'failed',
                'citation' => $this->citation,
                'error' => $e->getMessage(),
                'finished_at' => now()->toIso8601String(),
            ]);
        } catch (\Throwable) {
            // status file is best-effort; the log above is the record
        }
    }

    public static function statusPath(CorpusManifest $manifest, string $slug): string
    {
        return $manifest->resultsDir() . "/rerun/{$slug}.json";
    }

    public static function readStatus(CorpusManifest $manifest, string $slug): ?array
    {
        $path = self::statusPath($manifest, $slug);
        if (!is_file($path)) {
            return null;
        }
        $data = json_decode((string) file_get_contents($path), true);
        return is_array($data) ? $data : null;
    }

    public static function writeStatus(CorpusManifest $manifest, string $slug, array $status): void
    {
        $path = self::statusPath($manifest, $slug);
        @mkdir(dirname($path), 0775, true);
        file_put_contents($path, json_encode($status, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    }
}
