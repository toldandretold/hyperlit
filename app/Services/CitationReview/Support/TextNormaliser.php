<?php

namespace App\Services\CitationReview\Support;

/**
 * Normalise Unicode punctuation and whitespace for verbatim comparison.
 * Extracted verbatim from CitationReviewService::normaliseQuotes.
 */
final class TextNormaliser
{
    public function normaliseQuotes(string $s): string
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
}
