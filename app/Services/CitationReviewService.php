<?php

namespace App\Services;

use App\Helpers\SubBookIdHelper;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class CitationReviewService
{
    public function __construct(
        private LlmService $llm,
        private MarkdownProcessor $markdownProcessor,
        private FileHelpers $helpers,
        private BackendHighlightService $highlights,
    ) {}

    public function getLlm(): LlmService
    {
        return $this->llm;
    }

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
            return ['claims' => [], 'stats' => []];
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
            return ['claims' => [], 'stats' => []];
        }

        // Phase 4: Search source passages
        $this->searchSourcePassages($claims, $progress);
        $sourcesSearched = count(array_unique(array_filter(array_column($claims, 'source_book_id'))));
        $progress('passages', "Searched {$sourcesSearched} sources with content");

        // Phase 5: Verify claims
        $this->verifyClaims($claims, $progress);

        // Phase 6: Create verification highlights
        $highlightCount = $this->createVerificationHighlights($claims, $bookId);
        $progress('highlights', "Created {$highlightCount} verification highlights");

        $totalBib = DB::connection('pgsql_admin')
            ->table('bibliography')->where('book', $bookId)->count();

        $stats = [
            'citation_occurrences' => $totalCitations,
            'nodes_with_citations' => count($citationNodes),
            'unique_sources'       => count($citationMeta),
            'verified_sources'     => $verified,
            'sources_with_content' => $withContent,
            'total_bibliography'   => $totalBib,
        ];

        return ['claims' => $claims, 'stats' => $stats];
    }

    /**
     * Regenerate highlights + markdown report from an existing claims array (skip LLM phases).
     */
    public function regenerateReport(array $claims, string $bookId, string $bookTitle, ?callable $onProgress = null, array $stats = []): string
    {
        $progress = $onProgress ?? fn() => null;

        $highlightCount = $this->createVerificationHighlights($claims, $bookId);
        $progress('highlights', "Created {$highlightCount} verification highlights");

        $md = $this->buildMarkdownReport($claims, $bookId, $bookTitle, $stats);
        $progress('report', "Built markdown report (" . strlen($md) . " bytes)");

        $subBookId = $this->importReportAsSubBook($md, $bookId, $bookTitle);
        $progress('import', "Imported as sub-book: {$subBookId}");

        return $md;
    }

    /**
     * Phase 1: Find nodes with citations, replace anchors with [CITE:refId] markers.
     */
    private function parseCitationNodes(string $bookId): array
    {
        $db = DB::connection('pgsql_admin');

        // Pre-load bibliography referenceIds for validation
        $bibRefIds = $db->table('bibliography')
            ->where('book', $bookId)
            ->pluck('referenceId')
            ->flip()
            ->toArray();

        $nodes = $db->table('nodes')
            ->where('book', $bookId)
            ->select(['node_id', 'content', 'plainText'])
            ->orderBy('startLine')
            ->get();

        $result = [];
        $prevContext = '';

        foreach ($nodes as $node) {
            $content = $node->content ?? '';
            $currentPlain = html_entity_decode(
                $node->plainText ?? strip_tags($node->content ?? ''),
                ENT_QUOTES | ENT_HTML5,
                'UTF-8'
            );

            // Check for any anchor with href="#..."
            if (!preg_match('/<a\s[^>]*href="#([^"]+)"[^>]*>/i', $content)) {
                $prevContext = mb_substr($currentPlain, -500);
                continue;
            }

            // Replace citation anchors with [CITE:refId] markers — only for bibliography refIds
            $marked = preg_replace_callback(
                '/<a\s[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/is',
                function ($m) use ($bibRefIds) {
                    return isset($bibRefIds[$m[1]]) ? '[CITE:' . $m[1] . ']' : $m[0];
                },
                $content
            );
            $marked = strip_tags($marked);

            // Extract reference IDs
            preg_match_all('/\[CITE:([^\]]+)\]/', $marked, $refMatches);
            $referenceIds = array_unique($refMatches[1]);

            if (empty($referenceIds)) {
                $prevContext = mb_substr($currentPlain, -500);
                continue;
            }

            // Compute each citation's character position in plainText
            // by finding the <a> tag byte offset in HTML and counting
            // plain text characters before it (like frontend calculateCleanTextOffset)
            $citationPositions = [];
            if (preg_match_all('/<a\s[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/is', $content, $tagMatches, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
                foreach ($tagMatches as $tagMatch) {
                    $matchedRefId = $tagMatch[1][0]; // captured href fragment
                    $tagByteOffset = $tagMatch[0][1]; // byte offset of full match
                    // Only track positions for bibliography-validated refIds
                    if (isset($bibRefIds[$matchedRefId]) && !isset($citationPositions[$matchedRefId])) {
                        $contentBefore = substr($content, 0, $tagByteOffset);
                        $plainBefore = html_entity_decode(strip_tags($contentBefore), ENT_QUOTES | ENT_HTML5, 'UTF-8');
                        $citationPositions[$matchedRefId] = mb_strlen($plainBefore);
                    }
                }
            }

            // Extract the sentence each citation appears in
            $extractedSentences = [];
            foreach ($citationPositions as $refId => $charPos) {
                $extractedSentences[$refId] = $this->extractSentenceAtPosition($currentPlain, $charPos);
            }

            $result[] = [
                'node_id'             => $node->node_id,
                'marked_text'         => $marked,
                'plainText'           => $currentPlain,
                'reference_ids'       => array_values($referenceIds),
                'preceding_context'   => $prevContext,
                'citationPositions'   => $citationPositions,
                'extracted_sentences' => $extractedSentences,
            ];

            $prevContext = mb_substr($currentPlain, -500);
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

        // Batch query 1: bibliography → foundation_source + citation content
        $bibEntries = $db->table('bibliography')
            ->where('book', $bookId)
            ->whereIn('referenceId', $allRefIds)
            ->select(['referenceId', 'foundation_source', 'content', 'llm_metadata', 'match_method', 'match_score'])
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
                ->select(['book', 'title', 'author', 'year', 'openalex_id', 'open_library_key', 'abstract', 'has_nodes', 'type', 'url', 'doi', 'oa_url'])
                ->get()
                ->keyBy('book');
        }

        // Build lookup map
        $citationMeta = [];
        foreach ($allRefIds as $refId) {
            $bib = $bibEntries[$refId] ?? null;
            $source = $bib->foundation_source ?? null;
            $lib = ($source && $source !== 'unknown') ? ($libraryRecords[$source] ?? null) : null;

            $resolvedSource = ($source && $source !== 'unknown') ? $source : null;

            $citationMeta[$refId] = [
                'title'              => $lib->title ?? null,
                'author'             => $lib->author ?? null,
                'year'               => $lib->year ?? null,
                'abstract'           => $lib->abstract ?? null,
                'verified'           => ($source && $source !== 'unknown' && $lib !== null),
                'source_book_id'     => $resolvedSource,
                'has_source_content' => (bool) ($lib->has_nodes ?? false),
                'bib_citation'       => $bib->content ?? null,
                'source_type'        => $lib->type ?? null,
                'url'                => $lib->url ?? null,
                'doi'                => $lib->doi ?? null,
                'oa_url'             => $lib->oa_url ?? null,
                'llm_metadata'       => is_string($bib->llm_metadata ?? null) ? json_decode($bib->llm_metadata, true) : null,
                'match_method'       => $bib->match_method ?? null,
                'match_score'        => $bib->match_score ?? null,
            ];
        }

        return $citationMeta;
    }

    /**
     * Phase 3: Send citation-bearing nodes to the LLM for truth claim extraction.
     * Processes nodes in concurrent batches of 5 for ~5x speedup.
     */
    private function extractTruthClaims(array $citationNodes, array $citationMeta, callable $progress): array
    {
        $claims = [];
        $nodeCount = count($citationNodes);
        $batchSize = 30;
        $chunks = array_chunk($citationNodes, $batchSize);

        foreach ($chunks as $chunkIndex => $chunk) {
            $offset = $chunkIndex * $batchSize;
            $progress('extract', "Processing nodes " . ($offset + 1) . "-" . ($offset + count($chunk)) . " of {$nodeCount}...");

            // Prepare batch items
            $batchItems = [];
            foreach ($chunk as $node) {
                $context = [];
                foreach ($node['reference_ids'] as $refId) {
                    if (isset($citationMeta[$refId])) {
                        $context[$refId] = $citationMeta[$refId];
                    }
                }
                $markedText = $node['marked_text'];
                if (mb_strlen($markedText) > 3000) {
                    $markedText = mb_substr($markedText, 0, 3000) . '...';
                }
                $batchItems[] = [$markedText, $context, $node['preceding_context'] ?? '', $node['extracted_sentences'] ?? []];
            }

            // Send batch concurrently
            $batchResults = $this->llm->extractTruthClaimsBatch($batchItems);

            // Process results
            foreach ($chunk as $j => $node) {
                $extracted = $batchResults[$j] ?? null;

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

                    if (!in_array($refId, $node['reference_ids'])) {
                        Log::warning("LLM hallucinated referenceId '{$refId}' not in node {$node['node_id']}");
                        continue;
                    }

                    $truthClaim = preg_replace('/\s*\[CITE:[^\]]*\]/', '', $truthClaim);
                    $truthClaim = trim($truthClaim);

                    if (!$truthClaim) {
                        continue;
                    }

                    $markedForMatch = preg_replace('/\s*\[CITE:[^\]]*\]/', '', $node['marked_text']);
                    $normMarked = $this->normaliseQuotes($markedForMatch);
                    $normPlain  = $this->normaliseQuotes($node['plainText']);
                    $normClaim  = $this->normaliseQuotes($truthClaim);

                    $verbatimMatch = mb_stripos($normMarked, $normClaim) !== false
                                  || mb_stripos($normPlain, $normClaim) !== false;

                    if (!$verbatimMatch) {
                        $stripPunct = fn(string $s) => trim(preg_replace('/\s+/', ' ',
                            preg_replace('/[^\p{L}\p{N}\s]+/u', ' ', mb_strtolower($s))));
                        $verbatimMatch = mb_strpos($stripPunct($normMarked), $stripPunct($normClaim)) !== false
                                      || mb_strpos($stripPunct($normPlain), $stripPunct($normClaim)) !== false;
                    }

                    if (!$verbatimMatch) {
                        Log::warning("Truth claim not found verbatim in node {$node['node_id']}", [
                            'refId' => $refId,
                            'claim' => mb_substr($truthClaim, 0, 200),
                        ]);
                        continue;
                    }

                    $plainText = $node['plainText'];
                    $citeCharPos = $node['citationPositions'][$refId] ?? null;

                    if ($citeCharPos !== null) {
                        $before = mb_substr($plainText, 0, $citeCharPos);
                        if (preg_match('/.*[.!?]\s+/su', $before, $m)) {
                            $charStart = mb_strlen($m[0]);
                        } else {
                            $charStart = 0;
                        }
                        $after = mb_substr($plainText, $citeCharPos);
                        if (preg_match('/^.*?[.!?](?:\s|$)/su', $after, $m)) {
                            $charEnd = $citeCharPos + mb_strlen($m[0]);
                        } else {
                            $charEnd = mb_strlen($plainText);
                        }
                    } else {
                        $charStart = mb_strpos($plainText, $truthClaim);
                        if ($charStart === false) {
                            $normPlain = $this->normaliseQuotes($plainText);
                            $normTruth = $this->normaliseQuotes($truthClaim);
                            $charStart = mb_strpos($normPlain, $normTruth);
                        }
                        $charEnd = ($charStart !== false) ? $charStart + mb_strlen($truthClaim) : null;
                        if ($charStart === false) {
                            $charStart = null;
                        }
                    }

                    $highlightId = 'HL_' . abs(crc32($node['node_id'] . $refId));

                    $meta = $citationMeta[$refId] ?? [];

                    $claims[] = [
                        'node_id'              => $node['node_id'],
                        'referenceId'          => $refId,
                        'truth_claim'          => $truthClaim,
                        'contextualised_claim' => $claim['contextualised_claim'] ?? $truthClaim,
                        'verified_source'      => $meta['verified'] ?? false,
                        'source_book_id'       => $meta['source_book_id'] ?? null,
                        'source_title'         => $meta['title'] ?? null,
                        'source_author'        => $meta['author'] ?? null,
                        'source_year'          => $meta['year'] ?? null,
                        'has_source_content'   => $meta['has_source_content'] ?? false,
                        'abstract'             => $meta['abstract'] ?? null,
                        'bib_citation'         => $meta['bib_citation'] ?? null,
                        'source_type'          => $meta['source_type'] ?? null,
                        'source_url'           => $meta['url'] ?? null,
                        'source_doi'           => $meta['doi'] ?? null,
                        'source_oa_url'        => $meta['oa_url'] ?? null,
                        'llm_metadata'         => $meta['llm_metadata'] ?? null,
                        'match_method'         => $meta['match_method'] ?? null,
                        'match_score'          => $meta['match_score'] ?? null,
                        'source_passages'      => [],
                        'llm_verdict'          => null,
                        'evidence_type'        => 'none',
                        'source_material_sent' => null,
                        'charStart'            => $charStart,
                        'charEnd'              => $charEnd,
                        'highlightId'          => $highlightId,
                    ];
                }
            }

            // Rate limit between batches
            if ($chunkIndex < count($chunks) - 1) {
                usleep(250_000);
            }
        }

        return $claims;
    }

    /**
     * Phase 4: Full-text search on source nodes for claims with available content.
     *
     * Uses a multi-strategy approach:
     *   1. AND query with short text (~80 chars) — catches near-verbatim matches
     *   2. OR query with key terms (english config) — catches thematic matches
     *   3. OR query with key terms (simple config) — fallback without stemming
     */
    private function searchSourcePassages(array &$claims, callable $progress): void
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
            $passages = $this->ftsQuery($db, $bookId, $shortText, 'english', 'search_vector', 'plainto_tsquery');

            // Strategy 2: OR query with key terms (catches thematic matches)
            if (empty($passages)) {
                $orTerms = $this->buildOrSearchTerms($searchText);
                if ($orTerms) {
                    $passages = $this->ftsQuery($db, $bookId, $orTerms, 'english', 'search_vector', 'websearch_to_tsquery');
                }
            }

            // Strategy 3: Simple config OR fallback
            if (empty($passages)) {
                $orTerms = $orTerms ?? $this->buildOrSearchTerms($searchText);
                if ($orTerms) {
                    $passages = $this->ftsQuery($db, $bookId, $orTerms, 'simple', 'search_vector_simple', 'websearch_to_tsquery');
                }
            }

            $claim['source_passages'] = array_map(function($p) {
                $text = $p->plainText ?? '';
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
    private function ftsQuery($db, string $bookId, string $query, string $config, string $vectorCol, string $queryFn): array
    {
        return $db->select(
            "SELECT node_id, \"plainText\",
                    ts_rank({$vectorCol}, {$queryFn}('{$config}', ?)) AS rank
             FROM nodes
             WHERE book = ? AND {$vectorCol} @@ {$queryFn}('{$config}', ?)
             ORDER BY rank DESC LIMIT 3",
            [$query, $bookId, $query]
        );
    }

    /**
     * Extract key terms from text and join with OR for websearch_to_tsquery.
     */
    private function buildOrSearchTerms(string $text): string
    {
        $words = preg_split('/[^a-zA-Z0-9\']+/', mb_strtolower($text));
        $words = array_filter($words, fn($w) => mb_strlen($w) > 3);
        $words = array_values(array_unique($words));
        $words = array_slice($words, 0, 15);
        return implode(' OR ', $words);
    }

    /**
     * Phase 5: Verify claims against source material using concurrent LLM batches.
     * Two-phase approach: batch validateAbstract first, then batch verifyCitation.
     */
    private function verifyClaims(array &$claims, callable $progress): void
    {
        $total = count($claims);
        $batchSize = 30;

        // Phase A: Batch all validateAbstract calls for non-web-source claims with abstracts
        $progress('verify', "Validating abstracts...");
        $abstractItems = [];
        $abstractKeyMap = [];

        foreach ($claims as $i => $claim) {
            $isWebSource = ($claim['source_type'] ?? null) === 'web_source';
            if (!empty($claim['abstract']) && !$isWebSource) {
                $abstractKeyMap[] = $i;
                $abstractItems[] = [$claim['abstract'], $claim['source_title'] ?? ''];
            }
        }

        $abstractResults = [];
        if (!empty($abstractItems)) {
            $abstractChunks = array_chunk($abstractItems, $batchSize);
            $processedCount = 0;
            foreach ($abstractChunks as $chunkIndex => $chunk) {
                $batchResults = $this->llm->validateAbstractBatch($chunk);
                foreach ($batchResults as $j => $result) {
                    $claimIndex = $abstractKeyMap[$processedCount + $j];
                    $abstractResults[$claimIndex] = $result;
                }
                $processedCount += count($chunk);
                if ($chunkIndex < count($abstractChunks) - 1) {
                    usleep(250_000);
                }
            }
        }

        // Determine evidence types and build source material for all claims
        $verifyItems = [];
        $verifyKeyMap = [];

        foreach ($claims as $i => &$claim) {
            $hasPassages = !empty($claim['source_passages']);
            $isWebSource = ($claim['source_type'] ?? null) === 'web_source';
            $hasAbstract = false;
            if (!empty($claim['abstract'])) {
                $hasAbstract = $isWebSource || ($abstractResults[$i] ?? false);
            }

            if ($isWebSource) {
                // Web sources get their own evidence tier — content may be truncated
                if ($hasPassages) {
                    $claim['evidence_type'] = 'web_and_passages';
                } elseif ($hasAbstract) {
                    $claim['evidence_type'] = 'web_only';
                }
                // else falls through to title_only/none below
            } elseif ($hasPassages && $hasAbstract) {
                $claim['evidence_type'] = 'abstract_and_passages';
            } elseif ($hasPassages) {
                $claim['evidence_type'] = 'passages_only';
            } elseif ($hasAbstract) {
                $claim['evidence_type'] = 'abstract_only';
            }

            if ($claim['evidence_type'] === 'none') {
                if (!empty($claim['source_title'])) {
                    $claim['evidence_type'] = 'title_only';
                }
            }

            // Short-circuit: no real evidence
            if ($claim['evidence_type'] === 'none') {
                $claim['source_material_sent'] = null;
                $claim['llm_verdict'] = [
                    'support'   => 'insufficient',
                    'summary'   => 'No evidence available',
                    'reasoning' => 'No abstract or source passages available for verification.',
                ];
                continue;
            }

            // Build source material
            $sourceMaterial = '';
            $sourceHeader = array_filter([
                $claim['source_title'] ?? null,
                $claim['source_author'] ?? null,
                isset($claim['source_year']) ? "({$claim['source_year']})" : null,
            ]);
            if ($sourceHeader) {
                $sourceMaterial .= "SOURCE: " . implode(' — ', $sourceHeader) . "\n\n";
            }
            if ($hasAbstract) {
                $abstractLabel = $isWebSource
                    ? "ABSTRACT (scraped from web — may be truncated)"
                    : "ABSTRACT (summary only — does NOT represent the full text)";
                $sourceMaterial .= "{$abstractLabel}:\n{$claim['abstract']}\n\n";
            }
            if ($hasPassages) {
                $count = count($claim['source_passages']);
                $sourceMaterial .= "PASSAGES FROM SOURCE TEXT ({$count} excerpts found by search — the source contains far more text than shown here):\n";
                foreach ($claim['source_passages'] as $j => $p) {
                    $sourceMaterial .= "--- Passage " . ($j + 1) . " ---\n{$p['text']}\n\n";
                }
            }

            $claim['source_material_sent'] = trim($sourceMaterial) ?: null;

            $verifyKeyMap[] = $i;
            $verifyItems[] = [
                $claim['contextualised_claim'] ?? $claim['truth_claim'],
                $sourceMaterial,
                $claim['evidence_type'],
            ];
        }
        unset($claim);

        // Phase B: Batch all verifyCitation calls
        if (!empty($verifyItems)) {
            $verifyChunks = array_chunk($verifyItems, $batchSize);
            $verifyKeyChunks = array_chunk($verifyKeyMap, $batchSize);

            foreach ($verifyChunks as $chunkIndex => $chunk) {
                $chunkStart = $chunkIndex * $batchSize;
                $progress('verify', "Verifying claims " . ($chunkStart + 1) . "-" . ($chunkStart + count($chunk)) . " of " . count($verifyItems) . "...");

                $batchResults = $this->llm->verifyCitationBatch($chunk);

                foreach ($batchResults as $j => $verdict) {
                    $claimIndex = $verifyKeyChunks[$chunkIndex][$j];

                    if ($verdict === null) {
                        $claims[$claimIndex]['llm_verdict'] = [
                            'support'   => 'insufficient',
                            'summary'   => 'LLM verification failed',
                            'reasoning' => 'The verification model did not return a valid response.',
                        ];
                    } else {
                        $claims[$claimIndex]['llm_verdict'] = $verdict;
                    }
                }

                if ($chunkIndex < count($verifyChunks) - 1) {
                    usleep(250_000);
                }
            }
        }

        // Phase C: Review rejected verdicts for false rejections
        $rejectedItems = [];
        $rejectedKeyMap = [];

        foreach ($claims as $i => $claim) {
            if (($claim['llm_verdict']['support'] ?? null) === 'rejected') {
                $sourceDesc = implode(' — ', array_filter([
                    $claim['source_title'] ?? null,
                    $claim['source_author'] ?? null,
                    isset($claim['source_year']) ? "({$claim['source_year']})" : null,
                ]));
                if (!$sourceDesc) {
                    continue;
                }
                $rejectedKeyMap[] = $i;
                $rejectedItems[] = [
                    $sourceDesc,
                    $claim['contextualised_claim'] ?? $claim['truth_claim'],
                ];
            }
        }

        if (!empty($rejectedItems)) {
            $progress('verify', "Reviewing " . count($rejectedItems) . " rejected verdicts for false rejections...");

            $reviewResults = $this->llm->reviewRejectionBatch($rejectedItems);

            $upgraded = 0;
            foreach ($reviewResults as $j => $isConnected) {
                if ($isConnected) {
                    $claimIndex = $rejectedKeyMap[$j];
                    $claims[$claimIndex]['llm_verdict']['support'] = 'unlikely';
                    $claims[$claimIndex]['llm_verdict']['reasoning'] =
                        ($claims[$claimIndex]['llm_verdict']['reasoning'] ?? '') .
                        ' [Upgraded from "rejected" by rejection review: topical connection detected]';
                    $upgraded++;

                    Log::info('Rejection review: upgraded to unlikely', [
                        'source' => $rejectedItems[$j][0],
                        'claim'  => mb_substr($rejectedItems[$j][1], 0, 120),
                    ]);
                }
            }

            if ($upgraded > 0) {
                $progress('verify', "Rejection review: upgraded {$upgraded} of " . count($rejectedItems) . " rejected verdicts to unlikely");
            }
        }

    }

    /**
     * Phase 6: Create verification highlights on truth claims with QwQ reasoning sub-books.
     */
    private function createVerificationHighlights(array &$claims, string $bookId): int
    {
        // Cleanup previous AI review highlights
        $this->highlights->deleteHighlightsByCreator($bookId, 'AIreview:');

        // Derive model name from config
        $rawModel = config('services.llm.verification_model') ?: config('services.llm.model', 'unknown');
        $modelName = basename($rawModel);
        $creator = "AIreview:{$modelName}";

        $count = 0;

        foreach ($claims as $key => $claim) {
            $verdict = $claim['llm_verdict'] ?? null;

            $nodeId      = $claim['node_id'];
            $refId       = $claim['referenceId'];
            $text        = $claim['truth_claim'];
            $charStart   = $claim['charStart'] ?? null;
            $charEnd     = $claim['charEnd'] ?? null;
            $highlightId = $claim['highlightId'] ?? 'HL_' . abs(crc32($nodeId . $refId));

            // --- "Source Not Found" highlight for unresolved citations ---
            if (($claim['verified_source'] ?? true) === false
                && $charStart !== null && $charEnd !== null
            ) {
                $bibText = strip_tags($claim['bib_citation'] ?? '(no bibliography entry)');

                $snfContent = [];
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Verdict: Source Not Found</strong></p>',
                    'plainText' => 'Verdict: Source Not Found',
                ];
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Claim:</strong> ' . e($claim['contextualised_claim'] ?? $text) . '</p>',
                    'plainText' => 'Claim: ' . ($claim['contextualised_claim'] ?? $text),
                ];
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Bibliography entry:</strong> ' . e($bibText) . '</p>',
                    'plainText' => "Bibliography entry: {$bibText}",
                ];
                $sourceNode = $this->buildSourceHtml($claim);
                if ($sourceNode) {
                    $snfContent[] = [
                        'type'      => 'p',
                        'content'   => $sourceNode['content'],
                        'plainText' => $sourceNode['plainText'],
                    ];
                }
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Explanation:</strong> This source could not be found in any academic database (OpenAlex, Semantic Scholar, Open Library). This may be because it is not an academic work, is not professionally published, or uses a non-standard citation format. Human review recommended.</p>',
                    'plainText' => 'Explanation: This source could not be found in any academic database (OpenAlex, Semantic Scholar, Open Library). This may be because it is not an academic work, is not professionally published, or uses a non-standard citation format. Human review recommended.',
                ];
                $snfContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><a href="/' . e($bookId) . '/AIreview#ref_' . e($highlightId) . '">See within full report</a></p>',
                    'plainText' => 'See within full report',
                ];

                // Color all <strong> tags purple (unverified)
                foreach ($snfContent as &$node) {
                    $node['content'] = str_replace('<strong>', '<strong style="color:#9b59b6">', $node['content']);
                }
                unset($node);

                $result = $this->highlights->createHighlight([
                    'bookId'         => $bookId,
                    'nodeId'         => $nodeId,
                    'text'           => $text,
                    'highlightId'    => $highlightId,
                    'creator'        => $creator,
                    'annotation'     => 'Source Not Found — ' . mb_substr($bibText, 0, 120),
                    'subBookContent' => $snfContent,
                    'subBookTitle'   => 'AI Review: Source Not Found',
                    'charStart'      => $charStart,
                    'charEnd'        => $charEnd,
                ]);

                if ($result !== null) {
                    $claims[$key]['has_highlight'] = true;
                    $count++;
                }
                continue;
            }

            // Skip claims with no verdict or insufficient evidence
            if (!$verdict || ($verdict['support'] ?? null) === 'insufficient') {
                continue;
            }

            // Skip claims where charData couldn't be computed
            if ($charStart === null || $charEnd === null) {
                Log::debug('Skipping highlight — charData not available', [
                    'nodeId' => $nodeId,
                    'refId'  => $refId,
                ]);
                continue;
            }

            // Build annotation text (short verdict for hover)
            $supportLabel = match ($verdict['support']) {
                'confirmed'  => 'Confirmed',
                'likely'     => 'Likely',
                'plausible'  => 'Plausible',
                'unlikely'   => 'Unlikely',
                'rejected'   => 'Rejected',
                default      => $verdict['support'],
            };
            $annotation = $supportLabel . ' — ' . mb_substr($verdict['summary'] ?? '', 0, 120);

            // Build sub-book content nodes
            $subBookContent = [];

            // Verdict color (matches the AIreview chart palette)
            $verdictColor = match ($verdict['support']) {
                'confirmed' => '#27ae60',
                'likely'    => '#a3d977',
                'plausible' => '#f1c40f',
                'unlikely'  => '#e67e22',
                'rejected'  => '#e74c3c',
                default     => '#9b59b6',
            };

            // Node 1: Verdict
            $subBookContent[] = [
                'type'      => 'p',
                'content'   => '<p><strong>Verdict: ' . e($supportLabel) . '</strong></p>',
                'plainText' => "Verdict: {$supportLabel}",
            ];

            // Node 2: Claim
            $subBookContent[] = [
                'type'      => 'p',
                'content'   => '<p><strong>Claim:</strong> ' . e($claim['contextualised_claim'] ?? $text) . '</p>',
                'plainText' => 'Claim: ' . ($claim['contextualised_claim'] ?? $text),
            ];

            // Node 3: Source info (with links)
            $sourceNode = $this->buildSourceHtml($claim);
            if ($sourceNode) {
                $subBookContent[] = [
                    'type'      => 'p',
                    'content'   => $sourceNode['content'],
                    'plainText' => $sourceNode['plainText'],
                ];
            }

            // Node 4: Evidence type
            $evidenceType = $verdict['evidence_type'] ?? null;
            if ($evidenceType) {
                $evidenceLabel = match ($evidenceType) {
                    'abstract_only'     => 'Abstract only',
                    'abstract_passage'  => 'Abstract + source passages',
                    'passage_only'      => 'Source passages only',
                    'web_and_passages'  => 'Web page content (partial) + passages',
                    'web_only'          => 'Web page content (partial)',
                    'title_only'        => 'Title only (no abstract or passages)',
                    'none'              => 'No evidence',
                    default             => $evidenceType,
                };
                $subBookContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Evidence:</strong> ' . e($evidenceLabel) . '</p>',
                    'plainText' => "Evidence: {$evidenceLabel}",
                ];
            }

            // Node 5: Summary
            if (!empty($verdict['summary'])) {
                $subBookContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Summary:</strong> ' . e($verdict['summary']) . '</p>',
                    'plainText' => 'Summary: ' . $verdict['summary'],
                ];
            }

            // Node 6: Reasoning (concise field, NOT the raw thinking chain)
            if (!empty($verdict['reasoning'])) {
                $subBookContent[] = [
                    'type'      => 'p',
                    'content'   => '<p><strong>Reasoning:</strong> ' . e($verdict['reasoning']) . '</p>',
                    'plainText' => 'Reasoning: ' . $verdict['reasoning'],
                ];
            }

            $subBookContent[] = [
                'type'      => 'p',
                'content'   => '<p><a href="/' . e($bookId) . '/AIreview#ref_' . e($highlightId) . '">See within full report</a></p>',
                'plainText' => 'See within full report',
            ];

            // Color all <strong> tags with the verdict color
            foreach ($subBookContent as &$node) {
                $node['content'] = str_replace('<strong>', '<strong style="color:' . $verdictColor . '">', $node['content']);
            }
            unset($node);

            $result = $this->highlights->createHighlight([
                'bookId'         => $bookId,
                'nodeId'         => $nodeId,
                'text'           => $text,
                'highlightId'    => $highlightId,
                'creator'        => $creator,
                'annotation'     => $annotation,
                'subBookContent' => $subBookContent,
                'subBookTitle'   => "AI Review: {$supportLabel}",
                'charStart'      => $charStart,
                'charEnd'        => $charEnd,
            ]);

            if ($result !== null) {
                $claims[$key]['has_highlight'] = true;
                $count++;
            }
        }

        return $count;
    }

    /**
     * Build a markdown report from the claims array.
     */
    public function buildMarkdownReport(array $claims, string $bookId, string $bookTitle, array $stats = []): string
    {
        $md = "# AI Citation Review\n\n";

        // Build citation line from library metadata
        $db = DB::connection('pgsql_admin');
        $bookMeta = $db->table('library')->where('book', $bookId)->first();
        $citationParts = [];
        $title = $bookMeta->title ?? $bookTitle;
        $externalUrl = $bookMeta->doi ? 'https://doi.org/' . $bookMeta->doi : ($bookMeta->oa_url ?? $bookMeta->url ?? null);
        $citationParts[] = $externalUrl ? "[{$title}]({$externalUrl})" : "[{$title}](/{$bookId})";
        if (!empty($bookMeta->author)) {
            $citationParts[] = $bookMeta->author;
        }
        if (!empty($bookMeta->year)) {
            $citationParts[] = "({$bookMeta->year})";
        }
        $md .= "Text: " . implode(' — ', $citationParts) . "\n\n";
        $md .= "Date: " . now()->toDateTimeString() . "\n";
        if (!empty($stats)) {
            $md .= "Citations in text: {$stats['citation_occurrences']} (across {$stats['nodes_with_citations']} paragraphs)\n";
            $md .= "Unique sources cited: {$stats['unique_sources']} ({$stats['verified_sources']} verified, {$stats['sources_with_content']} with full text)\n";
        }
        $md .= "## Known Unknown Citations \n\n";

        // Source coverage pie chart
        $sourcesFound = $stats['verified_sources'] ?? 0;
        $sourcesNotFound = ($stats['total_bibliography'] ?? $stats['unique_sources'] ?? 0) - $sourcesFound;

        $md .= '<table data-chart="source-coverage"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>';
        $md .= '<tr><td>Source Found</td><td>' . $sourcesFound . '</td></tr>';
        $md .= '<tr><td>Source Not Found</td><td>' . $sourcesNotFound . '</td></tr>';
        $md .= "</tbody></table>\n\n";

        $md .= "> Citations are matched against: [OpenAlex](https://openalex.org), [Open Library](https://openlibrary.org), [Semantic Scholar](https://www.semanticscholar.org), and [Brave Search](https://search.brave.com). Unmatched citations may be legit sources, but are worth reviewing.\n\n";

        $md .= "## Results\n\n";

        // Categorise — unverified sources first, then by LLM verdict
        $unverified = [];
        $confirmed = [];
        $likely = [];
        $plausible = [];
        $unlikely = [];
        $rejected = [];

        foreach ($claims as $claim) {
            if (empty($claim['source_book_id'])) {
                $unverified[] = $claim;
                continue;
            }
            $support = $claim['llm_verdict']['support'] ?? 'insufficient';
            match ($support) {
                'confirmed'  => $confirmed[] = $claim,
                'likely'     => $likely[] = $claim,
                'plausible'  => $plausible[] = $claim,
                'unlikely'   => $unlikely[] = $claim,
                'rejected'   => $rejected[] = $claim,
                default      => $unverified[] = $claim,
            };
        }

        // Summary table — rendered as bar chart on the frontend via chartRenderer.js
        $md .= '<table data-chart="verdict-summary"><thead><tr><th>Verdict</th><th>Count</th></tr></thead><tbody>' . "\n";
        $md .= '<tr><td>Unverified Sources</td><td>' . count($unverified) . "</td></tr>\n";
        $md .= '<tr><td>Rejected</td><td>' . count($rejected) . "</td></tr>\n";
        $md .= '<tr><td>Unlikely</td><td>' . count($unlikely) . "</td></tr>\n";
        $md .= '<tr><td>Plausible</td><td>' . count($plausible) . "</td></tr>\n";
        $md .= '<tr><td>Likely</td><td>' . count($likely) . "</td></tr>\n";
        $md .= '<tr><td>Confirmed</td><td>' . count($confirmed) . "</td></tr>\n";
        $md .= "</tbody></table>\n\n";

        $extractionModel = basename(config('services.llm.extraction_model'));
        $verificationModel = basename(config('services.llm.verification_model'));
        $md .= "> Truth claims are extracted by [{$extractionModel}] and verified by [{$verificationModel}]. This is designed to help triage manual citation review by humans. It is not a replacement for biological peer review.\n\n";

        $md .= "---\n\n";

        // Sections — strongest concern first
        if (!empty($rejected)) {
            $md .= "## Rejected\n\n";
            foreach ($rejected as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($unlikely)) {
            $md .= "# Unlikely\n\n";
            foreach ($unlikely as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($unverified)) {
            $md .= "# Unverified Sources\n\n";
            $md .= "These citations reference sources that were never found in any database.\n\n";

            // Group by source type
            $typeOrder = [
                'book' => 'Books',
                'journal-article' => 'Journal Articles',
                'book-chapter' => 'Book Chapters',
                'conference-paper' => 'Conference Papers',
                'thesis' => 'Theses',
                'report' => 'Reports',
                'news-article' => 'News Articles',
                'archival-source' => 'Archival Sources',
                'youtube-video' => 'YouTube Videos',
                'website' => 'Websites',
                'other' => 'Other',
            ];
            $academicTypes = ['book', 'journal-article', 'book-chapter', 'conference-paper', 'thesis', 'report'];

            $grouped = [];
            foreach ($unverified as $c) {
                $type = $c['llm_metadata']['type'] ?? 'unknown';
                if (!isset($typeOrder[$type])) {
                    $type = 'unknown';
                }
                $grouped[$type][] = $c;
            }

            // Render in defined order, then unknown at the end
            $orderedKeys = array_keys($typeOrder);
            $orderedKeys[] = 'unknown';

            foreach ($orderedKeys as $type) {
                if (empty($grouped[$type])) {
                    continue;
                }
                $label = $typeOrder[$type] ?? 'Unknown Type';
                $count = count($grouped[$type]);
                $md .= "## {$label} ({$count})\n\n";

                if (in_array($type, $academicTypes, true)) {
                    $md .= "> Not found in any academic database — higher priority for manual review.\n\n";
                } else {
                    $md .= "> Not found — non-academic sources are not expected in academic databases.\n\n";
                }

                foreach ($grouped[$type] as $c) {
                    $md .= $this->formatClaimMd($c, $bookId);
                }
            }
        }

        if (!empty($plausible)) {
            $md .= "# Plausible\n\n";
            foreach ($plausible as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($likely)) {
            $md .= "# Likely\n\n";
            foreach ($likely as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($confirmed)) {
            $md .= "# Confirmed\n\n";
            foreach ($confirmed as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        $md .= $this->buildAppendixMd($claims, $bookId, $stats, $db);

        return $md;
    }

    /**
     * Build the Appendix: Pipeline Diagnostics section for the markdown report.
     */
    private function buildAppendixMd(array $claims, string $bookId, array $stats, $db): string
    {
        $md = "\n# Appendix: Pipeline Diagnostics\n\n";

        // --- Timing (from citation_pipelines) ---
        $pipelineId = $stats['pipeline_id'] ?? null;
        $pipeline = null;

        if ($pipelineId) {
            $pipeline = $db->table('citation_pipelines')->where('id', $pipelineId)->first();
        }

        // Fallback: find the most recent completed pipeline for this book
        if (!$pipeline) {
            $pipeline = $db->table('citation_pipelines')
                ->where('book', $bookId)
                ->whereIn('status', ['completed', 'running'])
                ->orderByDesc('created_at')
                ->first();
        }

        $stepTimings = null;

        if ($pipeline) {
            $started = $pipeline->created_at ?? null;
            $completed = $pipeline->updated_at ?? null;

            $md .= "## Timing\n\n";
            $md .= "| Metric | Value |\n|--------|-------|\n";

            if ($started && $completed) {
                $startTime = \Carbon\Carbon::parse($started);
                $endTime = \Carbon\Carbon::parse($completed);
                $diffSeconds = $startTime->diffInSeconds($endTime);
                $md .= "| Total duration | " . $this->formatDuration($diffSeconds) . " |\n";
            }
            if ($started) {
                $md .= "| Started | {$started} |\n";
            }
            if ($completed) {
                $md .= "| Completed | {$completed} |\n";
            }

            $md .= "\n";

            // Step timings
            $stepTimings = isset($pipeline->step_timings) ? json_decode($pipeline->step_timings, true) : null;
            if (!empty($stepTimings)) {
                $stepLabels = [
                    'bibliography' => 'Bibliography scan',
                    'content'      => 'Content scan',
                    'vacuum'       => 'Vacuum (fetch)',
                    'ocr'          => 'OCR',
                    'review'       => 'Review',
                ];

                $md .= "## Step Timings\n\n";
                $md .= "| Step | Duration |\n|------|----------|\n";

                foreach ($stepLabels as $key => $label) {
                    if (isset($stepTimings[$key]['duration_seconds'])) {
                        $md .= "| {$label} | " . $this->formatDuration($stepTimings[$key]['duration_seconds']) . " |\n";
                    } elseif (isset($stepTimings[$key])) {
                        $md .= "| {$label} | N/A |\n";
                    }
                }

                $md .= "\n";
            }
        }

        // --- Bibliography Resolution (from citation_scans) ---
        $scan = $db->table('citation_scans')
            ->where('book', $bookId)
            ->whereIn('status', ['completed', 'running'])
            ->orderByDesc('created_at')
            ->first();

        if ($scan) {
            $md .= "## Bibliography Resolution\n\n";
            $md .= "| Metric | Count |\n|--------|-------|\n";
            $md .= "| Total entries | {$scan->total_entries} |\n";
            $md .= "| Already linked | {$scan->already_linked} |\n";
            $md .= "| Newly resolved | {$scan->newly_resolved} |\n";
            $md .= "| Enriched existing | {$scan->enriched_existing} |\n";
            $md .= "| Failed to resolve | {$scan->failed_to_resolve} |\n";
            $md .= "\n";

            // Resolution Methods breakdown from results JSONB
            $results = isset($scan->results) ? json_decode($scan->results, true) : null;
            if (!empty($results)) {
                $methodCounts = [];
                foreach ($results as $r) {
                    $method = $r['match_method'] ?? null;
                    if ($method) {
                        $methodCounts[$method] = ($methodCounts[$method] ?? 0) + 1;
                    }
                }

                if (!empty($methodCounts)) {
                    arsort($methodCounts);

                    $methodLabels = [
                        'local_doi'          => 'Local DOI',
                        'doi'                => 'DOI (OpenAlex)',
                        'library'            => 'Local library',
                        'openalex'           => 'OpenAlex (title search)',
                        'open_library'       => 'Open Library',
                        'semantic_scholar'   => 'Semantic Scholar',
                        'web_fetch'          => 'Web fetch',
                        'brave_search'       => 'Brave Search',
                    ];

                    $md .= "## Resolution Methods\n\n";
                    $md .= "| Method | Count |\n|--------|-------|\n";

                    foreach ($methodCounts as $method => $count) {
                        $label = $methodLabels[$method] ?? $method;
                        $md .= "| {$label} | {$count} |\n";
                    }

                    $md .= "\n";
                }
            }
        }

        // --- Evidence Available for Verification (from $claims) ---
        $evidenceCounts = [];
        foreach ($claims as $claim) {
            $type = $claim['evidence_type'] ?? 'none';
            $evidenceCounts[$type] = ($evidenceCounts[$type] ?? 0) + 1;
        }

        if (!empty($evidenceCounts)) {
            $evidenceLabels = [
                'abstract_and_passages' => 'Abstract + passages',
                'abstract_only'         => 'Abstract only',
                'passages_only'         => 'Passages only',
                'web_and_passages'      => 'Web + passages',
                'web_only'              => 'Web only',
                'title_only'            => 'Title only',
                'none'                  => 'None',
            ];

            // Sort by count descending
            arsort($evidenceCounts);

            $md .= "## Evidence Available for Verification\n\n";
            $md .= "| Evidence Type | Claims |\n|---------------|--------|\n";

            foreach ($evidenceCounts as $type => $count) {
                $label = $evidenceLabels[$type] ?? $type;
                $md .= "| {$label} | {$count} |\n";
            }

            $md .= "\n";
        }

        // --- LLM Usage (Review Step) ---
        $llmUsage = $stats['llm_usage'] ?? null;
        $pricing = config('services.llm.pricing', []);

        if ($llmUsage && ($llmUsage['total_requests'] ?? 0) > 0) {
            $md .= "## LLM Usage (Review Step)\n\n";

            // New per-model format — transposed so models are columns
            if (!empty($llmUsage['by_model'])) {
                // Collect per-model data
                $models = [];
                $totalPrompt = 0;
                $totalCompletion = 0;
                $totalCost = 0.0;
                $totalModelRequests = 0;

                foreach ($llmUsage['by_model'] as $model => $usage) {
                    $shortName = basename($model);
                    $prompt = $usage['prompt_tokens'] ?? 0;
                    $completion = $usage['completion_tokens'] ?? 0;
                    $requests = $usage['requests'] ?? 0;

                    $totalPrompt += $prompt;
                    $totalCompletion += $completion;
                    $totalModelRequests += $requests;

                    $modelPricing = $pricing[$model] ?? null;
                    if ($modelPricing && isset($modelPricing['input'], $modelPricing['output'])) {
                        $cost = ($prompt / 1_000_000 * $modelPricing['input'])
                              + ($completion / 1_000_000 * $modelPricing['output']);
                        $totalCost += $cost;
                        $costStr = '$' . number_format($cost, 2);
                    } else {
                        $cost = 0;
                        $costStr = '—';
                    }

                    $models[] = [
                        'name'       => $shortName,
                        'requests'   => number_format($requests),
                        'prompt'     => number_format($prompt),
                        'completion' => number_format($completion),
                        'cost'       => $costStr,
                    ];
                }

                $failed = $llmUsage['failed_requests'] ?? 0;
                $totalReqStr = '**' . number_format($llmUsage['total_requests']) . '**';
                if ($failed > 0) {
                    $totalReqStr .= " ({$failed} failed)";
                }

                // Build transposed table: Metric column + one column per model + Total
                $header = '| Metric |';
                $sep = '|--------|';
                foreach ($models as $m) {
                    $header .= " {$m['name']} |";
                    $sep .= '--------|';
                }
                $header .= " **Total** |";
                $sep .= '--------|';

                $md .= "{$header}\n{$sep}\n";
                $md .= '| Requests |';
                foreach ($models as $m) { $md .= " {$m['requests']} |"; }
                $md .= " {$totalReqStr} |\n";

                $md .= '| Prompt tokens |';
                foreach ($models as $m) { $md .= " {$m['prompt']} |"; }
                $md .= " **" . number_format($totalPrompt) . "** |\n";

                $md .= '| Completion tokens |';
                foreach ($models as $m) { $md .= " {$m['completion']} |"; }
                $md .= " **" . number_format($totalCompletion) . "** |\n";

                $md .= '| Est. cost |';
                foreach ($models as $m) { $md .= " {$m['cost']} |"; }
                $md .= " **\$" . number_format($totalCost, 2) . "** |\n";
            } else {
                // Backwards compatibility: old flat format
                $md .= "| Metric | Value |\n|--------|-------|\n";
                $md .= "| API requests | " . number_format($llmUsage['total_requests']) . " |\n";
                $md .= "| Failed requests | " . number_format($llmUsage['failed_requests']) . " |\n";
                $md .= "| Prompt tokens | " . number_format($llmUsage['prompt_tokens']) . " |\n";
                $md .= "| Completion tokens | " . number_format($llmUsage['completion_tokens']) . " |\n";
                $md .= "| Total tokens | " . number_format($llmUsage['prompt_tokens'] + $llmUsage['completion_tokens']) . " |\n";
            }
            $md .= "\n";
        }

        // --- OCR Cost ---
        $ocrTotalPages = $stepTimings['ocr']['total_pages'] ?? null;
        if ($ocrTotalPages !== null && $ocrTotalPages > 0) {
            $ocrPricing = $pricing['mistral-ocr-latest'] ?? null;
            $ocrCostStr = '—';
            if ($ocrPricing && isset($ocrPricing['per_1k_pages'])) {
                $ocrCost = $ocrTotalPages / 1000 * $ocrPricing['per_1k_pages'];
                $ocrCostStr = '$' . number_format($ocrCost, 2);
            }

            $md .= "## OCR\n\n";
            $md .= "| Metric | Value |\n|--------|-------|\n";
            $md .= "| Pages processed | " . number_format($ocrTotalPages) . " |\n";
            $md .= "| Est. cost | {$ocrCostStr} |\n";
            $md .= "\n";
        }

        // --- Models ---
        $metadataModel = basename(config('services.llm.model', 'unknown'));
        $extractionModel = basename(config('services.llm.extraction_model', 'unknown'));
        $verificationModel = basename(config('services.llm.verification_model', 'unknown'));
        $provider = parse_url(config('services.llm.base_url', ''), PHP_URL_HOST) ?: 'unknown';

        $md .= "## Models\n\n";
        $md .= "| Role | Model |\n|------|-------|\n";
        $md .= "| Metadata extraction | {$metadataModel} |\n";
        $md .= "| Claim extraction | {$extractionModel} |\n";
        $md .= "| Verification | {$verificationModel} |\n";
        if (config('services.mistral_ocr.api_key')) {
            $md .= "| OCR | mistral-ocr-latest |\n";
        }
        $md .= "| Provider | {$provider} |\n";
        $md .= "\n";

        return $md;
    }

    /**
     * Format seconds into a human-readable duration string.
     */
    private function formatDuration(int $seconds): string
    {
        if ($seconds < 60) {
            return "{$seconds}s";
        }

        $minutes = intdiv($seconds, 60);
        $secs = $seconds % 60;

        if ($minutes < 60) {
            return $secs > 0 ? "{$minutes}m {$secs}s" : "{$minutes}m";
        }

        $hours = intdiv($minutes, 60);
        $mins = $minutes % 60;
        return $mins > 0 ? "{$hours}h {$mins}m" : "{$hours}h";
    }

    /**
     * Resolve the best external URL for a source (DOI > OA URL > URL).
     */
    private function resolveSourceUrl(array $claim): ?string
    {
        if (!empty($claim['source_doi'])) {
            return 'https://doi.org/' . $claim['source_doi'];
        }
        if (!empty($claim['source_oa_url'])) {
            return $claim['source_oa_url'];
        }
        if (!empty($claim['source_url'])) {
            return $claim['source_url'];
        }
        return null;
    }

    /**
     * Build source HTML for highlight sub-book nodes.
     * Returns ['content' => ..., 'plainText' => ...] for a <p> node.
     */
    private function buildSourceHtml(array $claim): ?array
    {
        $sourceInfo = array_filter([
            $claim['source_title'] ?? null,
            $claim['source_author'] ?? null,
            isset($claim['source_year']) ? "({$claim['source_year']})" : null,
        ]);

        if (empty($sourceInfo)) {
            return null;
        }

        $externalUrl = $this->resolveSourceUrl($claim);
        $title = $claim['source_title'] ?? '';
        $otherParts = array_filter([
            $claim['source_author'] ?? null,
            isset($claim['source_year']) ? "({$claim['source_year']})" : null,
        ]);

        // Build HTML: title as link if URL exists, then author/year
        if ($externalUrl && $title) {
            $linkedTitle = '<a href="' . e($externalUrl) . '" target="_blank">' . e($title) . '</a>';
        } else {
            $linkedTitle = e($title ?: implode(' — ', $sourceInfo));
        }

        $parts = $linkedTitle;
        if ($title && !empty($otherParts)) {
            $parts .= ' — ' . e(implode(' — ', $otherParts));
        }

        // Arrow link to source book if it has content
        if (!empty($claim['has_source_content']) && !empty($claim['source_book_id'])) {
            $parts .= ' <a href="/' . e($claim['source_book_id']) . '">→</a>';
        }

        $plainText = 'Source: ' . implode(' — ', $sourceInfo);

        return [
            'content'   => '<p><strong>Source:</strong> ' . $parts . '</p>',
            'plainText' => $plainText,
        ];
    }

    /**
     * Build source markdown for the report.
     */
    private function buildSourceMd(array $claim): ?string
    {
        $title = $claim['source_title'] ?? null;
        $author = $claim['source_author'] ?? null;
        $year = isset($claim['source_year']) ? "({$claim['source_year']})" : null;

        $sourceInfo = array_filter([$title, $author, $year]);
        if (empty($sourceInfo)) {
            return null;
        }

        $externalUrl = $this->resolveSourceUrl($claim);

        // Title as markdown link if URL exists
        if ($externalUrl && $title) {
            $linkedTitle = "[{$title}]({$externalUrl})";
        } else {
            $linkedTitle = $title ?: implode(' — ', $sourceInfo);
        }

        $otherParts = array_filter([$author, $year]);
        $md = $linkedTitle;
        if ($title && !empty($otherParts)) {
            $md .= ' — ' . implode(' — ', $otherParts);
        }

        // Arrow link to source book if it has content
        if (!empty($claim['has_source_content']) && !empty($claim['source_book_id'])) {
            $md .= ' [→](/' . $claim['source_book_id'] . ')';
        }

        return "**Source:** {$md}\n";
    }

    /**
     * Build match diagnostics: score, method, and mismatch warnings.
     */
    private function buildMatchDiagnosticsMd(array $claim): string
    {
        $lines = [];
        $matchScore  = $claim['match_score'] ?? null;
        $matchMethod = $claim['match_method'] ?? null;
        $llmMeta     = $claim['llm_metadata'] ?? null;

        // Score + method line
        if ($matchMethod || $matchScore !== null) {
            $methodLabels = [
                'local_doi'          => 'Local DOI',
                'doi'                => 'DOI (OpenAlex)',
                'library'            => 'Local library',
                'openalex'           => 'OpenAlex (title search)',
                'open_library'       => 'Open Library',
                'semantic_scholar'   => 'Semantic Scholar',
                'web_fetch'          => 'Web fetch',
                'brave_search'       => 'Brave Search',
            ];

            $parts = [];
            if ($matchScore !== null) {
                $parts[] = round($matchScore * 100, 1) . '%';
            }
            if ($matchMethod) {
                $parts[] = $methodLabels[$matchMethod] ?? $matchMethod;
            }

            $line = '**Match:** ' . implode(' — ', $parts);
            if ($matchScore !== null && $matchScore < 0.6) {
                $line .= ' — *this was the closest match found*';
            }
            $lines[] = $line;
        }

        if (!is_array($llmMeta)) {
            return empty($lines) ? '' : implode("\n", $lines) . "\n";
        }

        // Year mismatch
        $llmYear    = $llmMeta['year'] ?? null;
        $sourceYear = $claim['source_year'] ?? null;
        if ($llmYear && $sourceYear && (string) $llmYear !== (string) $sourceYear) {
            $lines[] = "\u{26A0} Year mismatch: bibliography says {$llmYear}, matched source says {$sourceYear}";
        }

        // Author mismatch — lightweight first-surname check
        $llmAuthors   = $llmMeta['authors'] ?? null;
        $sourceAuthor = $claim['source_author'] ?? null;
        if ($llmAuthors && $sourceAuthor) {
            $llmAuthorStr = is_array($llmAuthors) ? implode('; ', $llmAuthors) : (string) $llmAuthors;
            $extractSurname = function (string $name): string {
                $name = trim($name);
                // "Surname, First" → Surname
                if (str_contains($name, ',')) {
                    return mb_strtolower(trim(explode(',', $name)[0]));
                }
                // "First Surname" → Surname (last word)
                $words = preg_split('/\s+/', $name);
                return mb_strtolower(end($words));
            };

            $llmSurnames = [];
            $authors = is_array($llmAuthors) ? $llmAuthors : preg_split('/[;,]\s*/', (string) $llmAuthors);
            foreach ($authors as $a) {
                $s = $extractSurname($a);
                if ($s !== '') $llmSurnames[] = $s;
            }

            $sourceLower = mb_strtolower($sourceAuthor);
            $hasOverlap = false;
            foreach ($llmSurnames as $surname) {
                if (mb_strpos($sourceLower, $surname) !== false) {
                    $hasOverlap = true;
                    break;
                }
            }

            if (!$hasOverlap && !empty($llmSurnames)) {
                $lines[] = "\u{26A0} Author mismatch: bibliography has \"{$llmAuthorStr}\" but source has \"{$sourceAuthor}\"";
            }
        }

        // Publisher mismatch
        $llmPublisher = $llmMeta['publisher'] ?? null;
        // Source publisher would be in library record — not currently passed through,
        // so skip this check unless both sides have data.

        // Title difference — use simple_title_similarity since we can't call OpenAlexService here
        $llmTitle    = $llmMeta['title'] ?? null;
        $sourceTitle = $claim['source_title'] ?? null;
        if ($llmTitle && $sourceTitle) {
            $sim = $this->simpleTitleSimilarity($llmTitle, $sourceTitle);
            if ($sim < 0.7) {
                $lines[] = "\u{26A0} Title differs: bibliography has \"{$llmTitle}\" but matched source is \"{$sourceTitle}\"";
            }
        }

        return empty($lines) ? '' : implode("\n", $lines) . "\n";
    }

    /**
     * Simple word-overlap title similarity (0.0–1.0) for diagnostic warnings.
     */
    private function simpleTitleSimilarity(string $a, string $b): float
    {
        $stopWords = ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'by', 'with', 'from', 'at', 'is', 'as'];
        $tokenise = function (string $text) use ($stopWords): array {
            $text = mb_strtolower(preg_replace('/[^\p{L}\p{N}\s]/u', '', $text));
            $words = preg_split('/\s+/', $text, -1, PREG_SPLIT_NO_EMPTY);
            return array_values(array_diff($words, $stopWords));
        };

        $wordsA = $tokenise($a);
        $wordsB = $tokenise($b);
        if (empty($wordsA) || empty($wordsB)) {
            return 0.0;
        }

        $intersection = count(array_intersect($wordsA, $wordsB));
        $union = count(array_unique(array_merge($wordsA, $wordsB)));

        return $union > 0 ? $intersection / $union : 0.0;
    }

    /**
     * Extract the sentence surrounding a character position in plain text.
     * Uses the same regex logic as the charStart/charEnd computation in extractTruthClaims().
     */
    private function extractSentenceAtPosition(string $plainText, int $charPos): string
    {
        $before = mb_substr($plainText, 0, $charPos);
        if (preg_match('/.*[.!?]\s+/su', $before, $m)) {
            $start = mb_strlen($m[0]);
        } else {
            $start = 0;
        }
        $after = mb_substr($plainText, $charPos);
        if (preg_match('/^.*?[.!?](?:\s|$)/su', $after, $m)) {
            $end = $charPos + mb_strlen($m[0]);
        } else {
            $end = mb_strlen($plainText);
        }
        return trim(mb_substr($plainText, $start, $end - $start));
    }

    /**
     * Normalise Unicode punctuation and whitespace for verbatim comparison.
     */
    private function normaliseQuotes(string $s): string
    {
        // Decode HTML entities (strip_tags leaves &amp; &nbsp; etc. intact)
        $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        // Smart quotes and apostrophes → ASCII (including modifier letter, reversed, prime)
        $s = str_replace(
            ["\u{2018}", "\u{2019}", "\u{201A}", "\u{201B}", "\u{2032}", "\u{02BC}", "\u{FF07}"],
            "'", $s
        );
        $s = str_replace(
            ["\u{201C}", "\u{201D}", "\u{201E}", "\u{201F}", "\u{2033}", "\u{00AB}", "\u{00BB}"],
            '"', $s
        );
        // All dash-like characters → ASCII hyphen
        $s = str_replace(
            ["\u{2010}", "\u{2011}", "\u{2012}", "\u{2013}", "\u{2014}", "\u{2015}", "\u{FE58}", "\u{FF0D}"],
            '-', $s
        );
        // Non-breaking space and other Unicode whitespace → regular space
        $s = str_replace(["\u{00A0}", "\u{202F}", "\u{2007}", "\u{200B}"], ' ', $s);
        // Collapse multiple whitespace
        $s = preg_replace('/\s+/', ' ', $s);
        return $s;
    }

    private function formatClaimMd(array $claim, string $bookId): string
    {
        $refId = $claim['referenceId'];
        $verdict = $claim['llm_verdict'] ?? [];

        $evidenceLabel = match ($claim['evidence_type'] ?? 'none') {
            'abstract_and_passages' => 'Abstract + passages',
            'web_and_passages'      => 'Web page content (partial) + passages',
            'passages_only'         => 'Passages only',
            'abstract_only'         => 'Abstract only',
            'web_only'              => 'Web page content (partial)',
            'title_only'            => 'Title only (no abstract or passages)',
            default                 => 'None',
        };

        $verdictLabel = match ($verdict['support'] ?? 'insufficient') {
            'confirmed'  => 'Confirmed',
            'likely'     => 'Likely',
            'plausible'  => 'Plausible',
            'unlikely'   => 'Unlikely',
            'rejected'   => 'Rejected',
            default      => 'No Evidence',
        };

        $md = '';

        // Source first (as heading-style line)
        $sourceMdLine = $this->buildSourceMd($claim);
        if ($sourceMdLine) {
            $md .= $sourceMdLine;
        }

        // Match diagnostics (score, method, mismatch warnings)
        $diagnostics = $this->buildMatchDiagnosticsMd($claim);
        if ($diagnostics) {
            $md .= $diagnostics;
        }

        $bibCitation = $claim['bib_citation'] ?? null;
        if ($bibCitation) {
            $bibPlain = html_entity_decode(strip_tags($bibCitation), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $md .= "> {$bibPlain}\n\n";
        }
        if (!empty($claim['has_highlight'])) {
            $highlightId = $claim['highlightId'] ?? 'HL_' . abs(crc32($claim['node_id'] . $refId));
            $md .= "**Claim:** \"{$claim['truth_claim']}\" <a id=\"ref_{$highlightId}\" href=\"/{$bookId}#{$highlightId}\">←</a>\n";
        } else {
            $md .= "**Claim:** \"{$claim['truth_claim']}\"\n";
        }
        if (!empty($claim['contextualised_claim']) && $claim['contextualised_claim'] !== $claim['truth_claim']) {
            $md .= "**Contextualised:** \"{$claim['contextualised_claim']}\"\n";
        }
        $md .= "**Evidence:** {$evidenceLabel}\n";
        $md .= "**Verdict:** {$verdictLabel}\n";

        if (!empty($verdict['summary'])) {
            $md .= "**Summary:** {$verdict['summary']}\n";
        }
        if (!empty($verdict['reasoning'])) {
            $md .= "**Reasoning:** {$verdict['reasoning']}\n";
        }

        // Show cited passages with actual text
        $citedNums = $verdict['cited_passages'] ?? [];
        if (!empty($citedNums) && !empty($claim['source_passages'])) {
            $md .= "\n**Cited source passages:**\n";
            foreach ($citedNums as $num) {
                $idx = $num - 1; // passage numbers are 1-indexed
                if (isset($claim['source_passages'][$idx])) {
                    $p = $claim['source_passages'][$idx];
                    $text = mb_substr($p['text'], 0, 300);
                    $md .= "> **Passage {$num}** (`{$p['node_id']}`, rank: {$p['rank']}):\n";
                    $quoted = implode("\n", array_map(fn($l) => "> {$l}", explode("\n", $text)));
                    $md .= "{$quoted}\n\n";
                }
            }
        }

        // Include source material as blockquote (truncated for readability)
        if (!empty($claim['source_material_sent'])) {
            $sourceMd = $claim['source_material_sent'];
            if (mb_strlen($sourceMd) > 1500) {
                $sourceMd = mb_substr($sourceMd, 0, 1500) . "\n(truncated)";
            }
            $quoted = implode("\n", array_map(fn($line) => "> {$line}", explode("\n", $sourceMd)));
            $md .= "\n> **Source material sent to LLM:**\n{$quoted}\n";
        }

        $md .= "\n---\n\n";
        return $md;
    }

    /**
     * Import a markdown report as a sub-book viewable at /{bookId}/AIreview.
     */
    public function importReportAsSubBook(string $md, string $bookId, string $bookTitle): string
    {
        $subBookId = SubBookIdHelper::build($bookId, 'AIreview');
        $safeDir = str_replace('/', '_', $subBookId);
        $path = resource_path("markdown/{$safeDir}");

        // Write markdown
        File::ensureDirectoryExists($path);
        File::put("{$path}/original.md", $md);

        // Clean stale outputs from previous runs
        foreach (['nodes.json', 'footnotes.json', 'audit.json', 'references.json', 'intermediate.html'] as $f) {
            if (File::exists("{$path}/{$f}")) {
                File::delete("{$path}/{$f}");
            }
        }

        // Convert markdown → HTML → nodes.json
        $this->markdownProcessor->process("{$path}/original.md", $path, $subBookId);

        // Wait for nodes.json (processor may be async)
        $nodesPath = "{$path}/nodes.json";
        $attempts = 0;
        while (!File::exists($nodesPath) && $attempts < 15) {
            sleep(2);
            $attempts++;
        }
        if (!File::exists($nodesPath)) {
            throw new \RuntimeException("nodes.json was not generated at {$nodesPath}");
        }

        // Use admin connection to bypass RLS (CLI has no authenticated user session)
        $db = DB::connection('pgsql_admin');

        // Clear old sub-book nodes
        $db->table('nodes')->where('book', $subBookId)->delete();

        // Create/update library record — inherit creator from parent
        $parent = $db->table('library')->where('book', $bookId)->first();
        $now = now();

        $libraryExists = $db->table('library')->where('book', $subBookId)->exists();
        $libraryData = [
            'title'         => "AI Citation Review: {$bookTitle}",
            'type'          => 'sub_book',
            'creator'       => $parent->creator ?? null,
            'creator_token' => $parent->creator_token ?? null,
            'visibility'    => $parent->visibility ?? 'public',
            'listed'        => false,
            'has_nodes'     => true,
            'timestamp'     => round(microtime(true) * 1000),
            'raw_json'      => json_encode(['type' => 'ai_review', 'parent' => $bookId]),
            'updated_at'    => $now,
        ];

        if ($libraryExists) {
            $db->table('library')->where('book', $subBookId)->update($libraryData);
        } else {
            $libraryData['book'] = $subBookId;
            $libraryData['created_at'] = $now;
            $db->table('library')->insert($libraryData);
        }

        // Save nodes to database (same logic as ImportController::saveNodeChunksToDatabase)
        $nodesData = json_decode(File::get($nodesPath), true);
        $insertData = [];
        $now = now();
        $nodesPerChunk = 100;

        foreach ($nodesData as $index => $chunk) {
            $startLine = ($index + 1) * 100;
            $chunkId = floor($index / $nodesPerChunk) * 100;
            $nodeId = $this->helpers->generateNodeId($subBookId);
            $content = $this->helpers->ensureNodeIdInContent($chunk['content'] ?? '', $startLine, $nodeId);

            $rawJson = $chunk;
            $rawJson['startLine'] = $startLine;
            $rawJson['chunk_id'] = $chunkId;
            $rawJson['node_id'] = $nodeId;
            $rawJson['content'] = $content;

            $insertData[] = [
                'book'       => $subBookId,
                'startLine'  => $startLine,
                'chunk_id'   => $chunkId,
                'node_id'    => $nodeId,
                'content'    => $content,
                'footnotes'  => json_encode($chunk['footnotes'] ?? []),
                'plainText'  => $chunk['plainText'] ?? strip_tags($content),
                'type'       => $chunk['type'] ?? 'p',
                'raw_json'   => json_encode($rawJson),
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        // Bulk insert in 500-row batches
        foreach (array_chunk($insertData, 500) as $batch) {
            $db->table('nodes')->insert($batch);
        }

        Log::info("Imported AI review sub-book", [
            'subBookId' => $subBookId,
            'nodeCount' => count($insertData),
        ]);

        return $subBookId;
    }
}
