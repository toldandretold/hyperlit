<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use Illuminate\Support\Facades\Log;

/**
 * OpenAlex title search — the first open-search rung, scholarly-article-shaped (old Wave 4).
 *
 * Same search→score→resolve trunk as OpenLibrarySearch, with three differences that are this
 * wave's identity:
 *
 * - The SEARCH carries a publication-year filter when the citation states one (preferring
 *   `original_year` — a reprint cites the edition it used, but the index knows the work by its
 *   first publication).
 * - Candidates that are not citable WORKS are refused before scoring (`isCitableWork`) — OpenAlex
 *   indexes book reviews, errata and paratext whose titles quote the work they discuss, and a
 *   review of the cited book scoring 0.9 against the book's title is exactly the wrong link.
 * - A best-candidate-below-threshold is logged: this is the wave where "we found something but
 *   not convincingly" is most common, and that log is how title-extraction bugs get noticed.
 */
class OpenAlexTitleSearch implements ResolutionWave
{
    public function id(): string
    {
        return 'openalex_title_search';
    }

    public function title(): string
    {
        return 'OpenAlex title search';
    }

    public function plain(): string
    {
        return 'We searched OpenAlex — a public index of scholarly works — for the cited title, '
            . 'filtered to the cited year when one was given, and accepted the best result only '
            . 'if it matched the citation closely and was a real work rather than a review of one.';
    }

    public function dev(): string
    {
        return 'searchBatch(titles, limit 5, yearFilters) over unresolved academic pool entries; '
            . 'original_year preferred for the filter. isCitableWork refuses reviews/errata before '
            . 'scoring. metadataScore when llm_metadata exists, else titleSimilarity. Accept: '
            . 'score > 0.3 AND hasTitleConfidence AND no year-mismatch rejection.';
    }

    public function entryGate(): string
    {
        return 'Unresolved pool entries with a searchable title that look academic.';
    }

    public function acceptGate(): string
    {
        return 'Best CITABLE candidate scores > 0.3, clears the 0.45 title floor, and does not '
            . 'contradict the cited year while scoring under 0.6.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        $titlesToSearch = [];
        foreach ($ctx->pool as $refId => $item) {
            if ($item['searchedTitle'] && $item['isAcademic']) {
                $titlesToSearch[$refId] = $item['searchedTitle'];
            }
        }

        if (empty($titlesToSearch)) {
            return;
        }

        Log::info('Wave 4: OpenAlex title search', ['count' => count($titlesToSearch)]);

        $yearFilters = [];
        foreach ($ctx->pool as $refId => $item) {
            if ($item['searchedTitle'] && !empty($item['llmMetadata']['year'])) {
                $yearFilters[$refId] = $item['llmMetadata']['original_year'] ?? $item['llmMetadata']['year'];
            }
        }

        foreach ($ctx->openAlex->searchBatch($titlesToSearch, 5, $yearFilters) as $refId => $candidates) {
            if (!isset($ctx->pool[$refId])) {
                continue;
            }

            // Store candidates for shortened-title re-scoring
            $ctx->storedCandidates[$refId]['openalex'] = $candidates;

            $bestMatch = null;
            $bestScore = 0.0;
            $bestDiagnostics = null;
            foreach ($candidates as $candidate) {
                if (!$ctx->openAlex->isCitableWork($candidate)) {
                    Log::debug('Wave 4: rejected non-citable type', [
                        'refId' => $refId,
                        'title' => $candidate['title'] ?? null,
                        'type'  => $candidate['type'] ?? null,
                    ]);
                    continue;
                }
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

            if ($bestMatch && $bestScore <= 0.3) {
                Log::info('Wave 4: best candidate below threshold', [
                    'refId'         => $refId,
                    'bestScore'     => $bestScore,
                    'bestTitle'     => $bestMatch['title'] ?? null,
                    'searchedTitle' => $ctx->pool[$refId]['searchedTitle'],
                ]);
            }

            if ($bestMatch && $bestScore > 0.3 && $ctx->host->hasTitleConfidence($bestDiagnostics, $bestScore)) {
                if ($ctx->host->hasYearMismatchRejection($ctx->pool[$refId]['llmMetadata'], $bestMatch, $bestScore)) {
                    Log::info('Wave 4: year mismatch rejection', [
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
                        'source'          => 'openalex',
                        'diagnostics'     => $bestDiagnostics,
                        'rejected_reason' => 'year_mismatch',
                    ];
                } else {
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
            }

            // Strictly `>` so a year-mismatch entry above (same score) keeps its rejected_reason.
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
                $ctx->waveResults[$refId]['openalex'] = $bestMatch
                    ? 'best_score:' . round($bestScore, 3)
                    : 'no_candidates';
            }
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 4';
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
