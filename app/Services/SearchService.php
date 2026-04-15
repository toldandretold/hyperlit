<?php

namespace App\Services;

use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

class SearchService
{
    /**
     * Convert user query to PostgreSQL tsquery format.
     * Handles phrase search with quotes and joins terms with &.
     */
    public function buildTsQuery(string $query, string $operator = '&'): string
    {
        $query = trim($query);

        if (empty($query)) {
            return '';
        }

        $parts = [];

        // 1. Extract quoted phrases → "(word1 <-> word2 <-> ...)"
        $remaining = preg_replace_callback('/"([^"]+)"/', function ($match) use (&$parts) {
            $words = preg_split('/[\s\-]+/', trim($match[1]));
            $words = array_map(fn($w) => preg_replace('/[^\w]/', '', $w), $words);
            $words = array_filter($words, fn($w) => strlen($w) >= 1);
            if (count($words) === 1) {
                $parts[] = reset($words);
            } elseif (count($words) > 1) {
                $parts[] = '(' . implode(' <-> ', $words) . ')';
            }
            return '';
        }, $query);

        // 2. Extract remaining unquoted terms
        $remaining = trim($remaining);
        if (!empty($remaining)) {
            $terms = preg_split('/\s+/', $remaining);
            foreach ($terms as $term) {
                $term = preg_replace('/[^\w]/', '', $term);
                if (strlen($term) >= 1) {
                    $parts[] = $term;
                }
            }
        }

        if (empty($parts)) {
            return '';
        }

        // 3. Cap at 6 parts to prevent overly complex queries
        $parts = array_slice($parts, 0, 6);

        // 4. Add prefix matching to last part (if it's a plain term, not a phrase group)
        $lastIndex = count($parts) - 1;
        if (!str_contains($parts[$lastIndex], '<->')) {
            $parts[$lastIndex] .= ':*';
        }

        return implode(" {$operator} ", $parts);
    }

    /**
     * Search nodes by keyword using PostgreSQL full-text search.
     * Returns flat array of stdClass results with node data + library metadata.
     */
    public function searchNodesByKeyword(
        string $query,
        int $limit = 10,
        ?string $excludeBook = null,
        string $sourceScope = 'public',
        ?string $creatorName = null,
        string $tsOperator = '&'
    ): array {
        $tsQuery = $this->buildTsQuery($query, $tsOperator);

        if (empty($tsQuery)) {
            return [];
        }

        // Try exact (simple) first, fall back to stemmed (english)
        $simpleCount = DB::selectOne("
            SELECT COUNT(*) as cnt FROM (
                SELECT 1 FROM nodes
                WHERE search_vector_simple @@ to_tsquery('simple', ?)
                AND book NOT IN ('most-recent', 'most-connected', 'most-lit')
                LIMIT 101
            ) sub
        ", [$tsQuery]);

        if (($simpleCount->cnt ?? 0) > 0) {
            $config = 'simple';
            $vectorColumn = 'search_vector_simple';
        } else {
            $config = 'english';
            $vectorColumn = 'search_vector';
        }

        // Build visibility conditions
        $visibilityConditions = ["(library.listed = true AND library.visibility NOT IN ('private', 'deleted'))"];
        $visibilityParams = [];

        if ($sourceScope === 'mine' && $creatorName) {
            $visibilityConditions = ["(library.creator = ? AND library.visibility != 'deleted')"];
            $visibilityParams = [$creatorName];
        } elseif ($sourceScope === 'all' && $creatorName) {
            $visibilityConditions = [
                "(library.listed = true AND library.visibility NOT IN ('private', 'deleted'))",
                "(library.creator = ? AND library.visibility != 'deleted')",
            ];
            $visibilityParams = [$creatorName];
        } elseif ($sourceScope === 'this' && $excludeBook) {
            // "this book only" — handled via book filter below
            $visibilityConditions = ["1=1"];
            $visibilityParams = [];
        } else {
            // Default: public
            $user = Auth::user();
            if ($user) {
                $visibilityConditions[] = "(library.creator = ? AND library.visibility != 'deleted')";
                $visibilityParams[] = $user->name;
            }
        }

        $visibilityClause = '(' . implode(' OR ', $visibilityConditions) . ')';

        $bookFilter = '';
        $bookParams = [];
        if ($sourceScope === 'this' && $excludeBook) {
            $bookFilter = 'AND nodes.book = ?';
            $bookParams = [$excludeBook];
            $excludeBook = null; // Don't exclude it below
        }

        $excludeClause = '';
        $excludeParams = [];
        if ($excludeBook) {
            $excludeClause = 'AND nodes.book != ?';
            $excludeParams = [$excludeBook];
        }

        $orderClause = $tsOperator === '|'
            ? "ORDER BY ts_rank(nodes.{$vectorColumn}, to_tsquery('{$config}', ?)) DESC"
            : "ORDER BY library.created_at DESC";
        $rankParams = $tsOperator === '|' ? [$tsQuery] : [];

        $sql = "
            SELECT
                sub.id,
                sub.book,
                sub.node_id,
                sub.\"plainText\",
                sub.content,
                sub.title AS book_title,
                sub.author AS book_author,
                sub.year AS book_year,
                sub.bibtex,
                ts_headline('{$config}', sub.text_content,
                    to_tsquery('{$config}', ?),
                    'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
                ) as headline
            FROM (
                SELECT
                    nodes.id,
                    nodes.book,
                    nodes.node_id,
                    nodes.\"plainText\",
                    nodes.content,
                    library.title,
                    library.author,
                    library.year,
                    library.bibtex,
                    COALESCE(nodes.\"plainText\", nodes.content, '') as text_content
                FROM nodes
                JOIN library ON nodes.book = library.book
                WHERE nodes.{$vectorColumn} @@ to_tsquery('{$config}', ?)
                    AND nodes.book NOT IN ('most-recent', 'most-connected', 'most-lit')
                    AND library.type != 'sub_book'
                    AND {$visibilityClause}
                    {$bookFilter}
                    {$excludeClause}
                {$orderClause}
                LIMIT ?
            ) sub
        ";

        $params = array_merge(
            [$tsQuery, $tsQuery],
            $visibilityParams,
            $bookParams,
            $excludeParams,
            $rankParams,
            [$limit]
        );

        $results = DB::select($sql, $params);

        // Normalize to stdClass with consistent field names
        return array_map(function ($row) {
            $row->similarity = 0.5; // Fixed similarity for keyword matches
            return $row;
        }, $results);
    }

    /**
     * Search library metadata (title/author/year) by keyword.
     * Returns array of stdClass results with library metadata.
     */
    public function searchLibraryByKeyword(
        string $query,
        int $limit = 10,
        string $sourceScope = 'public',
        ?string $creatorName = null
    ): array {
        $tsQuery = $this->buildTsQuery($query);

        if (empty($tsQuery)) {
            return [];
        }

        $dbQuery = DB::table('library')
            ->selectRaw("
                book,
                title,
                author,
                year,
                bibtex,
                has_nodes,
                ts_rank('{0.05, 0.1, 0.3, 1.0}', search_vector, to_tsquery('simple', ?)) as relevance
            ", [$tsQuery])
            ->whereRaw("search_vector @@ to_tsquery('simple', ?)", [$tsQuery])
            ->where('type', '!=', 'sub_book');

        // Scope filtering
        if ($sourceScope === 'mine' && $creatorName) {
            $dbQuery->where('creator', $creatorName)
                ->where('visibility', '!=', 'deleted');
        } elseif ($sourceScope === 'all' && $creatorName) {
            $dbQuery->where(function ($q) use ($creatorName) {
                $q->where(function ($pub) {
                    $pub->where('listed', true)
                        ->whereNotIn('visibility', ['private', 'deleted']);
                })->orWhere(function ($own) use ($creatorName) {
                    $own->where('creator', $creatorName)
                        ->where('visibility', '!=', 'deleted');
                });
            });
        } else {
            // Default: public
            $dbQuery->where('listed', true)
                ->whereNotIn('visibility', ['private', 'deleted']);
        }

        return $dbQuery
            ->orderByDesc('relevance')
            ->limit($limit)
            ->get()
            ->toArray();
    }
}
