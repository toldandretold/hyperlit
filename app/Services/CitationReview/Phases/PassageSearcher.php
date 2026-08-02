<?php

namespace App\Services\CitationReview\Phases;

use App\Services\CitationReview\Support\SearchTerms;
use App\Services\SearchService;
use Illuminate\Support\Facades\DB;

/**
 * Phase 4 of the citation review: for each claim whose source has in-app
 * content, find the passages in that source most relevant to the claim, via a
 * 3-strategy Postgres FTS escalation (verbatim AND → key-term OR → simple-config
 * OR). Mutates each claim's 'source_passages' in place.
 *
 * Extracted verbatim from CitationReviewService::searchSourcePassages /
 * ::ftsQuery. (The old $progress param was never used and has been dropped;
 * the coordinator emits the 'passages' progress line after this returns.)
 */
final class PassageSearcher
{
    public function __construct(private SearchTerms $searchTerms) {}

    public function searchSourcePassages(array &$claims): void
    {
        $db = DB::connection('pgsql_admin');

        foreach ($claims as &$claim) {
            if (!$claim['has_source_content'] || !$claim['source_book_id']) {
                continue;
            }

            // Use truth_claim for search — it's the verbatim sentence with richer topical
            // keywords and no author/year attribution that would pollute FTS queries.
            // contextualised_claim is still used for LLM verification (line 547).
            $searchText = mb_substr($claim['truth_claim'], 0, 200);
            $bookId = $claim['source_book_id'];

            // Strategy 1: AND query with shorter text (catches near-verbatim matches)
            $shortText = mb_substr($searchText, 0, 80);
            $passages = $this->ftsQuery($db, $bookId, $shortText, 'english', 'plainto_tsquery');

            // Strategy 2: OR query with key terms (catches thematic matches)
            if (empty($passages)) {
                $orTerms = $this->searchTerms->orSearchTerms($searchText);
                if ($orTerms) {
                    $passages = $this->ftsQuery($db, $bookId, $orTerms, 'english', 'websearch_to_tsquery');
                }
            }

            // Strategy 3: Simple config OR fallback
            if (empty($passages)) {
                $orTerms = $orTerms ?? $this->searchTerms->orSearchTerms($searchText);
                if ($orTerms) {
                    $passages = $this->ftsQuery($db, $bookId, $orTerms, 'simple', 'websearch_to_tsquery');
                }
            }

            $claim['source_passages'] = array_map(function($p) {
                // The FTS expression indexes cover plainText only (the
                // replace_stored_tsvectors migration backfilled it for
                // legacy HTML-only rows), but keep the content fallback for
                // DISPLAY robustness: if a row somehow has empty plainText,
                // better a stripped-content excerpt than an empty one.
                $plain = trim($p->plainText ?? '');
                $text = $plain !== ''
                    ? $p->plainText
                    : html_entity_decode(strip_tags($p->content ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
                $text = $text ?? '';
                $truncated = mb_strlen($text) > 1500;
                return [
                    'node_id' => $p->node_id,
                    'text'    => mb_substr($text, 0, 1500) . ($truncated ? "\n[...TRUNCATED]" : ''),
                    'rank'    => round($p->rank, 4),
                ];
            }, $passages);
        }
        unset($claim);
    }

    /**
     * Run a full-text search query against the nodes table.
     */
    private function ftsQuery($db, string $bookId, string $query, string $config, string $queryFn): array
    {
        $tsExpr = SearchService::nodeTsExpression($config);

        return $db->select(
            "SELECT node_id, \"plainText\", content,
                    ts_rank({$tsExpr}, {$queryFn}('{$config}', ?)) AS rank
             FROM nodes
             WHERE book = ? AND {$tsExpr} @@ {$queryFn}('{$config}', ?)
             ORDER BY rank DESC LIMIT 3",
            [$query, $bookId, $query]
        );
    }
}
