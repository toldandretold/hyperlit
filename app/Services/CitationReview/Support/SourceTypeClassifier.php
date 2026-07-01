<?php

namespace App\Services\CitationReview\Support;

/**
 * Classifies a citation claim's source TYPE (from the LLM-parsed bibliography
 * metadata) for the purpose of deciding how strongly to flag an *unverified*
 * source.
 *
 * The type lives at $claim['llm_metadata']['type'] and is available even when
 * the source was never matched in any database (it is derived from parsing the
 * bibliography entry text, not from a match). See MetadataEnricher /
 * TruthClaimExtractor for how it lands on the claim array.
 *
 * "Should be indexed" is deliberately narrower than the report's broader
 * academic/non-academic split: a peer-reviewed journal article is almost always
 * indexed in OpenAlex / Semantic Scholar, so its absence is a strong red flag —
 * whereas a BOOK is sometimes legitimately absent, so it keeps the softer note.
 */
final class SourceTypeClassifier
{
    /**
     * Types that SHOULD reliably appear in academic databases — absence is a
     * strong warning sign (possible fabricated / miscited reference). Scoped to
     * journal-article per product decision; extend deliberately.
     */
    public const EXPECTED_IN_DATABASES = ['journal-article'];

    public static function type(array $claim): string
    {
        return $claim['llm_metadata']['type'] ?? 'unknown';
    }

    public static function shouldBeIndexed(array $claim): bool
    {
        return in_array(self::type($claim), self::EXPECTED_IN_DATABASES, true);
    }

    public static function label(string $type): string
    {
        return match ($type) {
            'journal-article'  => 'journal article',
            'book'             => 'book',
            'book-chapter'     => 'book chapter',
            'conference-paper' => 'conference paper',
            'thesis'           => 'thesis',
            'report'           => 'report',
            default            => 'source',
        };
    }
}
