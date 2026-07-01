<?php

namespace App\Services\CitationReview\Report;

use App\Services\CitationReview\Support\DurationFormatter;

/**
 * Builds the "Appendix: Pipeline Diagnostics" section of the review report —
 * timing, bibliography resolution, evidence availability, LLM/OCR usage & cost,
 * and the model roster. Receives the pgsql_admin connection from ReportBuilder.
 *
 * Extracted verbatim from CitationReviewService::buildAppendixMd.
 */
final class AppendixBuilder
{
    public function __construct(private DurationFormatter $durations) {}

    public function buildAppendixMd(array $claims, string $bookId, array $stats, $db): string
    {
        $md = "\n# Appendix: Pipeline Diagnostics\n\n";

        // --- Timing (from citation_pipelines) ---
        $pipelineId = $stats['pipeline_id'] ?? null;
        $pipeline = null;

        if ($pipelineId) {
            $pipeline = $db->table('citation_pipelines')->where('id', $pipelineId)->first();
        }

        // Fallback: find the most recent completed pipeline for this book
        if (!$pipeline) {
            $pipeline = $db->table('citation_pipelines')
                ->where('book', $bookId)
                ->whereIn('status', ['completed', 'running'])
                ->orderByDesc('created_at')
                ->first();
        }

        $stepTimings = null;

        if ($pipeline) {
            $started = $pipeline->created_at ?? null;
            $completed = $pipeline->updated_at ?? null;

            $md .= "## Timing\n\n";
            $md .= "| Metric | Value |\n|--------|-------|\n";

            if ($started && $completed) {
                $startTime = \Carbon\Carbon::parse($started);
                $endTime = \Carbon\Carbon::parse($completed);
                $diffSeconds = $startTime->diffInSeconds($endTime);
                $md .= "| Total duration | " . $this->durations->format($diffSeconds) . " |\n";
            }
            if ($started) {
                $md .= "| Started | {$started} |\n";
            }
            if ($completed) {
                $md .= "| Completed | {$completed} |\n";
            }

            $md .= "\n";

            // Step timings
            $stepTimings = isset($pipeline->step_timings) ? json_decode($pipeline->step_timings, true) : null;
            if (!empty($stepTimings)) {
                $stepLabels = [
                    'bibliography' => 'Bibliography scan',
                    'content'      => 'Content scan',
                    'vacuum'       => 'Vacuum (fetch)',
                    'ocr'          => 'OCR',
                    'review'       => 'Review',
                ];

                $md .= "## Step Timings\n\n";
                $md .= "| Step | Duration |\n|------|----------|\n";

                foreach ($stepLabels as $key => $label) {
                    if (isset($stepTimings[$key]['duration_seconds'])) {
                        $md .= "| {$label} | " . $this->durations->format($stepTimings[$key]['duration_seconds']) . " |\n";
                    } elseif (isset($stepTimings[$key])) {
                        $md .= "| {$label} | N/A |\n";
                    }
                }

                $md .= "\n";
            }
        }

        // --- Bibliography Resolution (from citation_scans) ---
        $scan = $db->table('citation_scans')
            ->where('book', $bookId)
            ->whereIn('status', ['completed', 'running'])
            ->orderByDesc('created_at')
            ->first();

        if ($scan) {
            $md .= "## Bibliography Resolution\n\n";
            $md .= "| Metric | Count |\n|--------|-------|\n";
            $md .= "| Total entries | {$scan->total_entries} |\n";
            $md .= "| Already linked | {$scan->already_linked} |\n";
            $md .= "| Newly resolved | {$scan->newly_resolved} |\n";
            $md .= "| Enriched existing | {$scan->enriched_existing} |\n";
            $md .= "| Failed to resolve | {$scan->failed_to_resolve} |\n";
            $md .= "\n";

            // Resolution Methods breakdown from results JSONB
            $results = isset($scan->results) ? json_decode($scan->results, true) : null;
            if (!empty($results)) {
                $methodCounts = [];
                foreach ($results as $r) {
                    $method = $r['match_method'] ?? null;
                    if ($method) {
                        $methodCounts[$method] = ($methodCounts[$method] ?? 0) + 1;
                    }
                }

                if (!empty($methodCounts)) {
                    arsort($methodCounts);

                    $methodLabels = [
                        'local_doi'          => 'Local DOI',
                        'doi'                => 'DOI (OpenAlex)',
                        'library'            => 'Local library',
                        'openalex'           => 'OpenAlex (title search)',
                        'open_library'       => 'Open Library',
                        'semantic_scholar'   => 'Semantic Scholar',
                        'web_fetch'          => 'Web fetch',
                        'brave_search'       => 'Brave Search',
                    ];

                    $md .= "## Resolution Methods\n\n";
                    $md .= "| Method | Count |\n|--------|-------|\n";

                    foreach ($methodCounts as $method => $count) {
                        $label = $methodLabels[$method] ?? $method;
                        $md .= "| {$label} | {$count} |\n";
                    }

                    $md .= "\n";
                }
            }
        }

        // --- Evidence Available for Verification (from $claims) ---
        $evidenceCounts = [];
        foreach ($claims as $claim) {
            $type = $claim['evidence_type'] ?? 'none';
            $evidenceCounts[$type] = ($evidenceCounts[$type] ?? 0) + 1;
        }

        if (!empty($evidenceCounts)) {
            $evidenceLabels = [
                'abstract_and_passages' => 'Abstract + passages',
                'abstract_only'         => 'Abstract only',
                'passages_only'         => 'Passages only',
                'web_and_passages'      => 'Web + passages',
                'web_only'              => 'Web only',
                'title_only'            => 'Title only',
                'none'                  => 'None',
            ];

            // Sort by count descending
            arsort($evidenceCounts);

            $md .= "## Evidence Available for Verification\n\n";
            $md .= "| Evidence Type | Claims |\n|---------------|--------|\n";

            foreach ($evidenceCounts as $type => $count) {
                $label = $evidenceLabels[$type] ?? $type;
                $md .= "| {$label} | {$count} |\n";
            }

            $md .= "\n";
        }

        // --- LLM Usage (Review Step) ---
        $llmUsage = $stats['llm_usage'] ?? null;
        $pricing = config('services.llm.pricing', []);

        if ($llmUsage && ($llmUsage['total_requests'] ?? 0) > 0) {
            $md .= "## LLM Usage (Review Step)\n\n";

            // New per-model format — transposed so models are columns
            if (!empty($llmUsage['by_model'])) {
                // Collect per-model data
                $models = [];
                $totalPrompt = 0;
                $totalCompletion = 0;
                $totalCost = 0.0;
                $totalModelRequests = 0;

                foreach ($llmUsage['by_model'] as $model => $usage) {
                    $shortName = basename($model);
                    $prompt = $usage['prompt_tokens'] ?? 0;
                    $completion = $usage['completion_tokens'] ?? 0;
                    $requests = $usage['requests'] ?? 0;

                    $totalPrompt += $prompt;
                    $totalCompletion += $completion;
                    $totalModelRequests += $requests;

                    $modelPricing = $pricing[$model] ?? null;
                    if ($modelPricing && isset($modelPricing['input'], $modelPricing['output'])) {
                        $cost = ($prompt / 1_000_000 * $modelPricing['input'])
                              + ($completion / 1_000_000 * $modelPricing['output']);
                        $totalCost += $cost;
                        $costStr = '$' . number_format($cost, 2);
                    } else {
                        $cost = 0;
                        $costStr = '—';
                    }

                    $models[] = [
                        'name'       => $shortName,
                        'requests'   => number_format($requests),
                        'prompt'     => number_format($prompt),
                        'completion' => number_format($completion),
                        'cost'       => $costStr,
                    ];
                }

                $failed = $llmUsage['failed_requests'] ?? 0;
                $totalReqStr = '**' . number_format($llmUsage['total_requests']) . '**';
                if ($failed > 0) {
                    $totalReqStr .= " ({$failed} failed)";
                }

                // Build transposed table: Metric column + one column per model + Total
                $header = '| Metric |';
                $sep = '|--------|';
                foreach ($models as $m) {
                    $header .= " {$m['name']} |";
                    $sep .= '--------|';
                }
                $header .= " **Total** |";
                $sep .= '--------|';

                $md .= "{$header}\n{$sep}\n";
                $md .= '| Requests |';
                foreach ($models as $m) { $md .= " {$m['requests']} |"; }
                $md .= " {$totalReqStr} |\n";

                $md .= '| Prompt tokens |';
                foreach ($models as $m) { $md .= " {$m['prompt']} |"; }
                $md .= " **" . number_format($totalPrompt) . "** |\n";

                $md .= '| Completion tokens |';
                foreach ($models as $m) { $md .= " {$m['completion']} |"; }
                $md .= " **" . number_format($totalCompletion) . "** |\n";

                $md .= '| Est. cost |';
                foreach ($models as $m) { $md .= " {$m['cost']} |"; }
                $md .= " **\$" . number_format($totalCost, 2) . "** |\n";
            } else {
                // Backwards compatibility: old flat format
                $md .= "| Metric | Value |\n|--------|-------|\n";
                $md .= "| API requests | " . number_format($llmUsage['total_requests']) . " |\n";
                $md .= "| Failed requests | " . number_format($llmUsage['failed_requests']) . " |\n";
                $md .= "| Prompt tokens | " . number_format($llmUsage['prompt_tokens']) . " |\n";
                $md .= "| Completion tokens | " . number_format($llmUsage['completion_tokens']) . " |\n";
                $md .= "| Total tokens | " . number_format($llmUsage['prompt_tokens'] + $llmUsage['completion_tokens']) . " |\n";
            }
            $md .= "\n";
        }

        // --- OCR Cost ---
        $ocrTotalPages = $stepTimings['ocr']['total_pages'] ?? null;
        if ($ocrTotalPages !== null && $ocrTotalPages > 0) {
            $ocrPricing = $pricing['mistral-ocr-latest'] ?? null;
            $ocrCostStr = '—';
            if ($ocrPricing && isset($ocrPricing['per_1k_pages'])) {
                $ocrCost = $ocrTotalPages / 1000 * $ocrPricing['per_1k_pages'];
                $ocrCostStr = '$' . number_format($ocrCost, 2);
            }

            $md .= "## OCR\n\n";
            $md .= "| Metric | Value |\n|--------|-------|\n";
            $md .= "| Pages processed | " . number_format($ocrTotalPages) . " |\n";
            $md .= "| Est. cost | {$ocrCostStr} |\n";
            $md .= "\n";
        }

        // --- Models ---
        $metadataModel = basename(config('services.llm.model', 'unknown'));
        $extractionModel = basename(config('services.llm.extraction_model', 'unknown'));
        $verificationModel = basename(config('services.llm.verification_model', 'unknown'));
        $provider = parse_url(config('services.llm.base_url', ''), PHP_URL_HOST) ?: 'unknown';

        $md .= "## Models\n\n";
        $md .= "| Role | Model |\n|------|-------|\n";
        $md .= "| Metadata extraction | {$metadataModel} |\n";
        $md .= "| Claim extraction | {$extractionModel} |\n";
        $md .= "| Verification | {$verificationModel} |\n";
        if (config('services.mistral_ocr.api_key')) {
            $md .= "| OCR | mistral-ocr-latest |\n";
        }
        $md .= "| Provider | {$provider} |\n";
        $md .= "\n";

        return $md;
    }
}
