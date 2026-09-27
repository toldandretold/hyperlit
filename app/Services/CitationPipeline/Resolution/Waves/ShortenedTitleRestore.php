<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use Illuminate\Support\Facades\Log;

/**
 * Shortened-title restore — the FREE half of Phase B (old "Phase B" preamble + re-score).
 *
 * A citation's title often carries a subtitle the indexes do not ("Empire: A Very Short
 * Introduction" is indexed as "Empire"), so a full-title search scores low against the right
 * work. This wave does two things:
 *
 * 1. GENERATES the shortened title (text before the first `:`/–/— separator, min 10 chars kept)
 *    and stamps it on the pool item — the three retry waves after this one read it from there.
 * 2. RE-SCORES the candidates Phase A already fetched (`storedCandidates`) against the shortened
 *    title, BEFORE any new API call is paid for. A match here costs nothing.
 *
 * The accept bar is HIGHER than Phase A's (0.5 vs 0.3, plus author-or-year confirmation),
 * because chopping the subtitle raises similarity for every work sharing the main title — the
 * extra witness is what keeps this from trading a subtitle problem for a wrong-work problem.
 */
class ShortenedTitleRestore implements ResolutionWave
{
    public function id(): string
    {
        return 'shortened_title_restore';
    }

    public function title(): string
    {
        return 'Shortened-title re-score of stored candidates';
    }

    public function plain(): string
    {
        return 'If the citation\'s title carries a subtitle, we tried again using just the main '
            . 'title — first re-checking the results we had already fetched, which costs nothing.';
    }

    public function dev(): string
    {
        return 'Derives shortenedTitle (prefix before :/–/— , >=10 chars) onto pool items, then '
            . 're-scores storedCandidates[refId][*] with llmMetadata.title swapped for the '
            . 'shortened form. openalex-sourced candidates still pass isCitableWork. Accept: '
            . 'score > 0.5 AND hasTitleConfidence AND hasAuthorOrYearConfirmation.';
    }

    public function entryGate(): string
    {
        return 'Unresolved entries whose title has a subtitle separator, with Phase A candidates stored.';
    }

    public function acceptGate(): string
    {
        return 'Re-scored candidate > 0.5, clears the title floor, AND author or year corroborates.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        // Generate shortened titles for entries with subtitle separators
        foreach ($ctx->pool as $refId => &$item) {
            if (!$item['searchedTitle']) {
                continue;
            }
            if (preg_match('/^(.{10,}?)\s*[:\x{2013}\x{2014}]\s/u', $item['searchedTitle'], $m)) {
                $shortened = trim($m[1]);
                if ($shortened !== $item['searchedTitle'] && strlen($shortened) >= 10) {
                    $item['shortenedTitle'] = $shortened;
                }
            }
        }
        unset($item);

        // Re-score stored candidates from Phase A using shortened titles
        foreach ($ctx->pool as $refId => $item) {
            if (empty($item['shortenedTitle']) || empty($ctx->storedCandidates[$refId])) {
                continue;
            }
            $shortened = $item['shortenedTitle'];
            $bestMatch = null;
            $bestScore = 0.0;
            $bestSource = null;
            $bestDiagnostics = null;

            foreach ($ctx->storedCandidates[$refId] as $source => $candidates) {
                foreach ($candidates as $candidate) {
                    if ($source === 'openalex' && !$ctx->openAlex->isCitableWork($candidate)) {
                        continue;
                    }
                    $scoreMeta = $item['llmMetadata'];
                    if ($scoreMeta) {
                        $scoreMeta['title'] = $shortened;
                    }
                    $scoreResult = $scoreMeta
                        ? $ctx->openAlex->metadataScore($scoreMeta, $candidate)
                        : ['score' => $ctx->openAlex->titleSimilarity($shortened, $candidate['title'] ?? '')];
                    $score = $scoreResult['score'];
                    if ($score > $bestScore) {
                        $bestScore = $score;
                        $bestMatch = $candidate;
                        $bestSource = $source;
                        $bestDiagnostics = $scoreResult;
                    }
                }
            }

            // Store keys and match_method labels diverge historically ('openlibrary' vs
            // 'open_library') — this bridge is the one place that knows both spellings.
            $sourceToMethod = [
                'openalex'         => 'openalex',
                'openlibrary'      => 'open_library',
                'semantic_scholar' => 'semantic_scholar',
            ];

            if ($bestMatch && $bestScore > 0.5
                && $ctx->host->hasTitleConfidence($bestDiagnostics, $bestScore)
                && $ctx->host->hasAuthorOrYearConfirmation($item['llmMetadata'], $bestMatch)
            ) {
                $matchMethod = $sourceToMethod[$bestSource] ?? $bestSource;
                Log::info('Shortened-title re-score: matched from stored candidates', [
                    'refId'          => $refId,
                    'shortenedTitle' => $shortened,
                    'resultTitle'    => $bestMatch['title'] ?? null,
                    'score'          => $bestScore,
                    'source'         => $bestSource,
                ]);
                $result = $ctx->host->resolveWithNormalised(
                    $ctx->pool[$refId],
                    $bestMatch,
                    $matchMethod,
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
                    'source'      => $sourceToMethod[$bestSource] ?? $bestSource,
                    'diagnostics' => $bestDiagnostics,
                ];
            }
        }
    }
    public function logMarker(): ?string
    {
        return null;
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
