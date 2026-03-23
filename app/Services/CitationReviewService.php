<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class CitationReviewService
{
    public function __construct(private LlmService $llm) {}

    /**
     * Run the full citation review pipeline for a book.
     * Returns enriched claims array.
     */
    public function review(string $bookId, ?callable $onProgress = null): array
    {
        $progress = $onProgress ?? fn() => null;

        // Phase 1: Parse
        $citationNodes = $this->parseCitationNodes($bookId);
        $totalCitations = array_sum(array_map(fn($n) => count($n['reference_ids']), $citationNodes));
        $progress('parse', "Found " . count($citationNodes) . " nodes with citations ({$totalCitations} total citation occurrences)");

        if (empty($citationNodes)) {
            return [];
        }

        // Phase 2: Enrich
        $citationMeta = $this->enrichCitationMetadata($citationNodes, $bookId);
        $verified = count(array_filter($citationMeta, fn($m) => $m['verified']));
        $withContent = count(array_filter($citationMeta, fn($m) => $m['has_source_content']));
        $progress('enrich', "Resolved " . count($citationMeta) . " unique sources ({$verified} verified, {$withContent} with content)");

        // Phase 3: Extract truth claims
        $claims = $this->extractTruthClaims($citationNodes, $citationMeta, $progress);
        $progress('extract', "Extracted " . count($claims) . " truth claims from " . count($citationNodes) . " nodes");

        if (empty($claims)) {
            return [];
        }

        // Phase 4: Search source passages
        $this->searchSourcePassages($claims, $progress);
        $sourcesSearched = count(array_unique(array_filter(array_column($claims, 'source_book_id'))));
        $progress('passages', "Searched {$sourcesSearched} sources with content");

        // Phase 5: Verify claims
        $this->verifyClaims($claims, $progress);

        return $claims;
    }

    /**
     * Phase 1: Find nodes with citations, replace anchors with [CITE:refId] markers.
     */
    private function parseCitationNodes(string $bookId): array
    {
        $db = DB::connection('pgsql_admin');

        $nodes = $db->table('nodes')
            ->where('book', $bookId)
            ->select(['node_id', 'content'])
            ->orderBy('startLine')
            ->get();

        $result = [];

        foreach ($nodes as $node) {
            $content = $node->content ?? '';

            // Check for in-text citations (href-first or class-first)
            if (!preg_match('/<a\s[^>]*class="in-text-citation"[^>]*>/i', $content)) {
                continue;
            }

            // Replace citation anchors with [CITE:refId] markers
            $marked = preg_replace(
                '/<a\s[^>]*href="#([^"]+)"[^>]*class="in-text-citation"[^>]*>.*?<\/a>/i',
                '[CITE:$1]', $content
            );
            $marked = preg_replace(
                '/<a\s[^>]*class="in-text-citation"[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/i',
                '[CITE:$1]', $marked
            );
            $marked = strip_tags($marked);

            // Extract reference IDs
            preg_match_all('/\[CITE:([^\]]+)\]/', $marked, $refMatches);
            $referenceIds = array_unique($refMatches[1]);

            if (empty($referenceIds)) {
                continue;
            }

            $result[] = [
                'node_id'       => $node->node_id,
                'marked_text'   => $marked,
                'reference_ids' => array_values($referenceIds),
            ];
        }

        return $result;
    }

    /**
     * Phase 2: Batch-resolve all unique referenceIds to library metadata.
     */
    private function enrichCitationMetadata(array $citationNodes, string $bookId): array
    {
        $db = DB::connection('pgsql_admin');

        // Collect all unique reference IDs
        $allRefIds = [];
        foreach ($citationNodes as $node) {
            foreach ($node['reference_ids'] as $refId) {
                $allRefIds[$refId] = true;
            }
        }
        $allRefIds = array_keys($allRefIds);

        if (empty($allRefIds)) {
            return [];
        }

        // Batch query 1: bibliography → foundation_source
        $bibEntries = $db->table('bibliography')
            ->where('book', $bookId)
            ->whereIn('referenceId', $allRefIds)
            ->select(['referenceId', 'foundation_source'])
            ->get()
            ->keyBy('referenceId');

        // Collect foundation_source book IDs for library lookup
        $sourceBookIds = [];
        foreach ($bibEntries as $entry) {
            $source = $entry->foundation_source ?? null;
            if ($source && $source !== 'unknown') {
                $sourceBookIds[$source] = true;
            }
        }

        // Batch query 2: library records
        $libraryRecords = [];
        if (!empty($sourceBookIds)) {
            $libraryRecords = $db->table('library')
                ->whereIn('book', array_keys($sourceBookIds))
                ->select(['book', 'title', 'author', 'year', 'openalex_id', 'open_library_key', 'abstract', 'has_nodes'])
                ->get()
                ->keyBy('book');
        }

        // Build lookup map
        $citationMeta = [];
        foreach ($allRefIds as $refId) {
            $bib = $bibEntries[$refId] ?? null;
            $source = $bib->foundation_source ?? null;
            $lib = ($source && $source !== 'unknown') ? ($libraryRecords[$source] ?? null) : null;

            $citationMeta[$refId] = [
                'title'              => $lib->title ?? null,
                'abstract'           => $lib->abstract ?? null,
                'verified'           => $lib && (!empty($lib->openalex_id) || !empty($lib->open_library_key)),
                'source_book_id'     => $source ?: null,
                'has_source_content' => (bool) ($lib->has_nodes ?? false),
            ];
        }

        return $citationMeta;
    }

    /**
     * Phase 3: Send each citation-bearing node to the LLM for truth claim extraction.
     */
    private function extractTruthClaims(array $citationNodes, array $citationMeta, callable $progress): array
    {
        $claims = [];
        $nodeCount = count($citationNodes);

        foreach ($citationNodes as $i => $node) {
            $progress('extract', "Processing node " . ($i + 1) . "/{$nodeCount}...");

            // Build citation context for this node's references
            $context = [];
            foreach ($node['reference_ids'] as $refId) {
                if (isset($citationMeta[$refId])) {
                    $context[$refId] = $citationMeta[$refId];
                }
            }

            // Truncate very long text
            $markedText = $node['marked_text'];
            if (mb_strlen($markedText) > 3000) {
                $markedText = mb_substr($markedText, 0, 3000) . '...';
            }

            $extracted = $this->llm->extractTruthClaims($markedText, $context);

            if ($extracted === null) {
                Log::warning("LLM truth claim extraction failed for node {$node['node_id']}");
                continue;
            }

            foreach ($extracted as $claim) {
                $refId = $claim['referenceId'] ?? null;
                $truthClaim = $claim['truth_claim'] ?? null;

                if (!$refId || !$truthClaim) {
                    continue;
                }

                // Validate: referenceId must be one of this node's known citations
                if (!in_array($refId, $node['reference_ids'])) {
                    Log::warning("LLM hallucinated referenceId '{$refId}' not in node {$node['node_id']}");
                    continue;
                }

                // Validate verbatim: truth_claim must appear in the marked text
                if (mb_stripos($node['marked_text'], $truthClaim) === false) {
                    Log::warning("Truth claim not found verbatim in node {$node['node_id']}", [
                        'refId' => $refId,
                        'claim' => mb_substr($truthClaim, 0, 100),
                    ]);
                    continue;
                }

                $meta = $citationMeta[$refId] ?? [];

                $claims[] = [
                    'node_id'            => $node['node_id'],
                    'referenceId'        => $refId,
                    'truth_claim'        => $truthClaim,
                    'verified_source'    => $meta['verified'] ?? false,
                    'source_book_id'     => $meta['source_book_id'] ?? null,
                    'source_title'       => $meta['title'] ?? null,
                    'has_source_content' => $meta['has_source_content'] ?? false,
                    'abstract'           => $meta['abstract'] ?? null,
                    'source_passages'    => [],
                    'llm_verdict'        => null,
                ];
            }

            sleep(1);
        }

        return $claims;
    }

    /**
     * Phase 4: Full-text search on source nodes for claims with available content.
     */
    private function searchSourcePassages(array &$claims, callable $progress): void
    {
        $db = DB::connection('pgsql_admin');

        foreach ($claims as &$claim) {
            if (!$claim['has_source_content'] || !$claim['source_book_id']) {
                continue;
            }

            // Build search query from truth claim (first 200 chars for FTS)
            $searchText = mb_substr($claim['truth_claim'], 0, 200);

            // Try english ts config first
            $passages = $db->select(
                'SELECT node_id, "plainText",
                        ts_rank(search_vector, plainto_tsquery(\'english\', ?)) AS rank
                 FROM nodes
                 WHERE book = ? AND search_vector @@ plainto_tsquery(\'english\', ?)
                 ORDER BY rank DESC LIMIT 3',
                [$searchText, $claim['source_book_id'], $searchText]
            );

            // Fallback to simple config
            if (empty($passages)) {
                $passages = $db->select(
                    'SELECT node_id, "plainText",
                            ts_rank(search_vector_simple, plainto_tsquery(\'simple\', ?)) AS rank
                     FROM nodes
                     WHERE book = ? AND search_vector_simple @@ plainto_tsquery(\'simple\', ?)
                     ORDER BY rank DESC LIMIT 3',
                    [$searchText, $claim['source_book_id'], $searchText]
                );
            }

            $claim['source_passages'] = array_map(fn($p) => [
                'node_id' => $p->node_id,
                'text'    => mb_substr($p->plainText ?? '', 0, 500),
                'rank'    => round($p->rank, 4),
            ], $passages);
        }
        unset($claim);
    }

    /**
     * Phase 5: Send each claim + source material to the advanced LLM for verification.
     */
    private function verifyClaims(array &$claims, callable $progress): void
    {
        $total = count($claims);

        foreach ($claims as $i => &$claim) {
            $progress('verify', "Verifying claim " . ($i + 1) . "/{$total}...");

            $sourceMaterial = '';
            if (!empty($claim['abstract'])) {
                $sourceMaterial .= "ABSTRACT:\n{$claim['abstract']}\n\n";
            }
            if (!empty($claim['source_passages'])) {
                $sourceMaterial .= "PASSAGES FROM SOURCE TEXT:\n";
                foreach ($claim['source_passages'] as $j => $p) {
                    $sourceMaterial .= "--- Passage " . ($j + 1) . " ---\n{$p['text']}\n\n";
                }
            }

            if (empty(trim($sourceMaterial))) {
                $claim['llm_verdict'] = [
                    'matches'   => null,
                    'summary'   => 'Insufficient source data',
                    'reasoning' => 'No abstract or source passages available for verification.',
                ];
                continue;
            }

            $verdict = $this->llm->verifyCitation($claim['truth_claim'], $sourceMaterial);

            if ($verdict === null) {
                $claim['llm_verdict'] = [
                    'matches'   => null,
                    'summary'   => 'LLM verification failed',
                    'reasoning' => 'The verification model did not return a valid response.',
                ];
            } else {
                $claim['llm_verdict'] = $verdict;
            }

            sleep(1);
        }
        unset($claim);
    }

    /**
     * Build a markdown report from the claims array.
     */
    public function buildMarkdownReport(array $claims, string $bookId, string $bookTitle): string
    {
        $md = "# Citation Review Report\n\n";
        $md .= "- **Book:** {$bookTitle}\n";
        $md .= "- **Date:** " . now()->toDateTimeString() . "\n";
        $md .= "- **Claims analyzed:** " . count($claims) . "\n\n";

        // Categorise
        $verified = [];
        $disputed = [];
        $insufficient = [];

        foreach ($claims as $claim) {
            $matches = $claim['llm_verdict']['matches'] ?? null;
            if ($matches === true) {
                $verified[] = $claim;
            } elseif ($matches === false) {
                $disputed[] = $claim;
            } else {
                $insufficient[] = $claim;
            }
        }

        // Summary table
        $md .= "## Summary\n\n";
        $md .= "| Metric | Count |\n|--------|-------|\n";
        $md .= "| Verified (matches) | " . count($verified) . " |\n";
        $md .= "| Disputed (no match) | " . count($disputed) . " |\n";
        $md .= "| Insufficient data | " . count($insufficient) . " |\n\n";

        if (!empty($verified)) {
            $md .= "## Verified Claims\n\n";
            foreach ($verified as $c) {
                $md .= $this->formatClaimMd($c);
            }
        }

        if (!empty($disputed)) {
            $md .= "## Disputed Claims\n\n";
            foreach ($disputed as $c) {
                $md .= $this->formatClaimMd($c);
            }
        }

        if (!empty($insufficient)) {
            $md .= "## Insufficient Data\n\n";
            foreach ($insufficient as $c) {
                $md .= $this->formatClaimMd($c);
            }
        }

        return $md;
    }

    private function formatClaimMd(array $claim): string
    {
        $refId = $claim['referenceId'];
        $title = $claim['source_title'] ?? 'Unknown';
        $verdict = $claim['llm_verdict'] ?? [];

        $md = "### `{$refId}` — \"{$title}\"\n\n";
        $md .= "**Node:** `{$claim['node_id']}`\n";
        $md .= "**Claim:** \"{$claim['truth_claim']}\"\n";

        $matchLabel = match ($verdict['matches'] ?? null) {
            true    => 'Matches',
            false   => 'Disputed',
            default => 'Insufficient data',
        };
        $md .= "**Verdict:** {$matchLabel}\n";

        if (!empty($verdict['summary'])) {
            $md .= "**Summary:** {$verdict['summary']}\n";
        }
        if (!empty($verdict['reasoning'])) {
            $md .= "**Reasoning:** {$verdict['reasoning']}\n";
        }

        $md .= "\n";
        return $md;
    }
}
