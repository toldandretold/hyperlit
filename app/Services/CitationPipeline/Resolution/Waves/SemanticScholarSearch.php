<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use App\Services\SemanticScholarService;
use Illuminate\Support\Facades\Log;

/**
 * Semantic Scholar title search — the third open-search rung (old Wave 7).
 *
 * Same trunk as OpenAlexTitleSearch/OpenLibrarySearch. Runs LAST of the three because Semantic
 * Scholar's public API is the most aggressively rate-limited (the service chunks its batches),
 * so it is only asked about what the cheaper indexes could not settle.
 *
 * Like Open Library it takes no candidate-type filter — S2 records are not OpenAlex-typed, so
 * `isCitableWork` has nothing to read. Resolved via app() inside run(), same as the others, so
 * the characterisation harness's container swaps reach it.
 */
class SemanticScholarSearch implements ResolutionWave
{
    public function id(): string
    {
        return 'semantic_scholar_search';
    }

    public function title(): string
    {
        return 'Semantic Scholar title search';
    }

    public function plain(): string
    {
        return 'We searched Semantic Scholar — a third public index of scholarly works — for the '
            . 'cited title and author, and accepted the best result only if it matched the '
            . 'citation closely.';
    }

    public function dev(): string
    {
        return 'searchBatch(title + first-author surname, limit 5), chunked and rate-limited by '
            . 'the service. metadataScore when llm_metadata exists, else titleSimilarity. Accept: '
            . 'score > 0.3 AND hasTitleConfidence AND no year-mismatch rejection. Candidates '
            . 'stored under storedCandidates[refId][semantic_scholar] for the Phase B re-score.';
    }

    public function entryGate(): string
    {
        return 'Unresolved pool entries with a searchable title that look academic.';
    }

    public function acceptGate(): string
    {
        return 'Best candidate scores > 0.3, clears the 0.45 title floor, and does not contradict '
            . 'the cited year while scoring under 0.6.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        $semanticScholar = app(SemanticScholarService::class);

        $ssQueries = [];
        foreach ($ctx->pool as $refId => $item) {
            if (!$item['searchedTitle'] || !$item['isAcademic']) {
                continue;
            }
            $ssAuthor = !empty($item['llmMetadata']['authors'][0])
                ? trim(explode(',', $item['llmMetadata']['authors'][0], 2)[0])
                : null;
            $ssQueries[$refId] = ['title' => $item['searchedTitle'], 'author' => $ssAuthor];
        }

        if (empty($ssQueries)) {
            return;
        }

        Log::info('Wave 7: Semantic Scholar search', ['count' => count($ssQueries)]);

        foreach ($semanticScholar->searchBatch($ssQueries, 5) as $refId => $candidates) {
            if (!isset($ctx->pool[$refId])) {
                continue;
            }

            // Store candidates for shortened-title re-scoring
            $ctx->storedCandidates[$refId]['semantic_scholar'] = $candidates;

            $bestMatch = null;
            $bestScore = 0.0;
            $bestDiagnostics = null;
            foreach ($candidates as $candidate) {
                $llmMeta = $ctx->pool[$refId]['llmMetadata'];
                $title   = $ctx->pool[$refId]['searchedTitle'];
                $scoreResult = $llmMeta
                    ? $ctx->openAlex->metadataScore($llmMeta, $candidate)
                    : ['score' => $ctx->openAlex->titleSimilarity($title, $candidate['title'] ?? '')];
                $score = $scoreResult['score'];
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $bestMatch = $candidate;
                    $bestDiagnostics = $scoreResult;
                }
            }

            if ($bestMatch && $bestScore > 0.3 && $ctx->host->hasTitleConfidence($bestDiagnostics, $bestScore)) {
                if ($ctx->host->hasYearMismatchRejection($ctx->pool[$refId]['llmMetadata'], $bestMatch, $bestScore)) {
                    Log::info('Wave 7: year mismatch rejection', [
                        'refId'          => $refId,
                        'searchedTitle'  => $ctx->pool[$refId]['searchedTitle'],
                        'resultTitle'    => $bestMatch['title'] ?? null,
                        'score'          => round($bestScore, 3),
                        'llm_year'       => $ctx->pool[$refId]['llmMetadata']['year'] ?? null,
                        'candidate_year' => $bestMatch['year'] ?? null,
                    ]);
                    $ctx->nearMisses[$refId] = [
                        'score'           => round($bestScore, 3),
                        'title'           => $bestMatch['title'] ?? null,
                        'author'          => $bestMatch['author'] ?? null,
                        'year'            => $bestMatch['year'] ?? null,
                        'source'          => 'semantic_scholar',
                        'diagnostics'     => $bestDiagnostics,
                        'rejected_reason' => 'year_mismatch',
                    ];
                } else {
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
            }

            // Strictly `>` so a year-mismatch entry above (same score) keeps its rejected_reason.
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
                $ctx->waveResults[$refId]['semantic_scholar'] = $bestMatch
                    ? 'best_score:' . round($bestScore, 3)
                    : 'no_candidates';
            }
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 7';
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
