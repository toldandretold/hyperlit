<?php

namespace App\Services\CitationReview\Support;

/**
 * Simple word-overlap (Jaccard) title similarity (0.0–1.0) for diagnostic
 * warnings. Extracted verbatim from CitationReviewService::simpleTitleSimilarity.
 */
final class TitleSimilarity
{
    public function similarity(string $a, string $b): float
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
}
