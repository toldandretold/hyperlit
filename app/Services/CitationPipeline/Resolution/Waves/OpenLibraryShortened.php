<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use App\Services\OpenLibraryService;
use Illuminate\Support\Facades\Log;

/**
 * Open Library retry with the shortened title (old Wave 5b).
 *
 * Phase B twin of OpenLibrarySearch: same query shape (shortened title + first-author surname),
 * held to the retry bar (0.5 + author-or-year confirmation). Depends on ShortenedTitleRestore
 * having stamped `shortenedTitle` onto the pool items.
 */
class OpenLibraryShortened implements ResolutionWave
{
    public function id(): string
    {
        return 'open_library_shortened';
    }

    public function title(): string
    {
        return 'Open Library retry with shortened title';
    }

    public function plain(): string
    {
        return 'We searched Open Library again using just the main title, without its subtitle, '
            . 'and accepted a match only with the author or year also agreeing.';
    }

    public function dev(): string
    {
        return 'OpenLibraryService::searchBatch(shortenedTitle + first-author surname, limit 5); '
            . 'scoring swaps llmMetadata.title for the shortened form. Accept: score > 0.5 AND '
            . 'hasTitleConfidence AND hasAuthorOrYearConfirmation. waveResults key: '
            . 'open_library_short.';
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
        $openLibrary = app(OpenLibraryService::class);

        $olRetryQueries = [];
        foreach ($ctx->pool as $refId => $item) {
            if (empty($item['shortenedTitle']) || !$item['isAcademic']) {
                continue;
            }
            $olAuthor = null;
            if (!empty($item['llmMetadata']['authors'][0])) {
                $parts = explode(',', $item['llmMetadata']['authors'][0], 2);
                $olAuthor = trim($parts[0]);
            }
            $olRetryQueries[$refId] = ['title' => $item['shortenedTitle'], 'author' => $olAuthor];
        }

        if (empty($olRetryQueries)) {
            return;
        }

        Log::info('Wave 5b: Open Library retry with shortened titles', ['count' => count($olRetryQueries)]);

        foreach ($openLibrary->searchBatch($olRetryQueries, 5) as $refId => $candidates) {
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
                Log::info('Wave 5b: matched with shortened title', [
                    'refId'          => $refId,
                    'shortenedTitle' => $ctx->pool[$refId]['shortenedTitle'],
                    'resultTitle'    => $bestMatch['title'] ?? null,
                    'score'          => $bestScore,
                ]);
                $result = $ctx->host->resolveWithNormalised(
                    $ctx->pool[$refId],
                    $bestMatch,
                    'open_library',
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
                    'source'      => 'open_library',
                    'diagnostics' => $bestDiagnostics,
                ];
            }

            if (isset($ctx->pool[$refId])) {
                $ctx->waveResults[$refId]['open_library_short'] = $bestMatch
                    ? 'best_score:' . round($bestScore, 3)
                    : 'no_candidates';
            }
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 5b';
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
