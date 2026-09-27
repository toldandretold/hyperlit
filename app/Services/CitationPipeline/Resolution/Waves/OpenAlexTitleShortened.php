<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use Illuminate\Support\Facades\Log;

/**
 * OpenAlex retry with the shortened title (old Wave 4b) — the first PAID rung of Phase B, for
 * entries the free re-score (ShortenedTitleRestore) could not settle.
 *
 * Same OpenAlex search as the full-title wave, but querying the subtitle-stripped form and held
 * to Phase B's higher bar: 0.5 instead of 0.3, plus author-or-year confirmation, because a
 * shortened title matches every work sharing the main title. Depends on ShortenedTitleRestore
 * having stamped `shortenedTitle` onto the pool items — this wave never derives it.
 */
class OpenAlexTitleShortened implements ResolutionWave
{
    public function id(): string
    {
        return 'openalex_title_shortened';
    }

    public function title(): string
    {
        return 'OpenAlex retry with shortened title';
    }

    public function plain(): string
    {
        return 'We searched OpenAlex again using just the main title, without its subtitle, and '
            . 'accepted a match only with the author or year also agreeing.';
    }

    public function dev(): string
    {
        return 'searchBatch(shortenedTitles, limit 5, year filters from llmMetadata.year). '
            . 'isCitableWork per candidate; scoring swaps llmMetadata.title for the shortened '
            . 'form. Accept: score > 0.5 AND hasTitleConfidence AND hasAuthorOrYearConfirmation. '
            . 'waveResults key: openalex_short.';
    }

    public function entryGate(): string
    {
        return 'Unresolved academic entries carrying a shortenedTitle from the restore step.';
    }

    public function acceptGate(): string
    {
        return 'Best citable candidate > 0.5, clears the title floor, AND author or year corroborates.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        $retryTitles = [];
        $retryYearFilters = [];
        foreach ($ctx->pool as $refId => $item) {
            if (empty($item['shortenedTitle']) || !$item['isAcademic']) {
                continue;
            }
            $retryTitles[$refId] = $item['shortenedTitle'];
            if (!empty($item['llmMetadata']['year'])) {
                $retryYearFilters[$refId] = $item['llmMetadata']['year'];
            }
        }

        if (empty($retryTitles)) {
            return;
        }

        Log::info('Wave 4b: OpenAlex retry with shortened titles', ['count' => count($retryTitles)]);

        foreach ($ctx->openAlex->searchBatch($retryTitles, 5, $retryYearFilters) as $refId => $candidates) {
            if (!isset($ctx->pool[$refId])) {
                continue;
            }
            $bestMatch = null;
            $bestScore = 0.0;
            $bestDiagnostics = null;
            foreach ($candidates as $candidate) {
                if (!$ctx->openAlex->isCitableWork($candidate)) {
                    continue;
                }
                $llmMeta = $ctx->pool[$refId]['llmMetadata'];
                $title   = $retryTitles[$refId];
                $scoreMeta = $llmMeta;
                if ($scoreMeta) {
                    $scoreMeta['title'] = $title;
                }
                $scoreResult = $scoreMeta
                    ? $ctx->openAlex->metadataScore($scoreMeta, $candidate)
                    : ['score' => $ctx->openAlex->titleSimilarity($title, $candidate['title'] ?? '')];
                $score = $scoreResult['score'];
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $bestMatch = $candidate;
                    $bestDiagnostics = $scoreResult;
                }
            }

            if ($bestMatch && $bestScore > 0.5
                && $ctx->host->hasTitleConfidence($bestDiagnostics, $bestScore)
                && $ctx->host->hasAuthorOrYearConfirmation($ctx->pool[$refId]['llmMetadata'], $bestMatch)
            ) {
                Log::info('Wave 4b: matched with shortened title', [
                    'refId'          => $refId,
                    'shortenedTitle' => $retryTitles[$refId],
                    'resultTitle'    => $bestMatch['title'] ?? null,
                    'score'          => $bestScore,
                ]);
                $result = $ctx->host->resolveWithNormalised(
                    $ctx->pool[$refId],
                    $bestMatch,
                    'openalex',
                    round($bestScore, 3),
                    $ctx->openAlex,
                    $ctx->db,
                    $bestDiagnostics,
                );
                if ($result) {
                    $ctx->recordResult($result);
                    $ctx->host->removeRelatedPoolEntries($ctx->pool, $refId, $ctx->db, $result['foundation_book_id'] ?? null);
                }
            }

            if (isset($ctx->pool[$refId]) && $bestMatch && $bestScore > ($ctx->nearMisses[$refId]['score'] ?? 0.0)) {
                $ctx->nearMisses[$refId] = [
                    'score'       => round($bestScore, 3),
                    'title'       => $bestMatch['title'] ?? null,
                    'author'      => $bestMatch['author'] ?? null,
                    'year'        => $bestMatch['year'] ?? null,
                    'source'      => 'openalex',
                    'diagnostics' => $bestDiagnostics,
                ];
            }

            if (isset($ctx->pool[$refId])) {
                $ctx->waveResults[$refId]['openalex_short'] = $bestMatch
                    ? 'best_score:' . round($bestScore, 3)
                    : 'no_candidates';
            }
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 4b';
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
