<?php

namespace App\Services\CitationReview\Support;

/**
 * How much of the book's citation universe the review actually examined.
 *
 * A citation review can look complete and still have skipped citations silently. The pipeline's
 * unit of work is a (truth claim → cited source) PAIR, produced by the LLM extraction phase, and a
 * citation that yields no pair is simply absent from the output — no verdict, no row, nothing to
 * notice. Measured on the 2026-09-18 phase2 run, between 0% and 9% of citations that were
 * correctly LINKED in the prose produced no claim at all (nicholls-nieo-paste 6 of 66;
 * chacko-2025-pdf 12 of 228; barnett-2020-paste 0 of 26). Those are not "citations we judged
 * favourably" — they are citations nobody looked at, and without this class they were
 * indistinguishable from the rest.
 *
 * That makes coverage a first-class reliability number for the review system itself, alongside the
 * verdict mix: "we checked 226 of this book's 230 citations" is a claim about OUR completeness, and
 * it belongs in the report next to what the verdicts said.
 *
 * The universe is each node's `reference_ids` — exactly the contract the extraction prompt is given
 * ("Every referenceId that appears in the TEXT must appear in exactly one entry's referenceIds"),
 * so a shortfall here is measured against what we ASKED for, not against a different definition
 * invented afterwards.
 */
final class CitationCoverage
{
    /**
     * @param  array  $citationNodes  from CitationParser::parseCitationNodes
     * @param  array  $claims  from TruthClaimExtractor::extractTruthClaims
     * @return array{
     *     instances: int, matched: int, unmatched: int, rate: float,
     *     unmatched_refs: int,
     *     details: list<array{node_id: string, referenceId: string, charStart: ?int, charEnd: ?int, sentence: ?string}>
     * }
     */
    public function assess(array $citationNodes, array $claims): array
    {
        // Which (node, reference) pairs produced at least one claim.
        $matchedPairs = [];
        foreach ($claims as $claim) {
            $key = ($claim['node_id'] ?? '') . "\0" . ($claim['referenceId'] ?? '');
            $matchedPairs[$key] = true;
        }

        $instances = 0;
        $matched = 0;
        $details = [];
        $unmatchedRefs = [];

        foreach ($citationNodes as $node) {
            $nodeId = (string) ($node['node_id'] ?? '');
            $plain = (string) ($node['plainText'] ?? '');

            foreach (($node['reference_ids'] ?? []) as $refId) {
                $instances++;
                if (isset($matchedPairs[$nodeId . "\0" . $refId])) {
                    $matched++;
                    continue;
                }

                $unmatchedRefs[$refId] = true;

                // The citation's own position, so the gap can be SHOWN in the text rather than
                // only counted. Absent when the marker carried no resolvable position (a footnote
                // reference with no <sup> in the node), which is itself worth surfacing.
                $charPos = $node['citationPositions'][$refId] ?? null;
                $sentence = $node['extracted_sentences'][$refId] ?? null;

                [$charStart, $charEnd] = $this->spanFor($plain, $charPos, $sentence);

                $details[] = [
                    'node_id'     => $nodeId,
                    'referenceId' => (string) $refId,
                    'charStart'   => $charStart,
                    'charEnd'     => $charEnd,
                    'sentence'    => $sentence !== null ? (string) $sentence : null,
                ];
            }
        }

        $unmatched = $instances - $matched;

        return [
            'instances'      => $instances,
            'matched'        => $matched,
            'unmatched'      => $unmatched,
            'rate'           => $instances > 0 ? round($matched / $instances, 4) : 1.0,
            'unmatched_refs' => count($unmatchedRefs),
            'details'        => $details,
        ];
    }

    /**
     * Character span to highlight for an unmatched citation.
     *
     * Prefers the sentence the parser already computed with the correct attachment direction
     * (inline citations take the sentence around them, footnote markers the clause before), so the
     * highlight covers the SAME text the claim would have covered had extraction succeeded. Falls
     * back to the citation position alone, and finally to nothing rather than guessing a span.
     *
     * @return array{0: ?int, 1: ?int}
     */
    private function spanFor(string $plain, ?int $charPos, ?string $sentence): array
    {
        if ($sentence !== null && $sentence !== '' && $plain !== '') {
            $at = mb_strpos($plain, $sentence);
            if ($at !== false) {
                return [$at, $at + mb_strlen($sentence)];
            }
        }

        if ($charPos !== null) {
            return [$charPos, $charPos];
        }

        return [null, null];
    }
}
