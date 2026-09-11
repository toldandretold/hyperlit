<?php

namespace App\Services\CitationStudy;

use App\Services\CitationReview\Support\TextNormaliser;

/**
 * Text normalisation shared by ground-truth generation, binding, and joining.
 *
 * Ground truth is keyed by normalised reference TEXT, not by referenceId —
 * process_references.py picks its entry ids from a Python set (hash-seed
 * dependent), so ids are not stable across imports. Everything that compares
 * study text to pipeline text must round-trip through this one normaliser.
 */
class GroundTruthText
{
    public static function normalise(string $text): string
    {
        // Markdown autolinks (<https://…>) read as HTML tags and would vanish
        // from one side of the comparison only — unwrap them first.
        $text = preg_replace('/<(https?:\/\/[^>\s]+)>/', ' $1 ', $text);
        // Tags become spaces, not nothing: "<em>Studies</em>45(2)" must
        // normalise like markdown's "*Studies*45(2)", i.e. "studies 45 2".
        $text = preg_replace('/<[^>]+>/', ' ', $text);
        $text = (new TextNormaliser())->normaliseQuotes($text);
        $text = mb_strtolower($text, 'UTF-8');
        // Strip diacritics where iconv can (best-effort; determinism holds
        // because the same transform runs on both sides of every comparison).
        $ascii = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $text);
        if (is_string($ascii)) {
            $text = $ascii;
        }
        // Drop everything except letters, digits and spaces, collapse runs.
        $text = preg_replace('/[^a-z0-9 ]+/', ' ', $text);
        $text = trim(preg_replace('/\s+/', ' ', $text));
        return $text;
    }

    public static function hash(string $text): string
    {
        return 'sha256:' . hash('sha256', self::normalise($text));
    }

    /** Token-set Jaccard similarity of two already-raw strings. */
    public static function jaccard(string $a, string $b): float
    {
        $ta = array_unique(array_filter(explode(' ', self::normalise($a))));
        $tb = array_unique(array_filter(explode(' ', self::normalise($b))));
        if ($ta === [] || $tb === []) {
            return 0.0;
        }
        $intersect = count(array_intersect($ta, $tb));
        $union = count(array_unique(array_merge($ta, $tb)));
        return $union > 0 ? $intersect / $union : 0.0;
    }
}
