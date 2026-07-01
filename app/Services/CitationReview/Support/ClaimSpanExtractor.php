<?php

namespace App\Services\CitationReview\Support;

/**
 * Extract the claim text span around a citation marker in plain text.
 * Extracted verbatim from CitationReviewService::extractPrecedingClauseSpan /
 * ::extractSentenceAtPosition.
 */
final class ClaimSpanExtractor
{
    /**
     * Claim span for a FOOTNOTE marker: the text immediately BEFORE the marker,
     * starting at the sentence boundary or the previous citation marker —
     * whichever is nearer. Footnote markers attach backwards; extending the
     * span forward (or back across another marker) attributes a neighbouring
     * clause's claim to the wrong source.
     */
    public function precedingClauseSpan(string $plainText, int $charPos, array $allMarkerPositions): string
    {
        $before = mb_substr($plainText, 0, $charPos);

        // Sentence boundary going back
        $start = 0;
        if (preg_match('/.*[.!?]\s+/su', $before, $m)) {
            $start = mb_strlen($m[0]);
        }
        // Clamp at the closest preceding citation marker
        foreach ($allMarkerPositions as $pos) {
            if ($pos < $charPos && $pos > $start) {
                $start = $pos;
            }
        }

        return trim(mb_substr($plainText, $start, $charPos - $start));
    }

    /**
     * Extract the sentence surrounding a character position in plain text.
     * Same regex logic as the charStart/charEnd computation in extractTruthClaims().
     */
    public function sentenceAtPosition(string $plainText, int $charPos): string
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
}
