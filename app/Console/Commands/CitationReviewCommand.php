<?php

namespace App\Console\Commands;

use App\Services\BillingService;
use App\Services\CitationPipeline\PipelineTelemetry;
use App\Services\CitationReviewService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

class CitationReviewCommand extends Command
{
    protected $signature = 'citation:review {bookId : The book to review citations for} {--report-only : Regenerate report + highlights from latest JSON (skip LLM phases)} {--pipeline-id= : Pipeline tracking ID for appendix diagnostics} {--user-id= : User ID for billing}';
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

            $telemetry = new PipelineTelemetry($this->option('pipeline-id') ?: null);
            $onProgress = function (string $phase, string $message) use ($telemetry) {
                $this->line("  <fg=cyan>[{$phase}]</> {$message}");
                $telemetry->emit('review', 'progress', $message, [], $phase);
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
        $fnCitationTotal = $db->table('footnotes')->where('book', $bookId)
            ->where('is_citation', true)->count();
        $isFootnoteOnly = $bibTotal === 0 && $fnCitationTotal > 0;

        $resolved = $db->table('bibliography')
            ->where('book', $bookId)
            ->whereNotNull('foundation_source')
            ->where('foundation_source', '!=', 'unknown')
            ->count();

        // Add footnote resolved count for footnote-only books
        if ($isFootnoteOnly) {
            $resolved += $db->table('footnotes')
                ->where('book', $bookId)
                ->where('is_citation', true)
                ->whereNotNull('foundation_source')
                ->where('foundation_source', '!=', 'unknown')
                ->count();
        }

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

        if ($isFootnoteOnly) {
            $withAbstracts += $db->table('footnotes as f')
                ->join('library as l', 'l.book', '=', 'f.foundation_source')
                ->where('f.book', $bookId)
                ->where('f.is_citation', true)
                ->whereNotNull('l.abstract')
                ->count();
            $withContent += $db->table('footnotes as f')
                ->join('library as l', 'l.book', '=', 'f.foundation_source')
                ->where('f.book', $bookId)
                ->where('f.is_citation', true)
                ->where('l.has_nodes', true)
                ->count();
        }

        $sourceTotal = $isFootnoteOnly ? $fnCitationTotal : $bibTotal;

        $this->info('Pre-flight:');
        if ($isFootnoteOnly) {
            $this->line("  Footnote citations:      {$fnCitationTotal}");
        } else {
            $this->line("  Bibliography entries:     {$bibTotal}");
        }
        $this->line("  Resolved sources:         {$resolved}/{$sourceTotal}  " . ($resolved > 0 ? '<fg=green>(scan-bibliography ✓)</>' : '<fg=red>(scan-bibliography not run)</>'));
        $this->line("  Sources with abstracts:   {$withAbstracts}/{$resolved}");
        $this->line("  Sources with content:     {$withContent}/{$resolved}  " . ($withContent > 0 ? '(vacuum/ocr ✓)' : ''));
        $this->newLine();

        if ($resolved === 0) {
            $this->warn('No resolved sources — nothing to review.');
            $this->failPipelineRun('Citation review stopped: no resolved sources to review — the bibliography scan found nothing usable.');
            return 0;
        }

        // Run pipeline with progress output — each phase event also lands in
        // the pipeline telemetry stream (review sub-stages in the live viz).
        $telemetry = new PipelineTelemetry($this->option('pipeline-id') ?: null);
        $onProgress = function (string $phase, string $message) use ($telemetry) {
            $this->line("  <fg=cyan>[{$phase}]</> {$message}");
            $telemetry->emit('review', 'progress', $message, [], $phase);
        };

        // Reset LLM usage tracking before the review
        $reviewService->getLlm()->resetUsageStats();

        $result = $reviewService->review($bookId, $onProgress);
        $claims = $result['claims'];
        $stats = $result['stats'];
        $unmatched = $result['unmatched_citations'] ?? [];

        // Capture LLM usage and pipeline ID for the appendix
        $stats['llm_usage'] = $reviewService->getLlm()->getUsageStats();
        if ($this->option('pipeline-id')) {
            $stats['pipeline_id'] = $this->option('pipeline-id');
        }

        if (empty($claims)) {
            // Exit 0 on purpose: a non-zero exit makes the job retry, re-burning
            // the whole vacuum/OCR spend on a deterministic empty result. The
            // pipeline row is settled as failed instead (the job's 'completed'
            // update is guarded), and the notifier emails user + maintainer —
            // never again the silent "completed, no report, no email" black hole.
            $this->warn('No claims were extracted.');
            // Say HOW MUCH was missed, and keep the evidence. "No claims" on a book whose citations
            // all linked correctly is a total coverage failure, and the bare warning gave no way to
            // tell that from a book that genuinely has no citations.
            if (($stats['citation_instances'] ?? 0) > 0) {
                $this->line(sprintf(
                    '  Coverage: 0/%d citation instances reviewed — every citation in this book went unexamined.',
                    $stats['citation_instances'],
                ));
                Storage::put(
                    'citation-review_' . $bookId . '_' . now()->format('Y-m-d_His') . '.coverage.json',
                    json_encode([
                        'book' => $bookId,
                        'citation_instances' => $stats['citation_instances'],
                        'citations_matched' => 0,
                        'citations_unmatched' => $stats['citations_unmatched'] ?? $stats['citation_instances'],
                        'coverage_rate' => 0.0,
                        'unmatched_citations' => $unmatched,
                    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
                );
            }
            $this->failPipelineRun('Citation review extracted no claims — likely a citation-parsing bug on our side rather than a problem with your book.');
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

        // Coverage is a statement about THIS TOOL, so it is reported next to the verdicts rather
        // than buried: an unmatched citation carries no verdict at all, and silence reads as
        // approval unless it is named.
        if (($stats['citation_instances'] ?? 0) > 0) {
            $unmatchedCount = $stats['citations_unmatched'] ?? 0;
            $this->newLine();
            $this->line(sprintf(
                '  Coverage:         %d/%d citation instances reviewed (%.1f%%)',
                $stats['citations_matched'] ?? 0,
                $stats['citation_instances'],
                ($stats['coverage_rate'] ?? 1) * 100,
            ));
            if ($unmatchedCount > 0) {
                $this->line("  <fg=yellow>Not matched:</>      {$unmatchedCount} citation(s) produced no truth claim — NOT reviewed");
            }
        }

        // Save reports
        $timestamp = now()->format('Y-m-d_His');

        $jsonFilename = "citation-review_{$bookId}_{$timestamp}.json";
        Storage::put($jsonFilename, json_encode($claims, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        // Coverage lands in a SIDECAR, not inside the claims file: that file is a flat array of
        // claims and several consumers (the study runner, the bench, the workbench) parse it as
        // exactly that. Coverage is a fact about the claims that are MISSING, so it cannot live in
        // the list of the ones present.
        Storage::put(
            "citation-review_{$bookId}_{$timestamp}.coverage.json",
            json_encode([
                'book' => $bookId,
                'citation_instances' => $stats['citation_instances'] ?? null,
                'citations_matched' => $stats['citations_matched'] ?? null,
                'citations_unmatched' => $stats['citations_unmatched'] ?? null,
                'coverage_rate' => $stats['coverage_rate'] ?? null,
                'unmatched_citations' => $unmatched,
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
        );

        $mdFilename = "citation-review_{$bookId}_{$timestamp}.md";
        $onProgress('report', 'Building markdown report...');
        $md = $reviewService->buildMarkdownReport($claims, $bookId, $book->title ?? $bookId, $stats, $unmatched);
        $onProgress('report', 'Built markdown report (' . strlen($md) . ' bytes)');
        Storage::put($mdFilename, $md);

        $this->newLine();
        $this->info("JSON report: " . storage_path("app/{$jsonFilename}"));
        $this->info("Markdown report: " . storage_path("app/{$mdFilename}"));

        // Import as sub-book
        $this->info('Importing report as sub-book...');
        $onProgress('import', 'Publishing report sub-book...');
        $subBookId = $reviewService->importReportAsSubBook($md, $bookId, $book->title ?? $bookId);
        $onProgress('import', "Report published at /{$bookId}/AIreview");
        $this->info("AI Review sub-book: {$subBookId}");
        $this->info("View at: " . config('app.url') . "/{$bookId}/AIreview");

        // Bill the requesting user (passed from controller via --user-id) or the book creator.
        // ADMIN reads: this command usually runs inside CitationPipelineJob on a queue
        // worker, where the default connection has no RLS session vars — a default-conn
        // User::find matches zero rows and billing silently never happens (the same
        // silent-no-op class as ProcessDocumentImportJob's, fixed 2026-07).
        $billingUser = null;
        if ($this->option('user-id')) {
            $billingUser = \App\Models\User::on('pgsql_admin')->find($this->option('user-id'));
        }
        // Fallback: book creator (manual artisan runs)
        if (!$billingUser) {
            $billingUser = \App\Models\User::on('pgsql_admin')->where('name', $book->creator)->first();
        }

        if ($billingUser) {
            $this->billReview($billingUser, $bookId, $book->title ?? $bookId, $stats);
        }

        // Send completion email to book creator
        $creator = $billingUser;
        if (!$creator || $creator->name !== ($book->creator ?? null)) {
            $creator = \App\Models\User::on('pgsql_admin')->where('name', $book->creator)->first();
        }
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
     * Settle a run that produced nothing as a pipeline FAILURE (visible in the
     * viz, resumable, emailed) instead of a silent success. No-op for manual
     * artisan runs (no --pipeline-id) — the operator is watching the console.
     */
    private function failPipelineRun(string $reason): void
    {
        $pipelineId = $this->option('pipeline-id');
        if (!$pipelineId) {
            return;
        }

        (new PipelineTelemetry($pipelineId))->emit('review', 'failed', $reason);

        DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $pipelineId)
            ->update([
                'status'     => 'failed',
                'error'      => $reason,
                'updated_at' => now(),
            ]);

        app(\App\Services\CitationPipeline\PipelineFailureNotifier::class)
            ->notify($pipelineId);
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
            $isClientInference = false;

            if ($pipelineId) {
                $pipeline = DB::connection('pgsql_admin')
                    ->table('citation_pipelines')
                    ->where('id', $pipelineId)
                    ->first();

                if ($pipeline && $pipeline->step_timings) {
                    $stepTimings = json_decode($pipeline->step_timings, true);
                    $ocrTotalPages = $stepTimings['ocr']['total_pages'] ?? 0;
                }
                // BYO mode: every LLM call ran through inference tickets on the
                // user's OWN key — they already paid their provider for the
                // tokens, so we must not bill them again (matches AiBrain's
                // client-inference waiver). Server-side OCR still bills: the
                // sources were OCR'd with OUR Mistral key regardless of mode.
                $isClientInference = ($pipeline->inference_mode ?? null) === 'client';
            }

            if ($ocrTotalPages > 0) {
                $ocrPerK = BillingService::ocrPricePerKPages($stepTimings['ocr']['model'] ?? null);
                if ($ocrPerK) {
                    $ocrCost = $ocrTotalPages / 1000 * $ocrPerK;
                    $totalCost += $ocrCost;
                    $lineItems[] = [
                        'label'     => "OCR ({$ocrTotalPages} pages)",
                        'category'  => 'ocr',
                        'quantity'  => $ocrTotalPages,
                        'unit'      => 'pages',
                        'unit_cost' => $ocrPerK / 1000,
                        'amount'    => round($ocrCost, 4),
                    ];
                }
            }

            // Web-search line item — Brave requests issued during the scan's
            // resolution waves, counted by BraveSearchService and recorded into
            // step_timings by CitationPipelineCommand. Billed like OCR and NOT
            // waived under BYO: inference tickets cover the user's own LLM
            // tokens, but every Brave request ran on OUR subscription key
            // regardless of inference mode.
            $webRequests = (int) ($stepTimings['web_search']['requests'] ?? 0);
            if ($webRequests > 0) {
                $webCost = \App\Services\BraveSearchService::costForRequests($webRequests);
                if ($webCost > 0) {
                    $totalCost += $webCost;
                    $lineItems[] = [
                        'label'     => "Web search ({$webRequests} requests)",
                        'category'  => 'web_search',
                        'quantity'  => $webRequests,
                        'unit'      => 'requests',
                        'unit_cost' => round($webCost / $webRequests, 8),
                        'amount'    => round($webCost, 4),
                        'meta'      => ['provider' => $stepTimings['web_search']['provider'] ?? 'brave'],
                    ];
                }
            }

            // Browser-escalation line item — one per page the cheap fetch could
            // not read, where we spent a headless browser and residential-proxy
            // bandwidth to recover it. NOT waived under BYO for the same reason
            // as web search: inference tickets cover the user's LLM tokens, the
            // proxy subscription is ours in every mode.
            $browserFetches = (int) ($stepTimings['browser_fetch']['fetches'] ?? 0);
            if ($browserFetches > 0) {
                $browserCost = \App\Services\WebContent\WebTextAcquirer::costForBrowserFetches($browserFetches);
                if ($browserCost > 0) {
                    $totalCost += $browserCost;
                    $lineItems[] = [
                        'label'     => "Browser page fetches ({$browserFetches})",
                        'category'  => 'browser_fetch',
                        'quantity'  => $browserFetches,
                        'unit'      => 'fetches',
                        'unit_cost' => round($browserCost / $browserFetches, 8),
                        'amount'    => round($browserCost, 4),
                    ];
                }
            }

            // Managed-unblocker line item — one per SUCCESSFUL retrieval of a
            // page our own browser could not clear. Billed per success (these
            // services do not charge for failures), and not waived under BYO
            // for the same reason as web search: the subscription is ours.
            $unblockerFetches = (int) ($stepTimings['unblocker_fetch']['fetches'] ?? 0);
            if ($unblockerFetches > 0) {
                $unblockerCost = \App\Services\WebContent\WebTextAcquirer::costForUnblockerFetches($unblockerFetches);
                if ($unblockerCost > 0) {
                    $totalCost += $unblockerCost;
                    $lineItems[] = [
                        'label'     => "Unblocked page fetches ({$unblockerFetches})",
                        'category'  => 'unblocker_fetch',
                        'quantity'  => $unblockerFetches,
                        'unit'      => 'fetches',
                        'unit_cost' => round($unblockerCost / $unblockerFetches, 8),
                        'amount'    => round($unblockerCost, 4),
                    ];
                }
            }

            // LLM line items — per-model breakdown (skipped under BYO, see above)
            $llmUsage = $stats['llm_usage'] ?? null;
            if ($llmUsage && !$isClientInference && !empty($llmUsage['by_model'])) {
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

            // charge() re-reads the user on the DEFAULT connection, whose
            // users_select_policy needs BOTH app.current_user AND app.current_token.
            // In a queue worker neither is set (server-inference mode) — set them for
            // the charge and RESTORE the previous values after (this command can also
            // run inside an HTTP request or a BYO pipeline that already set them).
            $prev = DB::selectOne(
                "SELECT current_setting('app.current_user', true) AS u, current_setting('app.current_token', true) AS t"
            );
            DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
            DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
            try {
                $billing->charge(
                    $user,
                    round($totalCost, 4),
                    "Citation Review: {$bookTitle}",
                    'ai_review',
                    $lineItems,
                    ['book' => $bookId, 'pipeline_id' => $pipelineId, 'inference_mode' => $isClientInference ? 'client' : 'server'],
                );
            } finally {
                DB::statement("SELECT set_config('app.current_user', ?, false)", [$prev->u ?? '']);
                DB::statement("SELECT set_config('app.current_token', ?, false)", [$prev->t ?? '']);
            }

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
