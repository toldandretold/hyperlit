<?php

namespace App\Services\CitationReview\Phases;

use App\Services\CitationReview\Support\TextNormaliser;
use App\Services\LlmService;
use Illuminate\Support\Facades\Log;

/**
 * Phase 3 of the citation review: send citation-bearing nodes to the LLM (in
 * concurrent batches) to extract the verbatim factual claim each citation
 * supports. Claims not found verbatim in the node text are discarded — never
 * invented. Builds the per-claim record consumed by the rest of the pipeline.
 *
 * Extracted verbatim from CitationReviewService::extractTruthClaims. Progress is
 * reported through a message-only $emit callback (the coordinator binds the
 * 'extract' phase key), keeping the $progress('extract') literal out of this file.
 */
final class TruthClaimExtractor
{
    public function __construct(
        private LlmService $llm,
        private TextNormaliser $textNormaliser,
    ) {}

    public function extractTruthClaims(array $citationNodes, array $citationMeta, callable $emit): array
    {
        $claims = [];
        $nodeCount = count($citationNodes);
        $batchSize = 30;
        $chunks = array_chunk($citationNodes, $batchSize);

        foreach ($chunks as $chunkIndex => $chunk) {
            $offset = $chunkIndex * $batchSize;
            $emit("Processing nodes " . ($offset + 1) . "-" . ($offset + count($chunk)) . " of {$nodeCount}...");

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

                    $truthClaim = preg_replace('/\s*\[(?:FN)?CITE:[^\]]*\]/', '', $truthClaim);
                    $truthClaim = trim($truthClaim);

                    if (!$truthClaim) {
                        continue;
                    }

                    $markedForMatch = preg_replace('/\s*\[CITE:[^\]]*\]/', '', $node['marked_text']);
                    $normMarked = $this->textNormaliser->normaliseQuotes($markedForMatch);
                    $normPlain  = $this->textNormaliser->normaliseQuotes($node['plainText']);
                    $normClaim  = $this->textNormaliser->normaliseQuotes($truthClaim);

                    $verbatimMatch = mb_stripos($normMarked, $normClaim) !== false
                                  || mb_stripos($normPlain, $normClaim) !== false;

                    if (!$verbatimMatch) {
                        $stripPunct = fn(string $s) => trim(preg_replace('/\s+/', ' ',
                            preg_replace('/[^\p{L}\p{N}\s]+/u', ' ', mb_strtolower($s))));
                        $verbatimMatch = mb_strpos($stripPunct($normMarked), $stripPunct($normClaim)) !== false
                                      || mb_strpos($stripPunct($normPlain), $stripPunct($normClaim)) !== false;
                    }

                    if (!$verbatimMatch) {
                        // Whitespace-blind fallback: some stored plainText lost
                        // spaces at inline-tag boundaries ("fromChakravorti et
                        // al.(2025)are…"), which fails both checks above even
                        // though the claim IS verbatim in the rendered text.
                        // Squashing ALL non-alphanumerics keeps word order and
                        // content exact, so the anti-hallucination property holds.
                        $squash = fn(string $s) => preg_replace('/[^\p{L}\p{N}]+/u', '', mb_strtolower($s));
                        $verbatimMatch = mb_strpos($squash($normMarked), $squash($normClaim)) !== false
                                      || mb_strpos($squash($normPlain), $squash($normClaim)) !== false;
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
                            $normPlain = $this->textNormaliser->normaliseQuotes($plainText);
                            $normTruth = $this->textNormaliser->normaliseQuotes($truthClaim);
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
                        'verification_tier'    => $meta['verification_tier'] ?? null,
                        'web_status'           => $meta['web_status'] ?? null,
                        'canonical_source_id'  => $meta['canonical_source_id'] ?? null,
                        'canonical_signals'    => $meta['canonical_signals'] ?? [],
                        'content_provenance'   => $meta['content_provenance'] ?? null,
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
}
