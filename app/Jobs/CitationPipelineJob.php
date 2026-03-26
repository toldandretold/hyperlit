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

    public int $timeout = 1800;
    public int $tries = 1;

    public function __construct(
        private string $bookId,
        private string $scanId,
    ) {
        $this->onQueue('citation-pipeline');
    }

    public function handle(): void
    {
        Log::info('CitationPipelineJob starting', ['book' => $this->bookId, 'scanId' => $this->scanId]);

        $db = DB::connection('pgsql_admin');

        // Mark scan as running
        $db->table('citation_scans')
            ->where('id', $this->scanId)
            ->update(['status' => 'running', 'updated_at' => now()]);

        try {
            $exitCode = Artisan::call('citation:pipeline', [
                'bookId' => $this->bookId,
            ]);

            if ($exitCode !== 0) {
                $output = Artisan::output();
                Log::error('CitationPipelineJob failed', [
                    'book'     => $this->bookId,
                    'scanId'   => $this->scanId,
                    'exitCode' => $exitCode,
                    'output'   => $output,
                ]);

                $db->table('citation_scans')
                    ->where('id', $this->scanId)
                    ->update([
                        'status'     => 'failed',
                        'error'      => "citation:pipeline exited with code {$exitCode}",
                        'updated_at' => now(),
                    ]);

                $this->fail(new \RuntimeException("citation:pipeline exited with code {$exitCode}"));
                return;
            }

            // Mark scan as completed
            $db->table('citation_scans')
                ->where('id', $this->scanId)
                ->update(['status' => 'completed', 'updated_at' => now()]);

            Log::info('CitationPipelineJob completed', ['book' => $this->bookId, 'scanId' => $this->scanId]);
        } catch (\Throwable $e) {
            Log::error('CitationPipelineJob exception', [
                'book'    => $this->bookId,
                'scanId'  => $this->scanId,
                'error'   => $e->getMessage(),
            ]);

            $db->table('citation_scans')
                ->where('id', $this->scanId)
                ->update([
                    'status'     => 'failed',
                    'error'      => $e->getMessage(),
                    'updated_at' => now(),
                ]);

            throw $e;
        }
    }
}
