<?php

namespace App\Services\CitationReview\Phases;

use App\Services\CitationReview\Support\AnaphoraDetector;
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
        private AnaphoraDetector $anaphora = new AnaphoraDetector(),
    ) {}

    public function extractTruthClaims(array $citationNodes, array $citationMeta, callable $emit): array
    {
        $claims = [];
        // Variant B of the 2026-09-19 A/B: use OUR deterministic sentence span when the model
        // fails to echo it back, and backfill citations the model omitted entirely. Off means the
        // historical behaviour (a citation the model mishandles is silently dropped).
        $useSpans = (bool) config('services.citation_review.span_backfill', false);
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

                // Which of this node's references the model actually accounted for.
                $seen = [];

                if ($extracted === null) {
                    Log::warning("LLM truth claim extraction failed for node {$node['node_id']}");
                    // A whole-node failure is the worst case for coverage: every citation in the
                    // paragraph goes unreviewed. Fall through to the backfill rather than losing
                    // the lot.
                    $extracted = [];
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

                    $squash = fn(string $s) => preg_replace('/[^\p{L}\p{N}]+/u', '', mb_strtolower($s));

                    if (!$verbatimMatch) {
                        // Whitespace-blind fallback: some stored plainText lost
                        // spaces at inline-tag boundaries ("fromChakravorti et
                        // al.(2025)are…"), which fails both checks above even
                        // though the claim IS verbatim in the rendered text.
                        // Squashing ALL non-alphanumerics keeps word order and
                        // content exact, so the anti-hallucination property holds.
                        $verbatimMatch = mb_strpos($squash($normMarked), $squash($normClaim)) !== false
                                      || mb_strpos($squash($normPlain), $squash($normClaim)) !== false;
                    }

                    if (!$verbatimMatch) {
                        // Citation-parenthetical-blind fallback. The two bases above cannot
                        // represent what the model legitimately returns when a citation sits INSIDE
                        // a parenthetical that also carries prose: the text reads "John Ruggie
                        // (Bhagwati and Ruggie 1984)" with only "1984" anchored, so the marked base
                        // becomes "(Bhagwati and Ruggie )" while plainText still reads "(1982)"
                        // after "Kissinger". The model drops the marker and keeps the prose — a
                        // THIRD form matching neither, and the claim was discarded as unverbatim.
                        //
                        // Measured on the 2026-09-18 phase2 run: 87 claims dropped this way, which
                        // is the dominant cause of a linked citation producing no claim at all
                        // (chacko-2025-paste: 4 drops, 4 orphaned citations — exact correspondence).
                        // Confirmed real losses, e.g. "From the imperialist Henry Kissinger, to the
                        // theorist of embedded liberalism, John Ruggie, and the historical
                        // materialist Robert W. Cox, all agreed" — a claim attributing a position
                        // to three named authors, which is precisely what review exists to check.
                        //
                        // Deleting year-bearing parentheses from BOTH sides keeps every prose word
                        // and its order intact on both, so the anti-hallucination property holds:
                        // the claim must still appear verbatim in the node apart from citations.
                        $stripCiteParens = fn(string $s) => preg_replace(
                            '/\(\s*[^)]*\b(?:1[5-9]\d{2}|20\d{2})\b[^)]*\)/u', '', $s
                        );
                        $claimKey = $squash($stripCiteParens($normClaim));
                        // A claim that is NOTHING but a citation parenthetical strips to empty, and
                        // mb_strpos($haystack, '') returns 0 — i.e. "found" — which would accept
                        // anything at all. Require real residual prose.
                        $verbatimMatch = mb_strlen($claimKey) >= 12
                            && (mb_strpos($squash($stripCiteParens($normMarked)), $claimKey) !== false
                             || mb_strpos($squash($stripCiteParens($normPlain)), $claimKey) !== false);
                    }

                    if (!$verbatimMatch) {
                        // The model failed to reproduce text WE ALREADY HAVE. CitationParser
                        // computed this citation's sentence deterministically
                        // (sentenceAtPosition / precedingClauseSpan) and the prompt was handed it;
                        // asking for it back is redundant, and the echo is where the two observed
                        // failure modes come from — an imperfect copy (truncation, a corrupted word
                        // like "sidelided") and outright omission. Dropping the citation here means
                        // it is never reviewed at all, which is strictly worse than reviewing our
                        // own span: the span is the ground truth the model was asked to copy.
                        //
                        // Marked `span_fallback` so the study can tell these apart — they carry NO
                        // contextualised_claim, so an anaphoric sentence ("The same is argued by X")
                        // verifies weaker than one the model resolved.
                        $span = trim((string) ($node['extracted_sentences'][$refId] ?? ''));
                        if ($useSpans && $span !== '') {
                            $claims[] = $this->makeClaimRecord($node, $refId, $span, null, $citationMeta, 'span_fallback');
                            $seen[$refId] = true;
                            continue;
                        }

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

                    $claims[] = $this->makeClaimRecord(
                        $node, $refId, $truthClaim,
                        $claim['contextualised_claim'] ?? null, $citationMeta, 'llm',
                        $charStart, $charEnd,
                    );
                    $seen[$refId] = true;
                }

                // BACKFILL: a citation the model never mentioned produces no row, so it is never
                // reviewed and never appears anywhere in the output. Our own span is a better
                // answer than silence — see the span_fallback comment above.
                if ($useSpans) {
                    foreach ($node['reference_ids'] as $refId) {
                        if (isset($seen[$refId])) {
                            continue;
                        }
                        $span = trim((string) ($node['extracted_sentences'][$refId] ?? ''));
                        if ($span === '') {
                            continue;
                        }
                        $claims[] = $this->makeClaimRecord($node, $refId, $span, null, $citationMeta, 'span_backfill');
                    }
                }
            }

            // Rate limit between batches
            if ($chunkIndex < count($chunks) - 1) {
                usleep(250_000);
            }
        }

        $this->contextualiseSpanClaims($claims, $citationNodes, $emit);

        return $claims;
    }

    /**
     * Give the RESCUED claims the one field they are missing: a self-contained restatement.
     *
     * A span-sourced claim (`span_fallback` / `span_backfill`) is our own sentence, so nothing
     * resolved its pronouns — and ClaimVerifier judges `contextualised_claim ?? truth_claim`. Left
     * alone, "The same argument is made by X" is sent to be verified without ever saying what the
     * argument is, and the resulting verdict describes OUR text rather than the citation. That is
     * the cost the A/B measured, and this is the repair.
     *
     * Cheap by construction, in two ways. AnaphoraDetector filters deterministically first, so the
     * large majority of rescued claims — already self-contained sentences — cost nothing. And the
     * request asks ONLY for the rewrite: no citation markers, no grouping, no choosing which claims
     * exist. Re-running those is precisely what proved unreliable, so the claim text stays fixed and
     * the model may only restate it.
     *
     * A failed or empty response leaves the raw sentence in place. That is the pre-existing
     * behaviour, so this can only improve a rescued claim, never lose one.
     *
     * @param  list<array<string, mixed>>  $claims
     * @param  list<array<string, mixed>>  $citationNodes
     */
    private function contextualiseSpanClaims(array &$claims, array $citationNodes, callable $emit): void
    {
        $nodesById = [];
        foreach ($citationNodes as $node) {
            $nodesById[$node['node_id']] = $node;
        }

        $items = [];
        foreach ($claims as $i => $claim) {
            if (! in_array($claim['claim_source'] ?? null, ['span_fallback', 'span_backfill'], true)) {
                continue;
            }
            if (! $this->anaphora->needsContextualisation($claim['truth_claim'] ?? null)) {
                continue;
            }
            $node = $nodesById[$claim['node_id']] ?? null;
            if ($node === null) {
                continue;
            }
            $items[$i] = [
                (string) $claim['truth_claim'],
                (string) ($node['preceding_context'] ?? ''),
                (string) ($node['plainText'] ?? ''),
            ];
        }

        if ($items === []) {
            return;
        }

        $emit(sprintf('Contextualising %d rescued claim(s) that reference surrounding text...', count($items)));

        $resolved = 0;
        foreach ($this->llm->contextualiseClaimsBatch($items) as $i => $text) {
            if (is_string($text) && trim($text) !== '') {
                $claims[$i]['contextualised_claim'] = trim($text);
                $resolved++;
            }
        }

        if ($resolved < count($items)) {
            Log::warning('Some rescued claims could not be contextualised', [
                'requested' => count($items), 'resolved' => $resolved,
            ]);
        }
    }

    /**
     * One claim record, from whichever source supplied the claim text.
     *
     * Shared by the three paths so they cannot drift: the model's own answer ('llm'), our
     * deterministic span used because the model's copy failed the verbatim check ('span_fallback'),
     * and our span used because the model never mentioned the citation ('span_backfill'). The last
     * two carry NO contextualised_claim — nothing resolved their pronouns or anaphora — and
     * ClaimVerifier falls back to the raw claim, so they verify weaker by construction. That is
     * visible in `claim_source` on purpose: the alternative was not reviewing them at all.
     *
     * @param  array<string, mixed>  $citationMeta
     */
    private function makeClaimRecord(
        array $node,
        string $refId,
        string $truthClaim,
        ?string $contextualised,
        array $citationMeta,
        string $source,
        ?int $charStart = null,
        ?int $charEnd = null,
    ): array {
        $plainText = (string) $node['plainText'];

        // Span-sourced claims locate themselves: the text IS a slice of plainText.
        if ($charStart === null && $charEnd === null) {
            $at = mb_strpos($plainText, $truthClaim);
            if ($at === false) {
                $at = mb_strpos(
                    $this->textNormaliser->normaliseQuotes($plainText),
                    $this->textNormaliser->normaliseQuotes($truthClaim),
                );
            }
            if ($at !== false) {
                $charStart = $at;
                $charEnd = $at + mb_strlen($truthClaim);
            }
        }

        $meta = $citationMeta[$refId] ?? [];

        return [
            'node_id'              => $node['node_id'],
            'referenceId'          => $refId,
            'truth_claim'          => $truthClaim,
            'contextualised_claim' => $contextualised ?? $truthClaim,
            // Which path produced this claim. The A/B depends on it, and so does reading a verdict:
            // a weak result on a span_backfill claim may be OUR missing contextualisation rather
            // than a weak citation.
            'claim_source'         => $source,
            'source_passages'      => [],
            'llm_verdict'          => null,
            'evidence_type'        => 'none',
            'source_material_sent' => null,
            'charStart'            => $charStart,
            'charEnd'              => $charEnd,
            'highlightId'          => 'HL_' . abs(crc32($node['node_id'] . $refId)),
        ] + $this->metaFields($meta);
    }

    /**
     * The claim fields that come from ONE cited work's enriched metadata — split out so a
     * multi-work expansion clone can swap in a different work without re-deriving the claim.
     *
     * @param  array<string, mixed>  $meta
     * @return array<string, mixed>
     */
    private function metaFields(array $meta): array
    {
        return [
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
            'source_completeness'        => $meta['source_completeness'] ?? null,
            'source_completeness_reason' => $meta['source_completeness_reason'] ?? null,
            'abstract'             => $meta['abstract'] ?? null,
            'bib_citation'         => $meta['bib_citation'] ?? null,
            'citation_row'         => $meta['citation_row'] ?? null,
            'source_type'          => $meta['source_type'] ?? null,
            'source_url'           => $meta['url'] ?? null,
            'source_doi'           => $meta['doi'] ?? null,
            'source_oa_url'        => $meta['oa_url'] ?? null,
            'llm_metadata'         => $meta['llm_metadata'] ?? null,
            'match_method'         => $meta['match_method'] ?? null,
            'match_score'          => $meta['match_score'] ?? null,
            'match_diagnostics'    => $meta['match_diagnostics'] ?? null,
        ];
    }

    /**
     * One claim row per CITED WORK. A footnote citing "Pedregosa, Scikit-learn…; Wickham,
     * ggplot2…" is N citations sharing one marker; the claim is the same, so the honest review
     * checks it against EACH work individually — the way a reader reads that footnote. Before
     * this, the claim was verified once, against whichever single book the parent row carried,
     * and the report had to apologise ("the matched source is the 2nd — not independently
     * verified: …"). Now there is nothing to apologise for: each work gets its own row, its own
     * passages, its own verdict — and an unresolved work lands in Unverified Sources under its
     * own type, with the fabrication banner that type deserves.
     *
     * Runs AFTER CitationCoverage::assess (coverage maps in-text citations to claims by the
     * PARENT refId; ::subN keys would read as unmatched citations). Clones share the parent's
     * highlightId — one text span, one highlight; VerificationHighlighter skips the clones.
     */
    public function expandMultiWorkClaims(array $claims, array $citationMeta): array
    {
        $out = [];
        foreach ($claims as $claim) {
            $subRefs = $citationMeta[$claim['referenceId']]['sub_source_refs'] ?? [];
            if ($subRefs === []) {
                $out[] = $claim;
                continue;
            }

            $total = count($subRefs) + 1;
            $claim['cited_work_position'] = 1;
            $claim['cited_work_total'] = $total;
            $out[] = $claim;

            foreach ($subRefs as $i => $subRef) {
                $meta = $citationMeta[$subRef] ?? null;
                if ($meta === null) {
                    continue;
                }
                // Same work resolved for both (e.g. a self-referencing chain) — one row is enough.
                if (!empty($meta['source_book_id']) && $meta['source_book_id'] === $claim['source_book_id']) {
                    continue;
                }
                $out[] = [
                    'referenceId'          => $subRef,
                    'cited_work_position'  => $i + 2,
                    'cited_work_total'     => $total,
                    // One highlight per SPAN, owned by the primary row — the highlighter skips
                    // expanded rows so the same sentence is not stacked with N highlights.
                    'expanded_work'        => true,
                ] + $this->metaFields($meta) + $claim;
            }
        }

        return $out;
    }
}
