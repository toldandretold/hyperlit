<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class RetrievalService
{
    public function __construct(
        private EmbeddingService $embeddingService,
        private SearchService $searchService,
    ) {}

    /**
     * Execute a retrieval plan and return merged results.
     *
     * @param array $plan {tools: string[], embedding_scope?: string, keywords?: string, reasoning?: string}
     * @param array $context {bookId, nodeIds, selectedText, question, authorName, bookTitle, sourceScope, creatorName}
     * @return array {matches, localContext, queryText, toolsUsed, log}
     */
    public function execute(array $plan, array $context): array
    {
        $tools = $plan['tools'] ?? ['local_context', 'embedding_search'];
        $embeddingScope = $plan['embedding_scope'] ?? 'all_books';
        $keywords = $plan['keywords'] ?? '';

        $allMatches = [];
        $localContext = [];
        $queryText = null;
        $queryEmbedding = null;
        $toolsUsed = [];
        $log = [];

        foreach ($tools as $tool) {
            switch ($tool) {
                case 'local_context':
                    $localContext = $this->executeLocalContext(
                        $context['bookId'],
                        $context['nodeIds']
                    );
                    $toolsUsed[] = 'local_context';
                    $log[] = 'Local context: ' . count($localContext) . ' surrounding nodes';
                    break;

                case 'embedding_search':
                    $queryText = $context['selectedText'] . "\n\n" . $context['question'];
                    $queryEmbedding = $this->embeddingService->embed($queryText, 'search_query: ');

                    if (!$queryEmbedding) {
                        Log::warning('RetrievalService: embedding failed');
                        $log[] = 'Embedding search: FAILED (embedding generation error)';
                        break;
                    }

                    $embeddingMatches = $this->executeEmbeddingSearch(
                        $queryEmbedding,
                        $embeddingScope,
                        $context
                    );
                    $allMatches = array_merge($allMatches, $embeddingMatches);
                    $toolsUsed[] = 'embedding_search';
                    $scopeLabel = $embeddingScope === 'same_author' ? "same author ({$context['authorName']})" : 'all books';
                    $log[] = "Embedding search ({$scopeLabel}): " . count($embeddingMatches) . ' results';
                    break;

                case 'keyword_search':
                    if (empty($keywords)) {
                        $log[] = 'Keyword search: skipped (no keywords)';
                        break;
                    }
                    $keywordMatches = $this->executeKeywordSearch($keywords, $context);
                    $allMatches = array_merge($allMatches, $keywordMatches);
                    $toolsUsed[] = 'keyword_search';
                    $log[] = 'Keyword search ("' . Str::limit($keywords, 40) . '"): ' . count($keywordMatches) . ' results';
                    break;

                case 'library_search':
                    if (empty($keywords)) {
                        $log[] = 'Library search: skipped (no keywords)';
                        break;
                    }
                    $libraryMatches = $this->executeLibrarySearch($keywords, $context);
                    $allMatches = array_merge($allMatches, $libraryMatches);
                    $toolsUsed[] = 'library_search';
                    $log[] = 'Library search ("' . Str::limit($keywords, 40) . '"): ' . count($libraryMatches) . ' results';
                    break;
            }
        }

        // Embedding fallback: if same_author returned <3 results, widen to all books
        if (in_array('embedding_search', $toolsUsed) && $embeddingScope === 'same_author') {
            $embeddingOnly = array_filter($allMatches, fn($m) => ($m->_source ?? '') === 'embedding');
            if (count($embeddingOnly) < 3 && $queryEmbedding) {
                $widerMatches = $this->embeddingService->searchSimilar(
                    $queryEmbedding, 10, $context['bookId'],
                    $context['sourceScope'], $context['creatorName']
                );
                foreach ($widerMatches as &$m) {
                    $m->_source = 'embedding';
                }
                $allMatches = array_merge($allMatches, $widerMatches);
                $log[] = 'Embedding fallback (widened to all books): ' . count($widerMatches) . ' results';
            }
        }

        $matches = $this->mergeMatches($allMatches);

        return [
            'matches' => $matches,
            'localContext' => $localContext,
            'queryText' => $queryText,
            'toolsUsed' => $toolsUsed,
            'log' => $log,
        ];
    }

    /**
     * Fetch surrounding context nodes for local_context tool.
     */
    private function executeLocalContext(string $bookId, array $nodeIds, int $radius = 5): array
    {
        $selectedNodes = DB::table('nodes')->where('book', $bookId)
            ->whereIn('node_id', $nodeIds)->orderBy('startLine')->get();

        if ($selectedNodes->isEmpty()) return [];

        $minLine = $selectedNodes->min('startLine');
        $maxLine = $selectedNodes->max('startLine');

        $lowerBound = DB::table('nodes')->where('book', $bookId)
            ->where('startLine', '<', $minLine)->orderByDesc('startLine')
            ->limit($radius)->pluck('startLine')->min();

        $upperBound = DB::table('nodes')->where('book', $bookId)
            ->where('startLine', '>', $maxLine)->orderBy('startLine')
            ->limit($radius)->pluck('startLine')->max();

        return DB::table('nodes')->where('book', $bookId)
            ->where('startLine', '>=', $lowerBound ?? $minLine)
            ->where('startLine', '<=', $upperBound ?? $maxLine)
            ->orderBy('startLine')
            ->get()
            ->map(fn($row) => tap($row, fn($r) => $r->is_selected = in_array($r->node_id, $nodeIds)))
            ->toArray();
    }

    /**
     * Execute embedding (vector) search with scope handling.
     */
    private function executeEmbeddingSearch(array $queryEmbedding, string $scope, array $context): array
    {
        $matches = [];

        if ($scope === 'same_author' && !empty($context['authorName'])) {
            $matches = $this->embeddingService->searchSimilarByAuthor(
                $queryEmbedding, 10, $context['bookId'],
                $context['authorName'], $context['sourceScope'], $context['creatorName']
            );
        } else {
            $matches = $this->embeddingService->searchSimilar(
                $queryEmbedding, 10, $context['bookId'],
                $context['sourceScope'], $context['creatorName']
            );
        }

        // Tag source for dedup priority
        foreach ($matches as &$m) {
            $m->_source = 'embedding';
        }

        return $matches;
    }

    /**
     * Execute keyword search on node content.
     */
    private function executeKeywordSearch(string $keywords, array $context): array
    {
        $matches = $this->searchService->searchNodesByKeyword(
            $keywords,
            10,
            $context['bookId'],
            $context['sourceScope'],
            $context['creatorName']
        );

        // Tag source
        foreach ($matches as &$m) {
            $m->_source = 'keyword';
        }

        return $matches;
    }

    /**
     * Execute library metadata search, then fetch a representative node from each matching book.
     */
    private function executeLibrarySearch(string $keywords, array $context): array
    {
        $libraryResults = $this->searchService->searchLibraryByKeyword(
            $keywords,
            5,
            $context['sourceScope'],
            $context['creatorName']
        );

        $matches = [];
        foreach ($libraryResults as $lib) {
            // Fetch a representative node from this book (first node with content)
            $node = DB::table('nodes')
                ->where('book', $lib->book)
                ->whereNotNull('plainText')
                ->where('plainText', '!=', '')
                ->orderBy('startLine')
                ->first();

            if (!$node) continue;

            $match = new \stdClass();
            $match->id = $node->id;
            $match->book = $lib->book;
            $match->node_id = $node->node_id;
            $match->plainText = $node->plainText;
            $match->content = $node->content ?? '';
            $match->book_title = $lib->title;
            $match->book_author = $lib->author;
            $match->book_year = $lib->year;
            $match->bibtex = $lib->bibtex ?? null;
            $match->similarity = 0.5;
            $match->_source = 'library';

            $matches[] = $match;
        }

        return $matches;
    }

    /**
     * Deduplicate matches by node_id. Embedding results take priority over keyword/library.
     */
    private function mergeMatches(array $allMatches): array
    {
        $seen = [];
        $merged = [];

        // Sort: embedding first, then keyword, then library
        $priority = ['embedding' => 0, 'keyword' => 1, 'library' => 2];
        usort($allMatches, function ($a, $b) use ($priority) {
            $pa = $priority[$a->_source ?? 'library'] ?? 2;
            $pb = $priority[$b->_source ?? 'library'] ?? 2;
            return $pa <=> $pb;
        });

        foreach ($allMatches as $match) {
            $nodeId = $match->node_id;
            if (isset($seen[$nodeId])) {
                continue;
            }
            $seen[$nodeId] = true;

            // Clean up internal tag before returning
            unset($match->_source);

            $merged[] = $match;
        }

        return $merged;
    }
}
