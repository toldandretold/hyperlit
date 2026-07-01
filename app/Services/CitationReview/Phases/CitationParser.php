<?php

namespace App\Services\CitationReview\Phases;

use App\Services\CitationReview\Matching\FootnoteCitationMapper;
use App\Services\CitationReview\Support\ClaimSpanExtractor;
use Illuminate\Support\Facades\DB;

/**
 * Phase 1 of the citation review: find body nodes carrying citations (inline
 * <a href="#refId"> anchors and footnote <sup> markers), replace them with
 * [CITE:]/[FNCITE:] markers, and extract each citation's reference ids, char
 * position and claim span. Static footnote/bibliography sections are skipped —
 * a footnote's own text is a citation, not a claim.
 *
 * Extracted verbatim from CitationReviewService::parseCitationNodes.
 */
final class CitationParser
{
    public function __construct(
        private FootnoteCitationMapper $footnoteMapper,
        private ClaimSpanExtractor $claimSpans,
    ) {}

    public function parseCitationNodes(string $bookId): array
    {
        $db = DB::connection('pgsql_admin');

        // Pre-load bibliography referenceIds for validation
        $bibRefIds = $db->table('bibliography')
            ->where('book', $bookId)
            ->pluck('referenceId')
            ->flip()
            ->toArray();

        // Footnote-only: when bibliography is empty, citation-classified footnotes are valid IDs
        if (empty($bibRefIds)) {
            $fnCitationIds = $db->table('footnotes')
                ->where('book', $bookId)
                ->where('is_citation', true)
                ->pluck('footnoteId')
                ->flip()
                ->toArray();
            $bibRefIds = $fnCitationIds;
        }

        // Pre-build footnote → refIds map for footnote-based citations
        $footnoteMap = $this->footnoteMapper->buildMap($bookId);

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

            // Static footnote-definition / bibliography sections are NOT claim
            // sources: a footnote's own text ("Asai (2021) p. 32.") is a
            // citation, not an assertion — the claim lives at the BODY sentence
            // carrying the footnote marker (handled via footnoteMap). Without
            // this, every linked footnote definition becomes a junk claim
            // ("the source is cited") that the verifier rightly rejects.
            if (preg_match('/data-static-content="(?:footnotes|bibliography)"/i', $content)) {
                continue;
            }

            // Quick check: skip nodes with neither inline citations nor footnote refs
            $hasInlineLink = preg_match('/<a\s[^>]*href="#([^"]+)"[^>]*>/i', $content);
            $hasFootnote = !empty($footnoteMap) && preg_match('/<sup\b[^>]*\bfn-count-id="/i', $content);

            if (!$hasInlineLink && !$hasFootnote) {
                $prevContext = mb_substr($currentPlain, -500);
                continue;
            }

            // Replace inline citation anchors with [CITE:refId] markers
            $marked = preg_replace_callback(
                '/<a\s[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/is',
                function ($m) use ($bibRefIds) {
                    return isset($bibRefIds[$m[1]]) ? '[CITE:' . $m[1] . ']' : $m[0];
                },
                $content
            );

            // Replace footnote <sup> tags with [CITE:refId] markers
            if (!empty($footnoteMap)) {
                $marked = preg_replace_callback(
                    '/<sup\b[^>]*\bfn-count-id="[^"]*"[^>]*>.*?<\/sup>/is',
                    function ($m) use ($footnoteMap) {
                        if (preg_match('/\bid="([^"]+)"/', $m[0], $idMatch)) {
                            $footnoteId = $idMatch[1];
                            if (isset($footnoteMap[$footnoteId])) {
                                // FNCITE (not CITE): footnote markers attach to the
                                // text BEFORE them — the claim-extraction prompt
                                // treats the two marker kinds directionally.
                                return implode('', array_map(
                                    fn($refId) => '[FNCITE:' . $refId . ']',
                                    $footnoteMap[$footnoteId]
                                ));
                            }
                        }
                        return ''; // remove unmatched footnote markers
                    },
                    $marked
                );
            }

            $marked = strip_tags($marked);

            // Extract reference IDs
            preg_match_all('/\[(?:FN)?CITE:([^\]]+)\]/', $marked, $refMatches);
            $referenceIds = array_unique($refMatches[1]);

            if (empty($referenceIds)) {
                $prevContext = mb_substr($currentPlain, -500);
                continue;
            }

            // Compute each citation's character position in plainText
            // First: inline <a> tags
            $citationPositions = [];
            $footnoteDerived = [];
            if (preg_match_all('/<a\s[^>]*href="#([^"]+)"[^>]*>.*?<\/a>/is', $content, $tagMatches, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
                foreach ($tagMatches as $tagMatch) {
                    $matchedRefId = $tagMatch[1][0];
                    $tagByteOffset = $tagMatch[0][1];
                    if (isset($bibRefIds[$matchedRefId]) && !isset($citationPositions[$matchedRefId])) {
                        $contentBefore = substr($content, 0, $tagByteOffset);
                        $plainBefore = html_entity_decode(strip_tags($contentBefore), ENT_QUOTES | ENT_HTML5, 'UTF-8');
                        $citationPositions[$matchedRefId] = mb_strlen($plainBefore);
                    }
                }
            }

            // Then: footnote <sup> tags
            if (!empty($footnoteMap) && preg_match_all('/<sup\b[^>]*\bfn-count-id="[^"]*"[^>]*>.*?<\/sup>/is', $content, $supTagMatches, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
                foreach ($supTagMatches as $supMatch) {
                    $supTag = $supMatch[0][0];
                    $tagByteOffset = $supMatch[0][1];

                    if (preg_match('/\bid="([^"]+)"/', $supTag, $idMatch)) {
                        $footnoteId = $idMatch[1];
                        if (isset($footnoteMap[$footnoteId])) {
                            $contentBefore = substr($content, 0, $tagByteOffset);
                            $plainBefore = html_entity_decode(strip_tags($contentBefore), ENT_QUOTES | ENT_HTML5, 'UTF-8');
                            $charPos = mb_strlen($plainBefore);

                            foreach ($footnoteMap[$footnoteId] as $refId) {
                                if (!isset($citationPositions[$refId])) {
                                    $citationPositions[$refId] = $charPos;
                                    $footnoteDerived[$refId] = true;
                                }
                            }
                        }
                    }
                }
            }

            // Extract the claim span for each citation. DIRECTIONAL:
            //  - inline (Author 1999) anchors → the sentence AROUND the citation;
            //  - footnote markers → the text BEFORE the marker, clamped at the
            //    previous citation marker. A run like "…clause A,[103] clause B.[104]"
            //    must give [103]=clause A and [104]=clause B — extending forward
            //    (or back past another marker) attributes the wrong source.
            $allPositions = array_values($citationPositions);
            $extractedSentences = [];
            foreach ($citationPositions as $refId => $charPos) {
                $extractedSentences[$refId] = !empty($footnoteDerived[$refId])
                    ? $this->claimSpans->precedingClauseSpan($currentPlain, $charPos, $allPositions)
                    : $this->claimSpans->sentenceAtPosition($currentPlain, $charPos);
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
}
