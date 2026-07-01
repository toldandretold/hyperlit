<?php

namespace App\Services\CitationReview\Support;

/**
 * Extract an author's last name from "Surname, First" or "First Surname".
 * Extracted verbatim from CitationReviewService::extractLastName.
 */
final class AuthorName
{
    public function lastName(string $author): string
    {
        $author = trim($author);
        if (empty($author)) {
            return '';
        }

        // "Surname, First" format
        if (str_contains($author, ',')) {
            return trim(explode(',', $author)[0]);
        }

        // "First Surname" format — take last word
        $words = preg_split('/\s+/', $author);
        return end($words);
    }
}
