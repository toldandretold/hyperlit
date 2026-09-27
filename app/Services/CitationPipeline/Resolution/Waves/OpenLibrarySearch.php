<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use App\Services\OpenLibraryService;
use Illuminate\Support\Facades\Log;

/**
 * Open Library title search — the book-shaped rung of the ladder (old Wave 5).
 *
 * This is the CANONICAL search→score→resolve shape that the other search waves (OpenAlex title,
 * Semantic Scholar, and their shortened-title retries) all repeat: build keyed queries from the
 * pool, batch-search, score every candidate, gate the best one, and record three side channels —
 * `storedCandidates` (so the Phase B retries can RE-SCORE what was already fetched instead of
 * paying for the search twice), `nearMisses` (the best sub-threshold candidate, which is what the
 * workbench shows a human when nothing matched), and `waveResults` (per-wave outcome for
 * diagnostics).
 *
 * A year contradiction on a sub-0.6 score DEMOTES an otherwise-accepted candidate to a near-miss
 * with `rejected_reason` — recorded, not discarded, because "we found something plausible and
 * refused it for a stated reason" is exactly what a reviewer needs to see. High scorers pass the
 * year gate deliberately: editions and reprints legitimately move the year.
 *
 * The service is resolved via `app()` INSIDE run(), not injected at construction: the
 * characterisation harness swaps container bindings, and an instance captured earlier would hold
 * the real client (the same trap `CitationLadderGoldenCommand::installCassette` guards against
 * with forgetInstance).
 */
class OpenLibrarySearch implements ResolutionWave
{
    public function id(): string
    {
        return 'open_library_search';
    }

    public function title(): string
    {
        return 'Open Library title search';
    }

    public function plain(): string
    {
        return 'We searched Open Library — the Internet Archive\'s catalogue of published books — '
            . 'for the cited title and author, and accepted the best result only if it matched the '
            . 'citation closely.';
    }

    public function dev(): string
    {
        return 'searchBatch(title + first-author surname, limit 5) over unresolved academic pool '
            . 'entries. metadataScore when llm_metadata exists, else titleSimilarity. Accept: '
            . 'score > 0.3 AND hasTitleConfidence AND no year-mismatch rejection. Candidates '
            . 'stored under storedCandidates[refId][openlibrary] for the Phase B re-score; best '
            . 'refused candidate lands in nearMisses.';
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
        $openLibrary = app(OpenLibraryService::class);

        $olQueries = [];
        foreach ($ctx->pool as $refId => $item) {
            if (!$item['searchedTitle'] || !$item['isAcademic']) {
                continue;
            }
            // First author's SURNAME only — Open Library's search treats "Surname, Given" as two
            // terms and the surname is the discriminating one.
            $olAuthor = null;
            if (!empty($item['llmMetadata']['authors'][0])) {
                $parts = explode(',', $item['llmMetadata']['authors'][0], 2);
                $olAuthor = trim($parts[0]);
            }
            $olQueries[$refId] = ['title' => $item['searchedTitle'], 'author' => $olAuthor];
        }

        if (empty($olQueries)) {
            return;
        }

        Log::info('Wave 5: Open Library search', ['count' => count($olQueries)]);

        foreach ($openLibrary->searchBatch($olQueries, 5) as $refId => $candidates) {
            if (!isset($ctx->pool[$refId])) {
                continue;
            }

            // Store candidates for shortened-title re-scoring
            $ctx->storedCandidates[$refId]['openlibrary'] = $candidates;

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
                    Log::info('Wave 5: year mismatch rejection', [
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
                        'source'          => 'open_library',
                        'diagnostics'     => $bestDiagnostics,
                        'rejected_reason' => 'year_mismatch',
                    ];
                } else {
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
            }

            // Strictly `>` so a year-mismatch entry written above (same score) is not overwritten
            // — its rejected_reason is the part a human needs.
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
                $ctx->waveResults[$refId]['open_library'] = $bestMatch
                    ? 'best_score:' . round($bestScore, 3)
                    : 'no_candidates';
            }
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 5';
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
