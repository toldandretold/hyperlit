<?php

namespace App\Services\CitationReview\Support;

/**
 * Build a Postgres FTS " OR "-joined term string from free text.
 * Extracted verbatim from CitationReviewService::buildOrSearchTerms.
 */
final class SearchTerms
{
    public function orSearchTerms(string $text): string
    {
        $words = preg_split('/[^a-zA-Z0-9\']+/', mb_strtolower($text));
        $words = array_filter($words, fn($w) => mb_strlen($w) > 3);
        $words = array_values(array_unique($words));
        $words = array_slice($words, 0, 15);
        return implode(' OR ', $words);
    }
}
