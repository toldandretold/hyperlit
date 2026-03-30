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
    public int $tries = 1;

    public function __construct(
        private string $bookId,
        private string $pipelineId,
        private bool $force = false,
    ) {
        $this->onQueue('citation-pipeline');
    }

    public function handle(): void
    {
        Log::info('CitationPipelineJob starting', ['book' => $this->bookId, 'pipelineId' => $this->pipelineId]);

        $db = DB::connection('pgsql_admin');

        // Mark pipeline as running
        $db->table('citation_pipelines')
            ->where('id', $this->pipelineId)
            ->update([
                'status'       => 'running',
                'current_step' => 'bibliography',
                'updated_at'   => now(),
            ]);

        try {
            $args = [
                'bookId'          => $this->bookId,
                '--pipeline-id'   => $this->pipelineId,
            ];
            if ($this->force) {
                $args['--force'] = true;
            }

            $exitCode = Artisan::call('citation:pipeline', $args);

            if ($exitCode !== 0) {
                $output = Artisan::output();
                Log::error('CitationPipelineJob failed', [
                    'book'       => $this->bookId,
                    'pipelineId' => $this->pipelineId,
                    'exitCode'   => $exitCode,
                    'output'     => $output,
                ]);

                $db->table('citation_pipelines')
                    ->where('id', $this->pipelineId)
                    ->update([
                        'status'     => 'failed',
                        'error'      => "citation:pipeline exited with code {$exitCode}",
                        'updated_at' => now(),
                    ]);

                $this->fail(new \RuntimeException("citation:pipeline exited with code {$exitCode}"));
                return;
            }

            // Mark pipeline as completed
            $db->table('citation_pipelines')
                ->where('id', $this->pipelineId)
                ->update(['status' => 'completed', 'updated_at' => now()]);

            Log::info('CitationPipelineJob completed', ['book' => $this->bookId, 'pipelineId' => $this->pipelineId]);
        } catch (\Throwable $e) {
            Log::error('CitationPipelineJob exception', [
                'book'       => $this->bookId,
                'pipelineId' => $this->pipelineId,
                'error'      => $e->getMessage(),
            ]);

            $db->table('citation_pipelines')
                ->where('id', $this->pipelineId)
                ->update([
                    'status'     => 'failed',
                    'error'      => $e->getMessage(),
                    'updated_at' => now(),
                ]);

            throw $e;
        }
    }
}
