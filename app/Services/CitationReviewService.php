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

        // Phase 6: Create verification highlights
        $highlightCount = $this->createVerificationHighlights($claims, $bookId);
        $progress('highlights', "Created {$highlightCount} verification highlights");

        return $claims;
    }

    /**
     * Regenerate highlights + markdown report from an existing claims array (skip LLM phases).
     */
    public function regenerateReport(array $claims, string $bookId, string $bookTitle, ?callable $onProgress = null): string
    {
        $progress = $onProgress ?? fn() => null;

        $highlightCount = $this->createVerificationHighlights($claims, $bookId);
        $progress('highlights', "Created {$highlightCount} verification highlights");

        $md = $this->buildMarkdownReport($claims, $bookId, $bookTitle);
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

        $nodes = $db->table('nodes')
            ->where('book', $bookId)
            ->select(['node_id', 'content', 'plainText'])
            ->orderBy('startLine')
            ->get();

        $result = [];
        $prevContext = '';

        foreach ($nodes as $node) {
            $content = $node->content ?? '';
            $currentPlain = $node->plainText ?? '';

            // Check for in-text citations (href-first or class-first)
            if (!preg_match('/<a\s[^>]*class="in-text-citation"[^>]*>/i', $content)) {
                $prevContext = mb_substr($currentPlain, -500);
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
                $prevContext = mb_substr($currentPlain, -500);
                continue;
            }

            // Compute each citation's character position in plainText
            // by finding the <a> tag byte offset in HTML and counting
            // plain text characters before it (like frontend calculateCleanTextOffset)
            $citationPositions = [];
            $patterns = [
                '/<a\s[^>]*href="#([^"]+)"[^>]*class="in-text-citation"[^>]*>.*?<\/a>/i',
                '/<a\s[^>]*class="in-text-citation"[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/i',
            ];
            foreach ($patterns as $pattern) {
                if (preg_match_all($pattern, $content, $tagMatches, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
                    foreach ($tagMatches as $tagMatch) {
                        $matchedRefId = $tagMatch[1][0]; // captured href fragment
                        $tagByteOffset = $tagMatch[0][1]; // byte offset of full match
                        if (!isset($citationPositions[$matchedRefId])) {
                            $contentBefore = substr($content, 0, $tagByteOffset);
                            $plainBefore = html_entity_decode(strip_tags($contentBefore), ENT_QUOTES | ENT_HTML5, 'UTF-8');
                            $citationPositions[$matchedRefId] = mb_strlen($plainBefore);
                        }
                    }
                }
            }

            $result[] = [
                'node_id'            => $node->node_id,
                'marked_text'        => $marked,
                'plainText'          => $currentPlain,
                'reference_ids'      => array_values($referenceIds),
                'preceding_context'  => $prevContext,
                'citationPositions'  => $citationPositions,
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
            ->select(['referenceId', 'foundation_source', 'content'])
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
                'verified'           => $lib && (!empty($lib->openalex_id) || !empty($lib->open_library_key) || ($lib->type ?? null) === 'web_source'),
                'source_book_id'     => $resolvedSource,
                'has_source_content' => (bool) ($lib->has_nodes ?? false),
                'bib_citation'       => $bib->content ?? null,
                'source_type'        => $lib->type ?? null,
                'url'                => $lib->url ?? null,
                'doi'                => $lib->doi ?? null,
                'oa_url'             => $lib->oa_url ?? null,
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

            $extracted = $this->llm->extractTruthClaims($markedText, $context, $node['preceding_context'] ?? '');

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

                // Strip [CITE:...] markers the LLM may have included despite instructions
                $truthClaim = preg_replace('/\s*\[CITE:[^\]]*\]/', '', $truthClaim);
                $truthClaim = trim($truthClaim);

                if (!$truthClaim) {
                    continue;
                }

                // Validate verbatim: truth_claim must appear in the marked text
                // Strip [CITE:...] from marked text too — the LLM was told to exclude them
                $markedForMatch = preg_replace('/\s*\[CITE:[^\]]*\]/', '', $node['marked_text']);
                $normMarked = $this->normaliseQuotes($markedForMatch);
                $normClaim  = $this->normaliseQuotes($truthClaim);

                // Tier 1: Normalised match (smart quotes, dashes, whitespace)
                $verbatimMatch = mb_stripos($normMarked, $normClaim) !== false;

                // Tier 2: Strip ALL punctuation — catches remaining Unicode oddities
                if (!$verbatimMatch) {
                    $stripPunct = fn(string $s) => trim(preg_replace('/\s+/', ' ',
                        preg_replace('/[^\p{L}\p{N}\s]+/u', ' ', mb_strtolower($s))));
                    $verbatimMatch = mb_strpos($stripPunct($normMarked), $stripPunct($normClaim)) !== false;
                }

                if (!$verbatimMatch) {
                    Log::warning("Truth claim not found verbatim in node {$node['node_id']}", [
                        'refId' => $refId,
                        'claim' => mb_substr($truthClaim, 0, 200),
                    ]);
                    continue;
                }

                // Validate: [CITE:refId] must be in the sentence the truth_claim was taken from
                $expectedSentence = $this->extractSentenceAroundCite($node['marked_text'], $refId);
                if ($expectedSentence !== null) {
                    $normExpected = $this->normaliseQuotes($expectedSentence);
                    $normClaim    = $this->normaliseQuotes($truthClaim);
                    if (mb_stripos($normExpected, $normClaim) === false
                        && mb_stripos($normClaim, $normExpected) === false) {
                        Log::warning("Truth claim is not the sentence containing [CITE:{$refId}] in node {$node['node_id']}", [
                            'claim'    => mb_substr($truthClaim, 0, 200),
                            'expected' => mb_substr($expectedSentence, 0, 200),
                        ]);
                        continue;
                    }
                }

                // Compute charStart/charEnd from citation position in HTML
                // (like frontend calculateCleanTextOffset — no fragile text search)
                $plainText = $node['plainText'];
                $citeCharPos = $node['citationPositions'][$refId] ?? null;

                if ($citeCharPos !== null) {
                    // Sentence start: search backward for '. ' or '? ' or '! '
                    $before = mb_substr($plainText, 0, $citeCharPos);
                    if (preg_match('/.*[.!?]\s+/su', $before, $m)) {
                        $charStart = mb_strlen($m[0]);
                    } else {
                        $charStart = 0;
                    }
                    // Sentence end: search forward from citation position
                    $after = mb_substr($plainText, $citeCharPos);
                    if (preg_match('/^.*?[.!?](?:\s|$)/su', $after, $m)) {
                        $charEnd = $citeCharPos + mb_strlen($m[0]);
                    } else {
                        $charEnd = mb_strlen($plainText);
                    }
                } else {
                    // Fallback: existing text search (kept as safety net)
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

                // Deterministic highlight ID — HL_ prefix required by frontend routing
                // Use crc32 for a compact numeric hash from node+ref
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
                    'source_passages'      => [],
                    'llm_verdict'          => null,
                    'evidence_type'        => 'none',
                    'source_material_sent' => null,
                    'charStart'            => $charStart,
                    'charEnd'              => $charEnd,
                    'highlightId'          => $highlightId,
                ];
            }

            sleep(1);
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

            $claim['source_passages'] = array_map(fn($p) => [
                'node_id' => $p->node_id,
                'text'    => mb_substr($p->plainText ?? '', 0, 1500),
                'rank'    => round($p->rank, 4),
            ], $passages);
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
     * Phase 5: Send each claim + source material to the advanced LLM for verification.
     */
    private function verifyClaims(array &$claims, callable $progress): void
    {
        $total = count($claims);

        foreach ($claims as $i => &$claim) {
            $progress('verify', "Verifying claim " . ($i + 1) . "/{$total}...");

            // Determine evidence type — validate abstract isn't junk
            // Web sources have pre-extracted content as abstract; skip LLM validation for them
            $hasPassages = !empty($claim['source_passages']);
            $isWebSource = ($claim['source_type'] ?? null) === 'web_source';
            $hasAbstract = !empty($claim['abstract'])
                && ($isWebSource || $this->llm->validateAbstract($claim['abstract'], $claim['source_title'] ?? ''));

            if ($hasPassages && $hasAbstract) {
                $claim['evidence_type'] = 'abstract_and_passages';
            } elseif ($hasPassages) {
                $claim['evidence_type'] = 'passages_only';
            } elseif ($hasAbstract) {
                $claim['evidence_type'] = 'abstract_only';
            } elseif (!empty($claim['source_title'])) {
                $claim['evidence_type'] = 'title_only';
            } else {
                $claim['evidence_type'] = 'none';
            }

            // Short-circuit: no real evidence — don't send to LLM
            if ($claim['evidence_type'] === 'none') {
                $claim['source_material_sent'] = null;
                $claim['llm_verdict'] = [
                    'support'   => 'insufficient',
                    'summary'   => 'No evidence available',
                    'reasoning' => 'No abstract or source passages available for verification.',
                ];
                continue;
            }

            // Assemble source material
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
                $sourceMaterial .= "ABSTRACT:\n{$claim['abstract']}\n\n";
            }
            if ($hasPassages) {
                $sourceMaterial .= "PASSAGES FROM SOURCE TEXT:\n";
                foreach ($claim['source_passages'] as $j => $p) {
                    $sourceMaterial .= "--- Passage " . ($j + 1) . " ---\n{$p['text']}\n\n";
                }
            }

            $claim['source_material_sent'] = trim($sourceMaterial) ?: null;

            $verdict = $this->llm->verifyCitation(
                $claim['contextualised_claim'] ?? $claim['truth_claim'],
                $sourceMaterial,
                $claim['evidence_type']
            );

            if ($verdict === null) {
                $claim['llm_verdict'] = [
                    'support'   => 'insufficient',
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
                    'abstract_only'    => 'Abstract only',
                    'abstract_passage' => 'Abstract + source passages',
                    'passage_only'     => 'Source passages only',
                    'title_only'       => 'Title only (no abstract or passages)',
                    'none'             => 'No evidence',
                    default            => $evidenceType,
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
    public function buildMarkdownReport(array $claims, string $bookId, string $bookTitle): string
    {
        $md = "# Citation Review Report\n\n";
        $md .= "- **Book:** {$bookTitle}\n";
        $md .= "- **Date:** " . now()->toDateTimeString() . "\n";
        $md .= "- **Claims analyzed:** " . count($claims) . "\n\n";

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
        $md .= "## Summary\n\n";
        $md .= '<table data-chart="verdict-summary"><thead><tr><th>Verdict</th><th>Count</th></tr></thead><tbody>' . "\n";
        $md .= '<tr><td>Unverified Sources</td><td>' . count($unverified) . "</td></tr>\n";
        $md .= '<tr><td>Rejected</td><td>' . count($rejected) . "</td></tr>\n";
        $md .= '<tr><td>Unlikely</td><td>' . count($unlikely) . "</td></tr>\n";
        $md .= '<tr><td>Plausible</td><td>' . count($plausible) . "</td></tr>\n";
        $md .= '<tr><td>Likely</td><td>' . count($likely) . "</td></tr>\n";
        $md .= '<tr><td>Confirmed</td><td>' . count($confirmed) . "</td></tr>\n";
        $md .= "</tbody></table>\n\n";

        // Sections — strongest concern first
        if (!empty($rejected)) {
            $md .= "## Rejected\n\n";
            foreach ($rejected as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($unlikely)) {
            $md .= "## Unlikely\n\n";
            foreach ($unlikely as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($unverified)) {
            $md .= "## Unverified Sources\n\n";
            $md .= "These citations reference sources that were never found in any database.\n\n";
            foreach ($unverified as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($plausible)) {
            $md .= "## Plausible\n\n";
            foreach ($plausible as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($likely)) {
            $md .= "## Likely\n\n";
            foreach ($likely as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        if (!empty($confirmed)) {
            $md .= "## Confirmed\n\n";
            foreach ($confirmed as $c) {
                $md .= $this->formatClaimMd($c, $bookId);
            }
        }

        return $md;
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
     * Extract the sentence surrounding a [CITE:refId] marker from marked text.
     * Returns the sentence with CITE markers stripped, or null if marker not found.
     */
    private function extractSentenceAroundCite(string $markedText, string $refId): ?string
    {
        $marker = "[CITE:{$refId}]";
        $citePos = mb_strpos($markedText, $marker);
        if ($citePos === false) {
            return null;
        }

        // Sentence start: search backward for '. ', '? ', '! ' (greedy = last match)
        $before = mb_substr($markedText, 0, $citePos);
        if (preg_match('/.*[.!?]\s+/su', $before, $m)) {
            $sentStart = mb_strlen($m[0]);
        } else {
            $sentStart = 0;
        }

        // Sentence end: search forward from after the marker
        $afterPos = $citePos + mb_strlen($marker);
        $after = mb_substr($markedText, $afterPos);
        if (preg_match('/^.*?[.!?](?:\s|$)/su', $after, $m)) {
            $sentEnd = $afterPos + mb_strlen($m[0]);
        } else {
            $sentEnd = mb_strlen($markedText);
        }

        // Extract sentence and strip CITE markers
        $sentence = mb_substr($markedText, $sentStart, $sentEnd - $sentStart);
        $sentence = preg_replace('/\s*\[CITE:[^\]]*\]/', '', $sentence);
        return trim($sentence);
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

        $isWebSource = ($claim['source_type'] ?? null) === 'web_source';
        $evidenceLabel = match ($claim['evidence_type'] ?? 'none') {
            'abstract_and_passages' => $isWebSource ? 'Web page content + passages' : 'Abstract + passages',
            'passages_only'         => 'Passages only',
            'abstract_only'         => $isWebSource ? 'Web page content' : 'Abstract only',
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
        $bibCitation = $claim['bib_citation'] ?? null;
        if ($bibCitation) {
            $bibPlain = html_entity_decode(strip_tags($bibCitation), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $md .= "> {$bibPlain}\n\n";
        }
        if (!empty($claim['has_highlight'])) {
            $highlightId = $claim['highlightId'] ?? 'HL_' . abs(crc32($claim['node_id'] . $refId));
            $md .= "**Claim:** \"{$claim['truth_claim']}\" [←](/{$bookId}/{$highlightId})\n";
        } else {
            $md .= "**Claim:** \"{$claim['truth_claim']}\"\n";
        }
        if (!empty($claim['contextualised_claim']) && $claim['contextualised_claim'] !== $claim['truth_claim']) {
            $md .= "**Contextualised:** \"{$claim['contextualised_claim']}\"\n";
        }
        $sourceMdLine = $this->buildSourceMd($claim);
        if ($sourceMdLine) {
            $md .= $sourceMdLine;
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
