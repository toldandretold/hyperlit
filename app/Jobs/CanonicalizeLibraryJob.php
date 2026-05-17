<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Log;

/**
 * Queueable wrapper around `library:canonicalize`.
 * See docs/canonical-sources.md.
 */
class CanonicalizeLibraryJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 7200;
    public int $tries = 3;

    public function __construct(
        private ?string $bookId = null,
        private int $limit = 0,
        private bool $missingOnly = true,
        private bool $force = false,
        private bool $dryRun = false,
        private int $sleep = 0,
    ) {
        $this->onQueue('citation-pipeline');
    }

    public function backoff(): array
    {
        return [60, 300];
    }

    public function handle(): void
    {
        Log::info('CanonicalizeLibraryJob starting', [
            'book'        => $this->bookId,
            'limit'       => $this->limit,
            'missingOnly' => $this->missingOnly,
            'force'       => $this->force,
            'dryRun'      => $this->dryRun,
            'attempt'     => $this->attempts(),
        ]);

        $args = [
            '--limit' => $this->limit,
            '--sleep' => $this->sleep,
        ];
        if ($this->bookId)      $args['--book'] = $this->bookId;
        if ($this->missingOnly) $args['--missing-only'] = true;
        if ($this->force)       $args['--force'] = true;
        if ($this->dryRun)      $args['--dry-run'] = true;

        $exitCode = Artisan::call('library:canonicalize', $args);

        if ($exitCode !== 0) {
            $output = Artisan::output();
            Log::error('CanonicalizeLibraryJob failed', [
                'exitCode' => $exitCode,
                'output'   => $output,
                'attempt'  => $this->attempts(),
            ]);
            throw new \RuntimeException("library:canonicalize exited with code {$exitCode}");
        }

        Log::info('CanonicalizeLibraryJob completed', [
            'output' => Artisan::output(),
        ]);
    }

    public function failed(\Throwable $e): void
    {
        Log::error('CanonicalizeLibraryJob permanently failed', [
            'error' => $e->getMessage(),
        ]);
    }
}
