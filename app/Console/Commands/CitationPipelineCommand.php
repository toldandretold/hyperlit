<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

class CitationPipelineCommand extends Command
{
    protected $signature = 'citation:pipeline {bookId : The parent book to run the full citation pipeline for}
                            {--skip-fetch : Skip vacuum + OCR steps}
                            {--skip-review : Stop after fetching content (no LLM review)}
                            {--force : Re-resolve all bibliography entries from scratch (ignore existing source links)}
                            {--resume : Resume from the last completed step (skip already-finished steps)}
                            {--pipeline-id= : Pipeline tracking ID (updates citation_pipelines table with step progress)}
                            {--user-id= : User ID for billing}';

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

        // Load existing step timings when resuming
        if ($this->option('resume')) {
            $this->loadExistingTimings();
            $skippable = collect($this->stepTimings)
                ->filter(fn ($t) => !empty($t['completed_at']))
                ->keys()
                ->implode(', ');
            if ($skippable) {
                $this->info("Resuming — will skip completed steps: {$skippable}");
            } else {
                $this->info('Resuming — no completed steps found, running from start');
            }
        }

        $this->newLine();

        $summary = [];

        // Step 1: Scan bibliography (includes web fetch for URL-bearing entries)
        if ($this->stepCompleted('bibliography')) {
            $this->info('Step 1/5: Bibliography — already completed, skipping');
        } else {
            $this->updatePipelineStep('bibliography', 'Scanning bibliography entries');
            $this->info('Step 1/5: Scanning bibliography...');
            $bibArgs = ['target' => $bookId];
            if ($this->option('force')) {
                $bibArgs['--force'] = true;
            }
            $exit = $this->call('citation:scan-bibliography', $bibArgs);
            if ($exit !== 0) {
                $this->error('Bibliography scan failed. Aborting.');
                return 1;
            }
        }
        $summary['bibliography'] = $db->table('bibliography')->where('book', $bookId)->count();
        $summary['footnote_citations'] = $db->table('footnotes')
            ->where('book', $bookId)->where('is_citation', true)->count();
        $this->newLine();

        // If no bibliography entries and no citation footnotes, skip remaining steps
        if ($summary['bibliography'] === 0 && $summary['footnote_citations'] === 0) {
            $this->warn('No bibliography entries and no citation footnotes — skipping remaining steps.');
            $this->newLine();

            // Finalize step timings
            $this->finalizeStepTimings();

            // Bump annotations_updated_at so the frontend syncs on next load
            $now_ms = round(microtime(true) * 1000);
            $db->table('library')
                ->where('book', $bookId)
                ->update(['annotations_updated_at' => $now_ms]);

            $this->info('Pipeline complete:');
            $this->line("  Bibliography:  0 entries scanned");
            $this->line("  Footnote citations:  0");

            return 0;
        }

        // Step 2: Scan content (informational — non-blocking)
        if ($this->stepCompleted('content')) {
            $this->info('Step 2/5: Content scan — already completed, skipping');
        } else {
            $this->updatePipelineStep('content', 'Scanning in-text citations');
            $this->info('Step 2/5: Scanning in-text citations...');
            $exit = $this->call('citation:scan-content', ['bookId' => $bookId]);
            if ($exit !== 0) {
                $this->error('Content scan failed. Aborting.');
                return 1;
            }
        }
        $this->newLine();

        // Steps 3-4: Targeted vacuum + OCR
        if ($this->option('skip-fetch')) {
            $this->info('Step 3/5: Vacuum — skipped (--skip-fetch)');
            $this->info('Step 4/5: OCR — skipped (--skip-fetch)');
            $this->newLine();
        } else {
            // Step 3: Vacuum
            $vacuumFetched = 0;
            $vacuumSkipped = 0;
            $vacuumFailed = 0;

            if ($this->stepCompleted('vacuum')) {
                $this->info('Step 3/5: Vacuum — already completed, skipping');
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

                // Footnote-only: check footnotes → library when bibliography is empty
                if ($sources->isEmpty() && $summary['bibliography'] === 0) {
                    $sources = $db->table('footnotes as f')
                        ->join('library as l', 'l.book', '=', 'f.foundation_source')
                        ->where('f.book', $bookId)
                        ->where('f.is_citation', true)
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
                }

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

                $sourceTotal = $summary['bibliography'] > 0 ? $summary['bibliography'] : $summary['footnote_citations'];
                $vacuumSkipped = $sourceTotal - ($sources->count() ?? 0);
                $summary['vacuum'] = ['fetched' => $vacuumFetched, 'failed' => $vacuumFailed, 'skipped' => max(0, $vacuumSkipped)];
            }
            $this->newLine();

            // Step 4: Targeted OCR
            $ocrProcessed = 0;
            $ocrFailed = 0;
            $ocrTotalPages = 0;

            if ($this->stepCompleted('ocr')) {
                $this->info('Step 4/5: OCR — already completed, skipping');
            } else {
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

                // Footnote-only: check footnotes → library when bibliography is empty
                if ($downloaded->isEmpty() && $summary['bibliography'] === 0) {
                    $downloaded = $db->table('footnotes as f')
                        ->join('library as l', 'l.book', '=', 'f.foundation_source')
                        ->where('f.book', $bookId)
                        ->where('f.is_citation', true)
                        ->where('l.has_nodes', false)
                        ->where('l.pdf_url_status', 'downloaded')
                        ->select(['l.book', 'l.title'])
                        ->distinct()
                        ->get();
                }

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

                            // Count pages from cached OCR response
                            $safeDir = str_replace('/', '_', $source->book);
                            $ocrJson = resource_path("markdown/{$safeDir}/ocr_response.json");
                            if (File::exists($ocrJson)) {
                                $ocrData = json_decode(File::get($ocrJson), true);
                                $ocrTotalPages += count($ocrData['pages'] ?? []);
                            }
                        } else {
                            $ocrFailed++;
                            $this->line("  <fg=yellow>OCR failed — continuing</>");
                        }
                    }
                }

                $summary['ocr'] = ['processed' => $ocrProcessed, 'failed' => $ocrFailed];

                // Store OCR page count in step timings
                if ($ocrTotalPages > 0 && isset($this->stepTimings['ocr'])) {
                    $this->stepTimings['ocr']['total_pages'] = $ocrTotalPages;
                }
            }
            $this->newLine();
        }

        // Step 5: Review
        if ($this->option('skip-review')) {
            $this->info('Step 5/5: Review — skipped (--skip-review)');
            $this->newLine();
        } elseif ($this->stepCompleted('review')) {
            $this->info('Step 5/5: Review — already completed, skipping');
            $this->newLine();
        } else {
            $this->updatePipelineStep('review', 'Reviewing citations with LLM');
            $this->info('Step 5/5: Reviewing citations...');
            $reviewArgs = ['bookId' => $bookId];
            if ($this->option('pipeline-id')) {
                $reviewArgs['--pipeline-id'] = $this->option('pipeline-id');
            }
            if ($this->option('user-id')) {
                $reviewArgs['--user-id'] = $this->option('user-id');
            }
            $exit = $this->call('citation:review', $reviewArgs);
            if ($exit !== 0) {
                $this->error('Review step failed.');
                return 1;
            }
            $this->newLine();
        }

        // Finalize step timings
        $this->finalizeStepTimings();

        // Bump annotations_updated_at so the frontend syncs on next load
        $now_ms = round(microtime(true) * 1000);
        $db->table('library')
            ->where('book', $bookId)
            ->update(['annotations_updated_at' => $now_ms]);

        // Final summary
        $this->newLine();
        $this->info('Pipeline complete:');
        $this->line("  Bibliography:  {$summary['bibliography']} entries scanned");
        if ($summary['footnote_citations'] > 0) {
            $this->line("  Footnote citations:  {$summary['footnote_citations']}");
        }

        if (isset($summary['vacuum'])) {
            $v = $summary['vacuum'];
            $fetchTotal = $v['fetched'] + $v['failed'] + $v['skipped'];
            $this->line("  Vacuum:        {$v['fetched']}/{$fetchTotal} sources fetched ({$v['skipped']} skipped, {$v['failed']} failed)");
        }

        if (isset($summary['ocr'])) {
            $o = $summary['ocr'];
            $this->line("  OCR:           {$o['processed']} PDFs processed" . ($o['failed'] ? " ({$o['failed']} failed)" : ''));
        }

        return 0;
    }

    private ?string $currentTimingStep = null;
    private array $stepTimings = [];

    /**
     * Load existing step timings from the DB (for resume).
     */
    private function loadExistingTimings(): void
    {
        $pipelineId = $this->option('pipeline-id');
        if (!$pipelineId) return;

        $pipeline = DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $pipelineId)
            ->first();

        if ($pipeline && $pipeline->step_timings) {
            $this->stepTimings = json_decode($pipeline->step_timings, true) ?? [];
        }
    }

    /**
     * Check if a step already completed (has a completed_at timestamp).
     */
    private function stepCompleted(string $step): bool
    {
        if (!$this->option('resume')) return false;

        return isset($this->stepTimings[$step]['completed_at'])
            && $this->stepTimings[$step]['completed_at'] !== null;
    }

    private function updatePipelineStep(string $step, ?string $detail = null): void
    {
        $now = now();

        // Close previous step timing
        if ($this->currentTimingStep !== null && isset($this->stepTimings[$this->currentTimingStep])) {
            $prev = &$this->stepTimings[$this->currentTimingStep];
            $prev['completed_at'] = $now->toDateTimeString();
            $started = \Carbon\Carbon::parse($prev['started_at']);
            $prev['duration_seconds'] = $started->diffInSeconds($now);
            unset($prev);
        }

        // Open new step timing
        $this->currentTimingStep = $step;
        $this->stepTimings[$step] = [
            'started_at'       => $now->toDateTimeString(),
            'completed_at'     => null,
            'duration_seconds' => null,
        ];

        $pipelineId = $this->option('pipeline-id');
        if (!$pipelineId) return;

        $update = [
            'current_step'  => $step,
            'step_detail'   => $detail,
            'step_timings'  => json_encode($this->stepTimings),
            'updated_at'    => $now,
        ];

        DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $pipelineId)
            ->update($update);
    }

    private function finalizeStepTimings(): void
    {
        $now = now();

        // Close the last step
        if ($this->currentTimingStep !== null && isset($this->stepTimings[$this->currentTimingStep])) {
            $prev = &$this->stepTimings[$this->currentTimingStep];
            $prev['completed_at'] = $now->toDateTimeString();
            $started = \Carbon\Carbon::parse($prev['started_at']);
            $prev['duration_seconds'] = $started->diffInSeconds($now);
            unset($prev);
        }

        $pipelineId = $this->option('pipeline-id');
        if (!$pipelineId) return;

        DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $pipelineId)
            ->update([
                'step_timings' => json_encode($this->stepTimings),
                'updated_at'   => $now,
            ]);
    }
}
