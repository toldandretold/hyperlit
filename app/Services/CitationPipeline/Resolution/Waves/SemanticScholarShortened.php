<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use App\Services\SemanticScholarService;
use Illuminate\Support\Facades\Log;

/**
 * Semantic Scholar retry with the shortened title (old Wave 7b).
 *
 * Phase B twin of SemanticScholarSearch, held to the retry bar (0.5 + author-or-year
 * confirmation). Depends on ShortenedTitleRestore having stamped `shortenedTitle` onto the
 * pool items.
 */
class SemanticScholarShortened implements ResolutionWave
{
    public function id(): string
    {
        return 'semantic_scholar_shortened';
    }

    public function title(): string
    {
        return 'Semantic Scholar retry with shortened title';
    }

    public function plain(): string
    {
        return 'We searched Semantic Scholar again using just the main title, without its '
            . 'subtitle, and accepted a match only with the author or year also agreeing.';
    }

    public function dev(): string
    {
        return 'SemanticScholarService::searchBatch(shortenedTitle + first-author surname, '
            . 'limit 5); scoring swaps llmMetadata.title for the shortened form. Accept: '
            . 'score > 0.5 AND hasTitleConfidence AND hasAuthorOrYearConfirmation. waveResults '
            . 'key: semantic_scholar_short.';
    }

    public function entryGate(): string
    {
        return 'Unresolved academic entries carrying a shortenedTitle from the restore step.';
    }

    public function acceptGate(): string
    {
        return 'Best candidate > 0.5, clears the title floor, AND author or year corroborates.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        $semanticScholar = app(SemanticScholarService::class);

        $ssRetryQueries = [];
        foreach ($ctx->pool as $refId => $item) {
            if (empty($item['shortenedTitle']) || !$item['isAcademic']) {
                continue;
            }
            $ssAuthor = !empty($item['llmMetadata']['authors'][0])
                ? trim(explode(',', $item['llmMetadata']['authors'][0], 2)[0])
                : null;
            $ssRetryQueries[$refId] = ['title' => $item['shortenedTitle'], 'author' => $ssAuthor];
        }

        if (empty($ssRetryQueries)) {
            return;
        }

        Log::info('Wave 7b: Semantic Scholar retry with shortened titles', ['count' => count($ssRetryQueries)]);

        foreach ($semanticScholar->searchBatch($ssRetryQueries, 5) as $refId => $candidates) {
            if (!isset($ctx->pool[$refId])) {
                continue;
            }
            $bestMatch = null;
            $bestScore = 0.0;
            $bestDiagnostics = null;
            foreach ($candidates as $candidate) {
                $llmMeta = $ctx->pool[$refId]['llmMetadata'];
                $title   = $ctx->pool[$refId]['shortenedTitle'];
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
                Log::info('Wave 7b: matched with shortened title', [
                    'refId'          => $refId,
                    'shortenedTitle' => $ctx->pool[$refId]['shortenedTitle'],
                    'resultTitle'    => $bestMatch['title'] ?? null,
                    'score'          => $bestScore,
                ]);
                $result = $ctx->host->resolveWithNormalised(
                    $ctx->pool[$refId],
                    $bestMatch,
                    'semantic_scholar',
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
                    'source'      => 'semantic_scholar',
                    'diagnostics' => $bestDiagnostics,
                ];
            }

            if (isset($ctx->pool[$refId])) {
                $ctx->waveResults[$refId]['semantic_scholar_short'] = $bestMatch
                    ? 'best_score:' . round($bestScore, 3)
                    : 'no_candidates';
            }
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 7b';
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
