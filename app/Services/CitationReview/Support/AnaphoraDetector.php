<?php

namespace App\Services\CitationReview\Support;

/**
 * Does this claim sentence depend on text OUTSIDE itself to be checkable?
 *
 * Exists to keep a repair cheap. When the LLM fails to echo back the sentence we already computed,
 * TruthClaimExtractor substitutes our own span (`span_fallback` / `span_backfill`) — which rescues a
 * citation that would otherwise never be reviewed, but arrives with NO contextualised_claim, because
 * nothing resolved its pronouns. `ClaimVerifier` then judges the raw sentence, so "The same argument
 * is made by X" is sent to be verified without saying what the argument IS.
 *
 * Re-asking the model to contextualise every rescued claim would work and would also pay for the
 * large majority that need nothing — a sentence like "Net FDI inflows fell from 2.4% of GDP in 2020
 * to 0.8% in 2023" is already fully self-contained. So this decides, deterministically and for free,
 * which ones are worth a request.
 *
 * Deliberately OVER-inclusive: a false positive costs one cheap LLM call, a false negative sends an
 * unresolvable claim to verification and produces a verdict about our own text rather than about the
 * citation. When unsure, say yes.
 */
final class AnaphoraDetector
{
    /**
     * Words and phrases that point OUTSIDE the sentence.
     *
     * Matched case-insensitively on word boundaries. Two groups, both taken from the
     * contextualisation rules the extraction prompt already lists: bare referring expressions
     * (pronouns, demonstratives) and comparative/relational phrases that name a previous claim
     * without restating it.
     */
    private const MARKERS = [
        // Pronouns and demonstratives standing in for a subject.
        'this', 'these', 'those', 'that', 'it', 'its', 'they', 'them', 'their', 'such',
        // Comparative / relational references to an earlier argument.
        'the same', 'a similar', 'similarly', 'likewise', 'the former', 'the latter',
        'a comparable', 'this approach', 'the above', 'as noted', 'as argued', 'also',
        'another', 'both', 'neither', 'either',
    ];

    /**
     * A sentence opening with one of these is continuing a thought, so its subject is elsewhere,
     * even when the sentence carries no pronoun at all ("Instead, G77 solidarity crumbled…").
     */
    private const LEADING_CONNECTIVES = [
        'instead', 'however', 'therefore', 'thus', 'hence', 'moreover', 'furthermore',
        'nevertheless', 'nonetheless', 'conversely', 'accordingly', 'consequently',
        'but', 'yet', 'so', 'and', 'or', 'for them', 'in this', 'in that', 'by contrast',
        'on the contrary', 'in turn', 'meanwhile', 'indeed',
    ];

    public function needsContextualisation(?string $claim): bool
    {
        $text = trim((string) $claim);
        if ($text === '') {
            return false;
        }

        // A fragment cannot be self-contained — footnote spans are clauses by design
        // (precedingClauseSpan), and a clause ending mid-thought needs its sentence.
        if (mb_strlen($text) < 40) {
            return true;
        }

        $lower = mb_strtolower($text);

        foreach (self::LEADING_CONNECTIVES as $connective) {
            if (str_starts_with($lower, $connective . ' ') || str_starts_with($lower, $connective . ',')) {
                return true;
            }
        }

        foreach (self::MARKERS as $marker) {
            if (preg_match('/(?<![\p{L}\p{N}])' . preg_quote($marker, '/') . '(?![\p{L}\p{N}])/u', $lower)) {
                return true;
            }
        }

        return false;
    }
}
