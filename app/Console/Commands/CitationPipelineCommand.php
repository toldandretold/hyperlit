<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class CitationPipelineCommand extends Command
{
    protected $signature = 'citation:pipeline {bookId : The parent book to run the full citation pipeline for}
                            {--skip-fetch : Skip vacuum + OCR steps}
                            {--skip-review : Stop after fetching content (no LLM review)}
                            {--force : Re-resolve all bibliography entries from scratch (ignore existing source links)}
                            {--pipeline-id= : Pipeline tracking ID (updates citation_pipelines table with step progress)}';

    protected $description = 'Run the full citation pipeline: bibliography scan → content scan → vacuum → OCR → review';

    public function handle(): int
    {
        $bookId = $this->argument('bookId');
        $db = DB::connection('pgsql_admin');

        // Step 1: Validate book exists
        $book = $db->table('library')->where('book', $bookId)->first();
        if (!$book) {
            $this->error("Book not found: {$bookId}");
            return 1;
        }

        $this->info("Pipeline: {$book->title}");
        $this->newLine();

        $summary = [];

        // Step 1: Scan bibliography (includes web fetch for URL-bearing entries)
        $this->updatePipelineStep('bibliography', 'Scanning bibliography entries');
        $this->info('Step 1/5: Scanning bibliography...');
        $bibCountBefore = $db->table('bibliography')->where('book', $bookId)->count();
        $bibArgs = ['target' => $bookId];
        if ($this->option('force')) {
            $bibArgs['--force'] = true;
        }
        $exit = $this->call('citation:scan-bibliography', $bibArgs);
        if ($exit !== 0) {
            $this->error('Bibliography scan failed. Aborting.');
            return 1;
        }
        $bibCountAfter = $db->table('bibliography')->where('book', $bookId)->count();
        $summary['bibliography'] = $bibCountAfter;
        $this->newLine();

        // Step 2: Scan content (informational — non-blocking)
        $this->updatePipelineStep('content', 'Scanning in-text citations');
        $this->info('Step 2/5: Scanning in-text citations...');
        $this->call('citation:scan-content', ['bookId' => $bookId]);
        $this->newLine();

        // Step 3: Targeted vacuum + OCR
        $vacuumFetched = 0;
        $vacuumSkipped = 0;
        $vacuumFailed = 0;

        if ($this->option('skip-fetch')) {
            $this->info('Step 3/5: Vacuum — skipped (--skip-fetch)');
            $this->info('Step 4/5: OCR — skipped (--skip-fetch)');
            $this->newLine();
        } else {
            $this->updatePipelineStep('vacuum', 'Fetching source content');
            $this->info('Step 3/5: Fetching source content...');

            $sources = $db->table('bibliography as b')
                ->join('library as l', 'l.book', '=', 'b.foundation_source')
                ->where('b.book', $bookId)
                ->where('l.has_nodes', false)
                ->where(function ($q) {
                    $q->where(function ($q2) {
                        $q2->whereNotNull('l.oa_url')->where('l.oa_url', '!=', '');
                    })->orWhere(function ($q2) {
                        $q2->whereNotNull('l.pdf_url')->where('l.pdf_url', '!=', '');
                    })->orWhere(function ($q2) {
                        $q2->whereNotNull('l.doi')->where('l.doi', '!=', '');
                    });
                })
                ->whereNull('l.pdf_url_status')
                ->select(['l.book', 'l.title'])
                ->distinct()
                ->get();

            if ($sources->isEmpty()) {
                $this->line('  No sources need fetching.');
            } else {
                $this->line("  {$sources->count()} source(s) to fetch.");
                $this->newLine();

                foreach ($sources as $i => $source) {
                    $title = $source->title ?: '(untitled)';
                    $this->updatePipelineStep('vacuum', 'Fetching source ' . ($i + 1) . '/' . $sources->count());
                    $this->line("  <fg=cyan>[" . ($i + 1) . "/{$sources->count()}] {$title}</>");

                    $exit = $this->call('citation:vacuum', ['bookId' => $source->book]);

                    if ($exit === 0) {
                        $vacuumFetched++;
                    } else {
                        $vacuumFailed++;
                        $this->line("  <fg=yellow>Failed — continuing</>");
                    }

                    // Rate limit between sources
                    if ($i < $sources->count() - 1) {
                        sleep(1);
                    }
                }
            }

            $vacuumSkipped = $summary['bibliography'] - $sources->count();
            $summary['vacuum'] = ['fetched' => $vacuumFetched, 'failed' => $vacuumFailed, 'skipped' => max(0, $vacuumSkipped)];
            $this->newLine();

            // Step 4: Targeted OCR
            $this->updatePipelineStep('ocr', 'Running OCR on downloaded PDFs');
            $this->info('Step 4/5: Running OCR on downloaded PDFs...');

            $downloaded = $db->table('bibliography as b')
                ->join('library as l', 'l.book', '=', 'b.foundation_source')
                ->where('b.book', $bookId)
                ->where('l.has_nodes', false)
                ->where('l.pdf_url_status', 'downloaded')
                ->select(['l.book', 'l.title'])
                ->distinct()
                ->get();

            $ocrProcessed = 0;
            $ocrFailed = 0;

            if ($downloaded->isEmpty()) {
                $this->line('  No PDFs awaiting OCR.');
            } else {
                $this->line("  {$downloaded->count()} PDF(s) to process.");
                $this->newLine();

                foreach ($downloaded as $i => $source) {
                    $title = $source->title ?: '(untitled)';
                    $this->updatePipelineStep('ocr', 'Processing PDF ' . ($i + 1) . '/' . $downloaded->count());
                    $this->line("  <fg=cyan>[" . ($i + 1) . "/{$downloaded->count()}] {$title}</>");

                    $exit = $this->call('citation:ocr', ['bookId' => $source->book]);

                    if ($exit === 0) {
                        $ocrProcessed++;
                    } else {
                        $ocrFailed++;
                        $this->line("  <fg=yellow>OCR failed — continuing</>");
                    }
                }
            }

            $summary['ocr'] = ['processed' => $ocrProcessed, 'failed' => $ocrFailed];
            $this->newLine();
        }

        // Step 5: Review
        if ($this->option('skip-review')) {
            $this->info('Step 5/5: Review — skipped (--skip-review)');
            $this->newLine();
        } else {
            $this->updatePipelineStep('review', 'Reviewing citations with LLM');
            $this->info('Step 5/5: Reviewing citations...');
            $exit = $this->call('citation:review', ['bookId' => $bookId]);
            if ($exit !== 0) {
                $this->error('Review step failed.');
                return 1;
            }
            $this->newLine();
        }

        // Bump annotations_updated_at so the frontend syncs on next load
        $now_ms = round(microtime(true) * 1000);
        $db->table('library')
            ->where('book', $bookId)
            ->update(['annotations_updated_at' => $now_ms]);

        // Final summary
        $this->newLine();
        $this->info('Pipeline complete:');
        $this->line("  Bibliography:  {$summary['bibliography']} entries scanned");

        if (isset($summary['vacuum'])) {
            $v = $summary['vacuum'];
            $this->line("  Vacuum:        {$v['fetched']}/{$sources->count()} sources fetched ({$v['skipped']} skipped, {$v['failed']} failed)");
        }

        if (isset($summary['ocr'])) {
            $o = $summary['ocr'];
            $this->line("  OCR:           {$o['processed']} PDFs processed" . ($o['failed'] ? " ({$o['failed']} failed)" : ''));
        }

        return 0;
    }

    private function updatePipelineStep(string $step, ?string $detail = null): void
    {
        $pipelineId = $this->option('pipeline-id');
        if (!$pipelineId) return;

        $update = [
            'current_step' => $step,
            'step_detail'  => $detail,
            'updated_at'   => now(),
        ];

        DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $pipelineId)
            ->update($update);
    }
}
