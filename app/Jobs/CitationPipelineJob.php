<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class CitationPipelineJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 7200; // 2 hours — LLM calls are slow, batched 5 at a time
    public int $tries = 3;

    public function __construct(
        private string $bookId,
        private string $pipelineId,
        private bool $force = false,
        private ?int $userId = null,
        private bool $resume = false,
    ) {
        $this->onQueue('citation-pipeline');
    }

    /**
     * Backoff between retries: 1 minute, then 5 minutes.
     */
    public function backoff(): array
    {
        return [60, 300];
    }

    public function handle(): void
    {
        Log::info('CitationPipelineJob starting', [
            'book'       => $this->bookId,
            'pipelineId' => $this->pipelineId,
            'attempt'    => $this->attempts(),
        ]);

        $db = DB::connection('pgsql_admin');

        // Mark pipeline as running (handles both first attempt and retries)
        $update = [
            'status'     => 'running',
            'error'      => null,
            'updated_at' => now(),
        ];
        if ($this->attempts() === 1 && !$this->resume) {
            $update['current_step'] = 'bibliography';
        }
        $db->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->update($update);

        $args = [
            'bookId'          => $this->bookId,
            '--pipeline-id'   => $this->pipelineId,
        ];
        if ($this->force) {
            $args['--force'] = true;
        }
        if ($this->userId) {
            $args['--user-id'] = $this->userId;
        }
        if ($this->resume || $this->attempts() > 1) {
            $args['--resume'] = true;
        }

        $exitCode = Artisan::call('citation:pipeline', $args);

        if ($exitCode !== 0) {
            $output = Artisan::output();
            Log::error('CitationPipelineJob step failed', [
                'book'       => $this->bookId,
                'pipelineId' => $this->pipelineId,
                'exitCode'   => $exitCode,
                'output'     => $output,
                'attempt'    => $this->attempts(),
            ]);
            throw new \RuntimeException("citation:pipeline exited with code {$exitCode}");
        }

        // Mark pipeline as completed
        $db->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->update(['status' => 'completed', 'updated_at' => now()]);

        Log::info('CitationPipelineJob completed', [
            'book'       => $this->bookId,
            'pipelineId' => $this->pipelineId,
        ]);
    }

    /**
     * Called after all retry attempts are exhausted.
     */
    public function failed(\Throwable $e): void
    {
        Log::error('CitationPipelineJob permanently failed after all retries', [
            'book'       => $this->bookId,
            'pipelineId' => $this->pipelineId,
            'error'      => $e->getMessage(),
        ]);

        DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->update([
                'status'     => 'failed',
                'error'      => $e->getMessage(),
                'updated_at' => now(),
            ]);
    }
}
