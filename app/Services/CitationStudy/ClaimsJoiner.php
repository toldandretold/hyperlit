<?php

namespace App\Services\CitationStudy;

use Illuminate\Support\Facades\DB;

/**
 * Joins each book's claims JSON with its ground truth, pipeline timings, and
 * billing rows into one flat row per citation occurrence — the dataset the
 * paper's statistics run on.
 *
 * Join discipline is bidirectional: a ground-truth positive with no claims
 * row is emitted as verdict 'not_detected_missing' (a miss by omission, not a
 * data-cleaning problem), and a claims row with no specific label falls back
 * to the book's default label. Both directions are surfaced in diagnostics.
 */
class ClaimsJoiner
{
    // Must stay byte-identical to the literal in ClaimVerifier (pinned by
    // UpgradeMarkerPinTest) — it is how the pre-upgrade verdict is recovered.
    public const UPGRADE_MARKER = ' [Upgraded from "rejected" by rejection review: topical connection detected]';

    private const SNIPPET_JACCARD_FLOOR = 0.35;

    /**
     * @return array{rows: array[], diagnostics: array}
     */
    public function join(CorpusManifest $manifest, array $state, ?string $runId = null): array
    {
        $rows = [];
        $diagnostics = ['books' => [], 'orphan_gt' => [], 'defaulted_claims' => [], 'skipped_books' => []];

        foreach ($manifest->books() as $book) {
            $slug = $book['slug'];
            $bookState = $this->recordForRun($state['books'][$slug] ?? null, $runId);
            if (!$bookState || ($bookState['status'] ?? null) !== 'completed' || empty($bookState['claims_file'])) {
                $diagnostics['skipped_books'][] = $slug;
                continue;
            }

            $claims = json_decode((string) file_get_contents($bookState['claims_file']), true) ?: [];
            $groundTruth = $manifest->loadGroundTruth($book);

            // An unbound ground truth joins to nothing: every citation would
            // read as a phantom "missed" positive and every claim would fall
            // back to the default label. That is a broken dataset, not a
            // finding — fail loudly and tell the operator to rebind.
            $bound = count(array_filter(array_column($groundTruth['entries'], 'bound_reference_id')));
            if ($bound === 0) {
                throw new \RuntimeException(
                    "'{$slug}': ground truth has no bindings (run citation:study:import to rebind) — "
                    . 'joining it would produce phantom misses.'
                );
            }
            $bookMeta = $this->bookMeta($manifest, $book, $bookState, count($claims));

            [$bookRows, $bookDiag] = $this->joinBook($book, $claims, $groundTruth, $bookMeta);
            $rows = array_merge($rows, $bookRows);
            $diagnostics['books'][$slug] = $bookDiag;
            $diagnostics['orphan_gt'] = array_merge($diagnostics['orphan_gt'], $bookDiag['orphan_gt']);
            $diagnostics['defaulted_claims'] = array_merge($diagnostics['defaulted_claims'], $bookDiag['defaulted_claims']);
        }

        return ['rows' => $rows, 'diagnostics' => $diagnostics];
    }

    /**
     * The state record for a book at a given run: the latest record, or a
     * completed earlier run archived in its history (cold-vs-warm re-runs).
     */
    private function recordForRun(?array $bookState, ?string $runId): ?array
    {
        if ($bookState === null) {
            return null;
        }
        if ($runId === null || ($bookState['run_id'] ?? null) === $runId) {
            return $bookState;
        }
        foreach ($bookState['history'] ?? [] as $past) {
            if (($past['run_id'] ?? null) === $runId) {
                return $past;
            }
        }
        return null;
    }

    private function joinBook(array $book, array $claims, array $groundTruth, array $bookMeta): array
    {
        $slug = $book['slug'];
        $defaultLabel = $book['default_label'] ?? 'intact';

        $bibLevel = [];   // referenceId => gt entry
        $snippetLevel = []; // referenceId => [gt entries]
        foreach ($groundTruth['entries'] as $entry) {
            $ref = $entry['bound_reference_id'] ?? null;
            if ($ref === null) {
                continue;
            }
            if (($entry['claim_snippet'] ?? null) !== null) {
                $snippetLevel[$ref][] = $entry;
            } else {
                $bibLevel[$ref] = $entry;
            }
        }

        $rows = [];
        $matchedGtIds = [];
        $defaultedClaims = [];

        foreach ($claims as $claim) {
            $ref = $claim['referenceId'] ?? null;
            $gt = $this->resolveLabel($claim, $ref, $bibLevel, $snippetLevel);
            if ($gt !== null) {
                $matchedGtIds[$gt['gt_id']] = true;
            } else {
                $defaultedClaims[] = "{$slug}:{$ref}";
            }
            $rows[] = $this->row($bookMeta, $claim, $gt, $defaultLabel);
        }

        // Ground-truth entries that expected citation occurrences but matched
        // no claims row: emitted as misses so denominators stay honest.
        $orphans = [];
        foreach ($groundTruth['entries'] as $entry) {
            if (isset($matchedGtIds[$entry['gt_id']])) {
                continue;
            }
            if ((int) ($entry['cited_occurrences'] ?? 0) < 1) {
                continue; // never cited in text — legitimately absent from claims
            }
            $orphans[] = $entry['gt_id'];
            $rows[] = $this->row($bookMeta, null, $entry, $defaultLabel);
        }

        return [$rows, [
            'claims' => count($claims),
            'orphan_gt' => $orphans,
            'defaulted_claims' => $defaultedClaims,
        ]];
    }

    /** Snippet-level match first (swap/distortion), then bib-level. */
    private function resolveLabel(array $claim, ?string $ref, array $bibLevel, array $snippetLevel): ?array
    {
        if ($ref === null) {
            return null;
        }
        $claimText = trim(($claim['truth_claim'] ?? '') . ' ' . ($claim['contextualised_claim'] ?? ''));
        if (isset($snippetLevel[$ref]) && $claimText !== '') {
            $normClaim = GroundTruthText::normalise($claimText);
            $best = null;
            $bestScore = 0.0;
            foreach ($snippetLevel[$ref] as $entry) {
                $snippet = $entry['claim_snippet'];
                if ($snippet !== '' && (str_contains($normClaim, $snippet) || str_contains($snippet, $normClaim))) {
                    return $entry;
                }
                $score = GroundTruthText::jaccard($normClaim, $snippet);
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $best = $entry;
                }
            }
            if ($best !== null && $bestScore >= self::SNIPPET_JACCARD_FLOOR) {
                return $best;
            }
        }
        return $bibLevel[$ref] ?? null;
    }

    private function row(array $bookMeta, ?array $claim, ?array $gt, string $defaultLabel): array
    {
        $verdict = 'not_detected_missing';
        $preUpgrade = 'not_detected_missing';
        $wasUpgraded = false;
        $sourceFound = null;

        if ($claim !== null) {
            $support = $claim['llm_verdict']['support'] ?? null;
            $sourceFound = !empty($claim['source_book_id']);
            $verdict = $sourceFound ? ($support ?? 'insufficient') : 'source_not_found';
            $reasoning = $claim['llm_verdict']['reasoning'] ?? '';
            $wasUpgraded = is_string($reasoning) && str_contains($reasoning, self::UPGRADE_MARKER);
            $preUpgrade = $wasUpgraded ? 'rejected' : $verdict;
        }

        return array_merge($bookMeta, [
            'gt_id' => $gt['gt_id'] ?? null,
            'gt_label' => $gt['label'] ?? $defaultLabel,
            'corruption_type' => $gt['corruption_meta']['type'] ?? null,
            'expected_detection' => $gt['expected_detection'] ?? null,
            'referenceId' => $claim['referenceId'] ?? ($gt['bound_reference_id'] ?? null),
            'node_id' => $claim['node_id'] ?? null,
            'citation_row' => $claim['citation_row'] ?? null,
            'verdict' => $verdict,
            'verdict_pre_upgrade' => $preUpgrade,
            'was_upgraded' => $wasUpgraded,
            'source_found' => $sourceFound,
            'evidence_type' => $claim['evidence_type'] ?? null,
            'verification_tier' => $claim['verification_tier'] ?? null,
            'web_status' => $claim['web_status'] ?? null,
            'match_method' => $claim['match_method'] ?? null,
            'match_score' => $claim['match_score'] ?? null,
            'source_completeness' => $claim['source_completeness'] ?? null,
            'truth_claim_chars' => isset($claim['truth_claim']) ? mb_strlen((string) $claim['truth_claim']) : null,
            'source_material_chars' => isset($claim['source_material_sent']) ? mb_strlen((string) $claim['source_material_sent']) : null,
            'has_highlight' => $claim['has_highlight'] ?? null,
            'verdict_summary' => $claim['llm_verdict']['summary'] ?? null,
        ]);
    }

    private function bookMeta(CorpusManifest $manifest, array $book, array $bookState, int $claimCount): array
    {
        $pipelineId = $bookState['pipeline_id'] ?? null;
        $timings = $this->stepTimings($pipelineId);
        $billing = $this->billing($pipelineId);

        $totalSeconds = null;
        foreach ($timings['steps'] as $step) {
            if (($step['duration_seconds'] ?? null) !== null) {
                $totalSeconds = ($totalSeconds ?? 0) + $step['duration_seconds'];
            }
        }

        return [
            'corpus' => $manifest->corpus,
            'run_id' => $bookState['run_id'] ?? null,
            'book_id' => $bookState['book_id'],
            'slug' => $book['slug'],
            'arm' => $book['arm'],
            'pipeline_id' => $pipelineId,
            'claims_in_book' => $claimCount,
            'book_review_seconds' => $timings['steps']['review']['duration_seconds'] ?? null,
            'book_total_seconds' => $totalSeconds,
            'book_wall_seconds' => $timings['wall_seconds'],
            'book_cost_usd' => $billing['total'],
            'book_prompt_tokens' => $billing['prompt_tokens'],
            'book_completion_tokens' => $billing['completion_tokens'],
            'book_ocr_pages' => $timings['steps']['ocr']['total_pages'] ?? null,
            'cost_per_citation' => ($billing['total'] !== null && $claimCount > 0)
                ? round($billing['total'] / $claimCount, 6)
                : null,
            'contaminated' => !empty($bookState['contamination']),
        ];
    }

    /** @return array{steps: array, wall_seconds: ?int} */
    public function stepTimings(?string $pipelineId): array
    {
        if (!$pipelineId) {
            return ['steps' => [], 'wall_seconds' => null];
        }
        $pipeline = DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $pipelineId)
            ->first(['step_timings', 'created_at', 'updated_at']);
        if (!$pipeline) {
            return ['steps' => [], 'wall_seconds' => null];
        }
        $steps = $pipeline->step_timings ? (json_decode($pipeline->step_timings, true) ?: []) : [];
        $wall = null;
        if ($pipeline->created_at && $pipeline->updated_at) {
            $wall = strtotime($pipeline->updated_at) - strtotime($pipeline->created_at);
        }
        return ['steps' => $steps, 'wall_seconds' => $wall];
    }

    /**
     * Per-review-substage wall seconds from the telemetry event stream
     * (consecutive-event deltas attributed to the earlier event's substage).
     */
    public function reviewSubstageSeconds(?string $pipelineId): array
    {
        if (!$pipelineId) {
            return [];
        }
        $raw = DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $pipelineId)
            ->value('telemetry');
        $events = $raw ? (json_decode($raw, true) ?: []) : [];

        $durations = [];
        $prev = null;
        foreach ($events as $event) {
            if (($event['stage'] ?? null) !== 'review' || empty($event['at'])) {
                continue;
            }
            if ($prev !== null) {
                $delta = strtotime($event['at']) - strtotime($prev['at']);
                if ($delta >= 0) {
                    $key = $prev['substage'] ?? 'unknown';
                    $durations[$key] = ($durations[$key] ?? 0) + $delta;
                }
            }
            $prev = $event;
        }
        return $durations;
    }

    /** @return array{total: ?float, prompt_tokens: ?int, completion_tokens: ?int, line_items: array} */
    public function billing(?string $pipelineId): array
    {
        $empty = ['total' => null, 'prompt_tokens' => null, 'completion_tokens' => null, 'line_items' => []];
        if (!$pipelineId) {
            return $empty;
        }
        $rows = DB::connection('pgsql_admin')
            ->table('billing_ledger')
            ->where('category', 'ai_review')
            ->whereRaw("metadata->>'pipeline_id' = ?", [$pipelineId])
            ->get(['amount', 'line_items']);
        if ($rows->isEmpty()) {
            return $empty;
        }

        $total = 0.0;
        $prompt = 0;
        $completion = 0;
        $lineItems = [];
        foreach ($rows as $row) {
            $total += (float) $row->amount;
            $items = $row->line_items ? (json_decode($row->line_items, true) ?: []) : [];
            foreach ($items as $item) {
                $lineItems[] = $item;
                $prompt += (int) ($item['meta']['prompt_tokens'] ?? 0);
                $completion += (int) ($item['meta']['completion_tokens'] ?? 0);
            }
        }
        return [
            'total' => round($total, 4),
            'prompt_tokens' => $prompt,
            'completion_tokens' => $completion,
            'line_items' => $lineItems,
        ];
    }
}
