<?php

namespace App\Services\CitationReview\Phases;

use App\Services\LlmService;
use Illuminate\Support\Facades\Log;

/**
 * Phase 5 of the citation review: verify each claim against the gathered
 * evidence via concurrent LLM batches. Three sub-phases: validate abstracts,
 * derive the evidence type + build source material and verify each claim, then
 * re-review 'rejected' verdicts to catch false negatives (upgrading to
 * 'unlikely' when a topical connection is found). Mutates each claim's
 * 'evidence_type', 'source_material_sent' and 'llm_verdict' in place.
 *
 * Extracted verbatim from CitationReviewService::verifyClaims. Progress is
 * reported through a message-only $emit callback (the coordinator binds the
 * 'verify' phase key), keeping the $progress('verify') literal out of this file.
 */
final class ClaimVerifier
{
    public function __construct(private LlmService $llm) {}

    public function verifyClaims(array &$claims, callable $emit): void
    {
        $total = count($claims);
        $batchSize = 30;

        // Phase A: Batch all validateAbstract calls for non-web-source claims with abstracts
        $emit("Validating abstracts...");
        $abstractItems = [];
        $abstractKeyMap = [];

        foreach ($claims as $i => $claim) {
            $isWebSource = ($claim['source_type'] ?? null) === 'web_source';
            if (!empty($claim['abstract']) && !$isWebSource) {
                $abstractKeyMap[] = $i;
                $abstractItems[] = [$claim['abstract'], $claim['source_title'] ?? ''];
            }
        }

        $abstractResults = [];
        if (!empty($abstractItems)) {
            $abstractChunks = array_chunk($abstractItems, $batchSize);
            $processedCount = 0;
            foreach ($abstractChunks as $chunkIndex => $chunk) {
                $batchResults = $this->llm->validateAbstractBatch($chunk);
                foreach ($batchResults as $j => $result) {
                    $claimIndex = $abstractKeyMap[$processedCount + $j];
                    $abstractResults[$claimIndex] = $result;
                }
                $processedCount += count($chunk);
                if ($chunkIndex < count($abstractChunks) - 1) {
                    usleep(250_000);
                }
            }
        }

        // Determine evidence types and build source material for all claims
        $verifyItems = [];
        $verifyKeyMap = [];

        foreach ($claims as $i => &$claim) {
            $hasPassages = !empty($claim['source_passages']);
            $isWebSource = ($claim['source_type'] ?? null) === 'web_source';
            $hasAbstract = false;
            if (!empty($claim['abstract'])) {
                $hasAbstract = $isWebSource || ($abstractResults[$i] ?? false);
            }

            if ($isWebSource) {
                // Web sources get their own evidence tier — content may be truncated
                if ($hasPassages) {
                    $claim['evidence_type'] = 'web_and_passages';
                } elseif ($hasAbstract) {
                    $claim['evidence_type'] = 'web_only';
                }
                // else falls through to title_only/none below
            } elseif ($hasPassages && $hasAbstract) {
                $claim['evidence_type'] = 'abstract_and_passages';
            } elseif ($hasPassages) {
                $claim['evidence_type'] = 'passages_only';
            } elseif ($hasAbstract) {
                $claim['evidence_type'] = 'abstract_only';
            }

            if ($claim['evidence_type'] === 'none') {
                if (!empty($claim['source_title'])) {
                    $claim['evidence_type'] = 'title_only';
                }
            }

            // Short-circuit: no real evidence
            if ($claim['evidence_type'] === 'none') {
                $claim['source_material_sent'] = null;
                $claim['llm_verdict'] = [
                    'support'   => 'insufficient',
                    'summary'   => 'No evidence available',
                    'reasoning' => 'No abstract or source passages available for verification.',
                ];
                continue;
            }

            // Build source material
            $sourceMaterial = '';
            $sourceHeader = array_filter([
                $claim['source_title'] ?? null,
                $claim['source_author'] ?? null,
                isset($claim['source_year']) ? "({$claim['source_year']})" : null,
            ]);
            if ($sourceHeader) {
                $sourceMaterial .= "SOURCE: " . implode(' — ', $sourceHeader) . "\n\n";
            }
            if ($hasAbstract) {
                $abstractLabel = $isWebSource
                    ? "ABSTRACT (scraped from web — may be truncated)"
                    : "ABSTRACT (summary only — does NOT represent the full text)";
                $sourceMaterial .= "{$abstractLabel}:\n{$claim['abstract']}\n\n";
            }
            if ($hasPassages) {
                $count = count($claim['source_passages']);
                $sourceMaterial .= "PASSAGES FROM SOURCE TEXT ({$count} excerpts found by search — the source contains far more text than shown here):\n";
                foreach ($claim['source_passages'] as $j => $p) {
                    $sourceMaterial .= "--- Passage " . ($j + 1) . " ---\n{$p['text']}\n\n";
                }
            }

            $claim['source_material_sent'] = trim($sourceMaterial) ?: null;

            $verifyKeyMap[] = $i;
            $verifyItems[] = [
                $claim['contextualised_claim'] ?? $claim['truth_claim'],
                $sourceMaterial,
                $claim['evidence_type'],
            ];
        }
        unset($claim);

        // Phase B: Batch all verifyCitation calls
        if (!empty($verifyItems)) {
            $verifyChunks = array_chunk($verifyItems, $batchSize);
            $verifyKeyChunks = array_chunk($verifyKeyMap, $batchSize);

            foreach ($verifyChunks as $chunkIndex => $chunk) {
                $chunkStart = $chunkIndex * $batchSize;
                $emit("Verifying claims " . ($chunkStart + 1) . "-" . ($chunkStart + count($chunk)) . " of " . count($verifyItems) . "...");

                $batchResults = $this->llm->verifyCitationBatch($chunk);

                foreach ($batchResults as $j => $verdict) {
                    $claimIndex = $verifyKeyChunks[$chunkIndex][$j];

                    if ($verdict === null) {
                        $claims[$claimIndex]['llm_verdict'] = [
                            'support'   => 'insufficient',
                            'summary'   => 'LLM verification failed',
                            'reasoning' => 'The verification model did not return a valid response.',
                        ];
                    } else {
                        $claims[$claimIndex]['llm_verdict'] = $verdict;
                    }
                }

                if ($chunkIndex < count($verifyChunks) - 1) {
                    usleep(250_000);
                }
            }
        }

        // Phase C: Review rejected verdicts for false rejections
        $rejectedItems = [];
        $rejectedKeyMap = [];

        foreach ($claims as $i => $claim) {
            if (($claim['llm_verdict']['support'] ?? null) === 'rejected') {
                $sourceDesc = implode(' — ', array_filter([
                    $claim['source_title'] ?? null,
                    $claim['source_author'] ?? null,
                    isset($claim['source_year']) ? "({$claim['source_year']})" : null,
                ]));
                if (!$sourceDesc) {
                    continue;
                }
                $rejectedKeyMap[] = $i;
                $rejectedItems[] = [
                    $sourceDesc,
                    $claim['contextualised_claim'] ?? $claim['truth_claim'],
                ];
            }
        }

        if (!empty($rejectedItems)) {
            $emit("Reviewing " . count($rejectedItems) . " rejected verdicts for false rejections...");

            $reviewResults = $this->llm->reviewRejectionBatch($rejectedItems);

            $upgraded = 0;
            foreach ($reviewResults as $j => $isConnected) {
                if ($isConnected) {
                    $claimIndex = $rejectedKeyMap[$j];
                    $claims[$claimIndex]['llm_verdict']['support'] = 'unlikely';
                    $claims[$claimIndex]['llm_verdict']['reasoning'] =
                        ($claims[$claimIndex]['llm_verdict']['reasoning'] ?? '') .
                        ' [Upgraded from "rejected" by rejection review: topical connection detected]';
                    $upgraded++;

                    Log::info('Rejection review: upgraded to unlikely', [
                        'source' => $rejectedItems[$j][0],
                        'claim'  => mb_substr($rejectedItems[$j][1], 0, 120),
                    ]);
                }
            }

            if ($upgraded > 0) {
                $emit("Rejection review: upgraded {$upgraded} of " . count($rejectedItems) . " rejected verdicts to unlikely");
            }
        }

    }
}
