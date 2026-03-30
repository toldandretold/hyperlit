<?php

namespace App\Console\Commands;

use App\Services\BillingService;
use App\Services\CitationReviewService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

class CitationReviewCommand extends Command
{
    protected $signature = 'citation:review {bookId : The book to review citations for} {--report-only : Regenerate report + highlights from latest JSON (skip LLM phases)} {--pipeline-id= : Pipeline tracking ID for appendix diagnostics}';
    protected $description = 'Review in-text citations: extract truth claims, search source material, verify with LLM';

    public function handle(CitationReviewService $reviewService): int
    {
        $bookId = $this->argument('bookId');
        $db = DB::connection('pgsql_admin');

        // Validate book exists
        $book = $db->table('library')->where('book', $bookId)->first();
        if (!$book) {
            $this->error("Book not found: {$bookId}");
            return 1;
        }

        // Check LLM API key
        if (!config('services.llm.api_key')) {
            $this->error('LLM_API_KEY is not configured. Set it in .env');
            return 1;
        }

        $this->info("Book: {$book->title}");
        $this->newLine();

        // --report-only: regenerate report + highlights from latest JSON
        if ($this->option('report-only')) {
            $pattern = storage_path("app/citation-review_{$bookId}_*.json");
            $files = glob($pattern);
            if (empty($files)) {
                $this->error("No JSON files found matching: {$pattern}");
                return 1;
            }
            sort($files);
            $latestJson = end($files);
            $this->info("Loading claims from: {$latestJson}");

            $claims = json_decode(file_get_contents($latestJson), true);
            if (empty($claims)) {
                $this->warn('JSON file contained no claims.');
                return 0;
            }
            $this->info("Loaded " . count($claims) . " claims");

            $onProgress = function (string $phase, string $message) {
                $this->line("  <fg=cyan>[{$phase}]</> {$message}");
            };

            $reportStats = [];
            if ($this->option('pipeline-id')) {
                $reportStats['pipeline_id'] = $this->option('pipeline-id');
            }

            $md = $reviewService->regenerateReport($claims, $bookId, $book->title ?? $bookId, $onProgress, $reportStats);

            $this->info("View at: " . config('app.url') . "/{$bookId}/AIreview");

            // Send completion email to book creator
            $unverifiedCount = $confirmedCount = $likelyCount = $plausibleCount = $unlikelyCount = $rejectedCount = 0;
            foreach ($claims as $claim) {
                if (empty($claim['source_book_id'])) {
                    $unverifiedCount++;
                    continue;
                }
                match ($claim['llm_verdict']['support'] ?? 'insufficient') {
                    'confirmed'  => $confirmedCount++,
                    'likely'     => $likelyCount++,
                    'plausible'  => $plausibleCount++,
                    'unlikely'   => $unlikelyCount++,
                    'rejected'   => $rejectedCount++,
                    default      => null,
                };
            }

            $creator = \App\Models\User::on('pgsql_admin')->where('name', $book->creator)->first();
            if ($creator?->email) {
                $appUrl = config('app.url');
                \Illuminate\Support\Facades\Mail::send('emails.citation-review', [
                    'logoUrl'       => url('/images/logoc.png'),
                    'bookTitle'     => $book->title ?? $bookId,
                    'reviewUrl'     => "{$appUrl}/{$bookId}/AIreview",
                    'bookUrl'       => "{$appUrl}/{$bookId}",
                    'confirmed'     => $confirmedCount,
                    'likely'        => $likelyCount,
                    'plausible'     => $plausibleCount,
                    'unlikely'      => $unlikelyCount,
                    'rejected'      => $rejectedCount,
                    'unverified'    => $unverifiedCount,
                    'sourcesFound'  => count(array_unique(array_filter(array_column($claims, 'source_book_id')))),
                    'sourcesTotal'  => count(array_unique(array_filter(array_column($claims, 'referenceId')))),
                    'citationCount' => count($claims),
                ], function ($message) use ($creator) {
                    $message->to($creator->email)->subject('AI Citation Review Complete');
                });
                $this->info("Notification sent to {$creator->email}");
            } else {
                $this->warn("No email sent — could not find user for creator: {$book->creator}");
            }

            return 0;
        }

        // Pre-flight checks
        $bibTotal = $db->table('bibliography')->where('book', $bookId)->count();
        $resolved = $db->table('bibliography')
            ->where('book', $bookId)
            ->whereNotNull('foundation_source')
            ->where('foundation_source', '!=', 'unknown')
            ->count();
        $withAbstracts = $db->table('bibliography as b')
            ->join('library as l', 'l.book', '=', 'b.foundation_source')
            ->where('b.book', $bookId)
            ->whereNotNull('l.abstract')
            ->count();
        $withContent = $db->table('bibliography as b')
            ->join('library as l', 'l.book', '=', 'b.foundation_source')
            ->where('b.book', $bookId)
            ->where('l.has_nodes', true)
            ->count();

        $this->info('Pre-flight:');
        $this->line("  Bibliography entries:     {$bibTotal}");
        $this->line("  Resolved sources:         {$resolved}/{$bibTotal}  " . ($resolved > 0 ? '<fg=green>(scan-bibliography ✓)</>' : '<fg=red>(scan-bibliography not run)</>'));
        $this->line("  Sources with abstracts:   {$withAbstracts}/{$resolved}");
        $this->line("  Sources with content:     {$withContent}/{$resolved}  " . ($withContent > 0 ? '(vacuum/ocr ✓)' : ''));
        $this->newLine();

        if ($resolved === 0) {
            $this->error('No resolved sources. Run citation:scan-bibliography first.');
            return 1;
        }

        // Run pipeline with progress output
        $onProgress = function (string $phase, string $message) {
            $this->line("  <fg=cyan>[{$phase}]</> {$message}");
        };

        // Reset LLM usage tracking before the review
        $reviewService->getLlm()->resetUsageStats();

        $result = $reviewService->review($bookId, $onProgress);
        $claims = $result['claims'];
        $stats = $result['stats'];

        // Capture LLM usage and pipeline ID for the appendix
        $stats['llm_usage'] = $reviewService->getLlm()->getUsageStats();
        if ($this->option('pipeline-id')) {
            $stats['pipeline_id'] = $this->option('pipeline-id');
        }

        if (empty($claims)) {
            $this->warn('No claims were extracted.');
            return 0;
        }

        // Print summary
        $this->newLine();
        $this->info('Citation Review Summary:');

        $unverifiedCount = 0;
        $confirmedCount = 0;
        $likelyCount = 0;
        $plausibleCount = 0;
        $unlikelyCount = 0;
        $rejectedCount = 0;
        $noEvidenceCount = 0;

        foreach ($claims as $claim) {
            if (empty($claim['source_book_id'])) {
                $unverifiedCount++;
                continue;
            }
            $support = $claim['llm_verdict']['support'] ?? 'insufficient';
            match ($support) {
                'confirmed'  => $confirmedCount++,
                'likely'     => $likelyCount++,
                'plausible'  => $plausibleCount++,
                'unlikely'   => $unlikelyCount++,
                'rejected'   => $rejectedCount++,
                default      => $noEvidenceCount++,
            };
        }

        $this->line("  <fg=red>Rejected:</>        {$rejectedCount}");
        $this->line("  <fg=#e67e22>Unlikely:</>        {$unlikelyCount}");
        $this->line("  <fg=magenta>Unverified:</>      {$unverifiedCount}");
        $this->line("  <fg=yellow>No evidence:</>     {$noEvidenceCount}");
        $this->line("  <fg=blue>Plausible:</>       {$plausibleCount}");
        $this->line("  <fg=#a3d977>Likely:</>          {$likelyCount}");
        $this->line("  <fg=green>Confirmed:</>       {$confirmedCount}");

        // Save reports
        $timestamp = now()->format('Y-m-d_His');

        $jsonFilename = "citation-review_{$bookId}_{$timestamp}.json";
        Storage::put($jsonFilename, json_encode($claims, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        $mdFilename = "citation-review_{$bookId}_{$timestamp}.md";
        $md = $reviewService->buildMarkdownReport($claims, $bookId, $book->title ?? $bookId, $stats);
        Storage::put($mdFilename, $md);

        $this->newLine();
        $this->info("JSON report: " . storage_path("app/{$jsonFilename}"));
        $this->info("Markdown report: " . storage_path("app/{$mdFilename}"));

        // Import as sub-book
        $this->info('Importing report as sub-book...');
        $subBookId = $reviewService->importReportAsSubBook($md, $bookId, $book->title ?? $bookId);
        $this->info("AI Review sub-book: {$subBookId}");
        $this->info("View at: " . config('app.url') . "/{$bookId}/AIreview");

        // Bill the book creator for this review
        $creator = \App\Models\User::on('pgsql_admin')->where('name', $book->creator)->first();

        if ($creator) {
            $this->billReview($creator, $bookId, $book->title ?? $bookId, $stats);
        }

        // Send completion email to book creator
        if ($creator?->email) {
            $appUrl = config('app.url');
            \Illuminate\Support\Facades\Mail::send('emails.citation-review', [
                'logoUrl'       => url('/images/logoc.png'),
                'bookTitle'     => $book->title ?? $bookId,
                'reviewUrl'     => "{$appUrl}/{$bookId}/AIreview",
                'bookUrl'       => "{$appUrl}/{$bookId}",
                'confirmed'     => $confirmedCount,
                'likely'        => $likelyCount,
                'plausible'     => $plausibleCount,
                'unlikely'      => $unlikelyCount,
                'rejected'      => $rejectedCount,
                'unverified'    => $unverifiedCount,
                'sourcesFound'  => $stats['sources_with_content'] ?? 0,
                'sourcesTotal'  => $stats['unique_sources'] ?? 0,
                'citationCount' => $stats['citation_occurrences'] ?? 0,
            ], function ($message) use ($creator) {
                $message->to($creator->email)->subject('AI Citation Review Complete');
            });
            $this->info("Notification sent to {$creator->email}");
        }

        return 0;
    }

    /**
     * Calculate costs and create a billing ledger entry for the citation review.
     */
    private function billReview(\App\Models\User $user, string $bookId, string $bookTitle, array $stats): void
    {
        try {
            $billing = app(BillingService::class);
            $pricing = config('services.llm.pricing', []);
            $lineItems = [];
            $totalCost = 0.0;

            // OCR line item — get page count from pipeline step_timings
            $pipelineId = $stats['pipeline_id'] ?? null;
            $ocrTotalPages = 0;

            if ($pipelineId) {
                $pipeline = DB::connection('pgsql_admin')
                    ->table('citation_pipelines')
                    ->where('id', $pipelineId)
                    ->first();

                if ($pipeline && $pipeline->step_timings) {
                    $stepTimings = json_decode($pipeline->step_timings, true);
                    $ocrTotalPages = $stepTimings['ocr']['total_pages'] ?? 0;
                }
            }

            if ($ocrTotalPages > 0) {
                $ocrPricing = $pricing['mistral-ocr-latest'] ?? null;
                if ($ocrPricing && isset($ocrPricing['per_1k_pages'])) {
                    $ocrCost = $ocrTotalPages / 1000 * $ocrPricing['per_1k_pages'];
                    $totalCost += $ocrCost;
                    $lineItems[] = [
                        'label'     => "OCR ({$ocrTotalPages} pages)",
                        'category'  => 'ocr',
                        'quantity'  => $ocrTotalPages,
                        'unit'      => 'pages',
                        'unit_cost' => $ocrPricing['per_1k_pages'] / 1000,
                        'amount'    => round($ocrCost, 4),
                    ];
                }
            }

            // LLM line items — per-model breakdown
            $llmUsage = $stats['llm_usage'] ?? null;
            if ($llmUsage && !empty($llmUsage['by_model'])) {
                foreach ($llmUsage['by_model'] as $model => $usage) {
                    $prompt = $usage['prompt_tokens'] ?? 0;
                    $completion = $usage['completion_tokens'] ?? 0;
                    $totalTokens = $prompt + $completion;

                    $modelPricing = $pricing[$model] ?? null;
                    if ($modelPricing && isset($modelPricing['input'], $modelPricing['output'])) {
                        $cost = ($prompt / 1_000_000 * $modelPricing['input'])
                              + ($completion / 1_000_000 * $modelPricing['output']);
                        $totalCost += $cost;

                        $shortName = basename($model);
                        $lineItems[] = [
                            'label'     => "{$shortName} (" . number_format($totalTokens) . " tokens)",
                            'category'  => 'llm',
                            'quantity'  => $totalTokens,
                            'unit'      => 'tokens',
                            'unit_cost' => $totalTokens > 0 ? round($cost / $totalTokens, 8) : 0,
                            'amount'    => round($cost, 4),
                            'meta'      => [
                                'model'             => $model,
                                'prompt_tokens'     => $prompt,
                                'completion_tokens'  => $completion,
                            ],
                        ];
                    }
                }
            }

            if ($totalCost <= 0) {
                return;
            }

            $billing->charge(
                $user,
                round($totalCost, 4),
                "Citation Review: {$bookTitle}",
                'ai_review',
                $lineItems,
                ['book' => $bookId, 'pipeline_id' => $pipelineId],
            );

            $this->info("Billed \$" . number_format($totalCost, 2) . " to {$user->name}");
        } catch (\Throwable $e) {
            Log::error('Failed to bill citation review', [
                'book'  => $bookId,
                'user'  => $user->id,
                'error' => $e->getMessage(),
            ]);
            $this->warn("Billing failed: {$e->getMessage()}");
        }
    }
}
