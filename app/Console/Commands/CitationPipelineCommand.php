<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class CitationPipelineCommand extends Command
{
    protected $signature = 'citation:pipeline {bookId : The parent book to run the full citation pipeline for}
                            {--skip-fetch : Skip vacuum + OCR steps}
                            {--skip-review : Stop after fetching content (no LLM review)}';

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
        $this->info('Step 1/5: Scanning bibliography...');
        $bibCountBefore = $db->table('bibliography')->where('book', $bookId)->count();
        $exit = $this->call('citation:scan-bibliography', ['target' => $bookId]);
        if ($exit !== 0) {
            $this->error('Bibliography scan failed. Aborting.');
            return 1;
        }
        $bibCountAfter = $db->table('bibliography')->where('book', $bookId)->count();
        $summary['bibliography'] = $bibCountAfter;
        $this->newLine();

        // Step 2: Scan content (informational — non-blocking)
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
            $this->info('Step 5/5: Reviewing citations...');
            $this->call('citation:review', ['bookId' => $bookId]);
            $this->newLine();
        }

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
}
