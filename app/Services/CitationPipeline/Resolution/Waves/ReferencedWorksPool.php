<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use Illuminate\Support\Facades\Log;

/**
 * Closed-pool match against the parent work's referenced_works (old Wave 3.5).
 *
 * When the scanned book is itself linked to a canonical with an openalex_id (always true for
 * harvested auto-versions), OpenAlex already knows the CLOSED SET of works it cites. Scoring the
 * still-unresolved entries against that pool is cheaper and more precise than open title search
 * — especially for noisy OCR'd bibliographies, where a garbled title that would search badly
 * still scores best against the one work in the pool it actually is.
 *
 * Same accept gates as the open OpenAlex search — the closed pool raises precision, it does not
 * lower the bar. Entries the pool misses fall through to the normal waves unchanged.
 */
class ReferencedWorksPool implements ResolutionWave
{
    public function id(): string
    {
        return 'referenced_works_pool';
    }

    public function title(): string
    {
        return 'Closed pool from the parent work\'s own reference list';
    }

    public function plain(): string
    {
        return 'When this document is itself indexed, the index already lists exactly which works '
            . 'it cites — so we matched the remaining citations against that closed list before '
            . 'searching the open web.';
    }

    public function dev(): string
    {
        return 'parentWorkOpenAlexId → fetchReferencedWorkIds → fetchByIdsBatch, then every '
            . 'unresolved entry is scored against the whole pool (isCitableWork per candidate; '
            . 'metadataScore\'s title floor rejects most cheaply). Accept: same gates as the open '
            . 'OpenAlex search. match_method: openalex_referenced.';
    }

    public function entryGate(): string
    {
        return 'The scanned book has an OpenAlex identity whose referenced_works list is non-empty.';
    }

    public function acceptGate(): string
    {
        return 'Best citable pool work > 0.3, clears the title floor, no year-mismatch rejection.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        $parentOpenAlexId = $ctx->host->parentWorkOpenAlexId($ctx->db);
        $referencedIds = $parentOpenAlexId ? $ctx->openAlex->fetchReferencedWorkIds($parentOpenAlexId) : [];
        if (empty($referencedIds)) {
            return;
        }

        Log::info('Wave 3.5: referenced_works closed pool', [
            'parent'     => $parentOpenAlexId,
            'referenced' => count($referencedIds),
            'remaining'  => count($ctx->pool),
        ]);
        $poolWorks = $ctx->openAlex->fetchByIdsBatch($referencedIds);

        foreach ($ctx->pool as $refId => $item) {
            if (!$item['searchedTitle']) {
                continue;
            }

            $bestMatch = null;
            $bestScore = 0.0;
            $bestDiagnostics = null;
            foreach ($poolWorks as $candidate) {
                if (!$ctx->openAlex->isCitableWork($candidate)) {
                    continue;
                }
                // metadataScore's title floor rejects (and skips logging) most of the pool
                // cheaply per entry.
                $scoreResult = $item['llmMetadata']
                    ? $ctx->openAlex->metadataScore($item['llmMetadata'], $candidate)
                    : ['score' => $ctx->openAlex->titleSimilarity($item['searchedTitle'], $candidate['title'] ?? '')];
                if ($scoreResult['score'] > $bestScore) {
                    $bestScore = $scoreResult['score'];
                    $bestMatch = $candidate;
                    $bestDiagnostics = $scoreResult;
                }
            }

            // Same accept gates as Wave 4 — the closed pool raises precision, it doesn't
            // lower the bar.
            if (
                $bestMatch && $bestScore > 0.3
                && $ctx->host->hasTitleConfidence($bestDiagnostics, $bestScore)
                && !$ctx->host->hasYearMismatchRejection($item['llmMetadata'], $bestMatch, $bestScore)
            ) {
                $result = $ctx->host->resolveWithNormalised($item, $bestMatch, 'openalex_referenced', round($bestScore, 3), $ctx->openAlex, $ctx->db, $bestDiagnostics);
                if ($result) {
                    $ctx->recordResult($result);
                    $ctx->host->removeRelatedPoolEntries($ctx->pool, $refId, $ctx->db, $result['foundation_book_id'] ?? null);
                    continue;
                }
            }

            if ($bestMatch && $bestScore > ($ctx->nearMisses[$refId]['score'] ?? 0.0)) {
                $ctx->nearMisses[$refId] = [
                    'score'       => round($bestScore, 3),
                    'title'       => $bestMatch['title'] ?? null,
                    'author'      => $bestMatch['author'] ?? null,
                    'year'        => $bestMatch['year'] ?? null,
                    'source'      => 'openalex_referenced',
                    'diagnostics' => $bestDiagnostics,
                ];
            }
            $ctx->waveResults[$refId]['openalex_referenced'] = $bestMatch
                ? 'best_score:' . round($bestScore, 3)
                : 'no_candidates';
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 3.5';
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
