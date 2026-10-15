<?php

namespace App\Services\CitationReview\Support;

/**
 * Classifies a citation claim's source TYPE (from the LLM-parsed bibliography
 * metadata) for the purpose of deciding how strongly to flag an *unverified*
 * source, and owns the single wording of the "Source Not Found" explanation
 * (used by both the highlight sub-book and the markdown report — two copies of
 * this text drifted apart once already).
 *
 * The type lives at $claim['llm_metadata']['type'] and is available even when
 * the source was never matched in any database (it is derived from parsing the
 * bibliography entry text, not from a match). See MetadataEnricher /
 * TruthClaimExtractor for how it lands on the claim array.
 *
 * MULTI-WORK ENTRIES: a footnote can cite several works ("ANAO report; Carney
 * journal article") — the scan stores the first as the primary llm_metadata and
 * the rest under llm_metadata.sub_citations (CitationScanBibliographyJob). Every
 * classification here considers ALL works, not just the primary: a fabricated
 * journal article must not escape the red flag by being cited second.
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

    /**
     * Academic types that are only SOMETIMES indexed — absence is worth a human
     * look but is a weak signal on its own.
     */
    public const SOMETIMES_INDEXED = ['book', 'book-chapter', 'conference-paper', 'thesis'];

    /**
     * Institutional / non-academic types that are NOT expected in the academic
     * databases we search — absence there is normal and says little.
     */
    public const NOT_EXPECTED_IN_DATABASES = [
        'report', 'news-article', 'archival-source', 'youtube-video',
        'website', 'legislation', 'case-law',
    ];

    public static function type(array $claim): string
    {
        return $claim['llm_metadata']['type'] ?? 'unknown';
    }

    /**
     * Every work this claim's entry cites: the primary llm_metadata followed by
     * any sub_citations (multi-work footnotes). Works the scan already MATCHED
     * (sub_citations[i].resolution.status === 'matched') are excluded — they
     * were found, so they have no place in a not-found assessment.
     */
    public static function works(array $claim): array
    {
        $meta = $claim['llm_metadata'] ?? null;
        if (!is_array($meta) || $meta === []) {
            return [];
        }

        $works = [$meta];
        foreach ($meta['sub_citations'] ?? [] as $sub) {
            if (is_array($sub) && ($sub['resolution']['status'] ?? null) !== 'matched') {
                $works[] = $sub;
            }
        }

        return $works;
    }

    public static function shouldBeIndexed(array $claim): bool
    {
        foreach (self::works($claim) as $work) {
            if (in_array($work['type'] ?? null, self::EXPECTED_IN_DATABASES, true)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Titles of the works typed journal-article — so a flag can NAME the work
     * that should have been indexed (essential when it's a sub-citation and the
     * primary is something else entirely).
     */
    public static function journalArticleTitles(array $claim): array
    {
        $titles = [];
        foreach (self::works($claim) as $work) {
            if (in_array($work['type'] ?? null, self::EXPECTED_IN_DATABASES, true)) {
                $titles[] = $work['title'] ?? '(untitled)';
            }
        }

        return $titles;
    }

    /**
     * Compact one-line listing of a MULTI-work entry's works, for the report's
     * claim blocks (the highlight's notFoundExplanation carries the full prose;
     * the report otherwise shows nothing multi-work unless a journal 🚩 fires).
     * Null for single-work entries.
     */
    public static function worksSummary(array $claim): ?string
    {
        $works = self::works($claim);
        if (count($works) < 2) {
            return null;
        }

        $parts = [];
        foreach ($works as $i => $work) {
            $n = $i + 1;
            $title = $work['title'] ?? '(untitled)';
            $label = self::label($work['type'] ?? 'unknown');
            $parts[] = "({$n}) \u{201C}{$title}\u{201D} — {$label}";
        }

        return 'This entry cites ' . count($works) . ' works: ' . implode('; ', $parts) . '.';
    }

    /**
     * Detects a citation whose RAW TEXT looks like several semicolon-separated
     * works but whose parsed metadata is single-work — an LLM extraction
     * split-miss (seen on OCR-mangled footnotes: "Dept of Finance …; Institute
     * of Internal Auditors …" parsed as one 'website'). The un-split works were
     * never searched, so the report must not present the entry as one work.
     * Fires only on positive evidence: a post-semicolon segment ≥25 chars
     * carrying a plausible year.
     */
    public static function possiblyUnsplitMultiWork(array $claim): bool
    {
        $meta = $claim['llm_metadata'] ?? null;
        if (!is_array($meta) || $meta === []) {
            return false; // no metadata at all
        }
        // Check the RAW sub_citations, not works(): works() excludes subs the
        // scan already MATCHED, so a properly split entry whose sub resolved
        // would masquerade as single-work and draw a bogus "never searched"
        // warning about works that were searched and found.
        if (!empty($meta['sub_citations'])) {
            return false; // already split
        }
        // One work SPLIT OUT of a multi-work citation by the review's fan-out: its metadata is
        // single-work by construction while its citation text still carries the semicolons —
        // exactly the shape this heuristic exists to flag, except here every work HAS been
        // searched on its own row.
        if (!empty($meta['split_from']) || !empty($claim['cited_work_total'])) {
            return false;
        }
        if (in_array(self::type($claim), ['ibid', 'short-form', 'pointer'], true)) {
            return false;
        }

        $text = html_entity_decode(strip_tags($claim['bib_citation'] ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        if ($text === '') {
            return false;
        }

        $segments = preg_split('/;\s+/', $text);
        foreach (array_slice($segments, 1) as $segment) {
            if (mb_strlen(trim($segment)) >= 25 && preg_match('/\b(19|20)\d{2}\b/', $segment)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Does this title READ as a legislative instrument? The extraction model
     * types these inconsistently — deloitte's "Social Security Administration
     * (Non-Compliance) Determination 2018 (No 1) (Cth)" came back as a 'report'
     * with the agency parsed as an AUTHOR, so it ran the whole scholarly ladder
     * for a statutory instrument that can never be indexed there.
     *
     * Deliberately conservative — ALL of: an instrument word immediately
     * followed by a year; NO subtitle separator ("The Human Rights Act 1998
     * (UK): A Commentary" is a BOOK about legislation and must keep its type);
     * and the title must END at the instrument's own tail once trailing
     * pinpoints (pt/div/s …) are stripped — a jurisdiction parenthetical, or
     * an instrument-numbering parenthetical ("(No 1)") when the jurisdiction
     * shows up in the raw citation text instead (the extraction routinely
     * clips "(Cth)" off the title: deloitte c06 came back as "… Determination
     * 2018 (No 1)"). A work ABOUT an instrument keeps going past that tail
     * ("The Privacy Act 1988 (Cth) and Its Discontents") and is refused.
     */
    public static function looksLegislative(?string $title, ?string $context = null): bool
    {
        if ($title === null || trim($title) === '') {
            return false;
        }
        if (preg_match('/[:]|\x{2014}|\x{2013}/u', $title)) {
            return false; // a subtitle means a work ABOUT the instrument
        }

        $instrument = '/\b(Acts?|Regulations?|Rules?|Determination|Ordinance|Order|Code|'
            . 'Declaration|Direction|Directive|Instrument|Bill|Amendment)\s+(No\.?\s*\d+\s+of\s+)?(19|20)\d{2}\b/u';
        if (preg_match($instrument, $title) !== 1) {
            return false;
        }

        // Strip trailing pinpoints ("pt 3 div 3AA", "s 42(1)", "sch 2 cl 4").
        $stripped = (string) preg_replace(
            '/(?:\s+(?:pt|div|sch|cl|reg|rr?|ss?)\s+[\dA-Za-z().,\x{2013}\s]*)+$/iu',
            '',
            trim($title),
        );

        $jurisdiction = '(Cth|NSW|Vic|Qld|WA|SA|Tas|ACT|NT|UK|NZ|Can|EU|US|Scot|Ir)';
        if (preg_match('/\(' . $jurisdiction . '\)\s*[.;,]?\s*$/u', $stripped) === 1) {
            return true;
        }

        // "(No 1)"-style tail: accept only when the jurisdiction is attested
        // by the raw citation text the title was extracted from.
        return preg_match('/\(No\.?\s*\d+\)\s*[.;,]?\s*$/u', $stripped) === 1
            && $context !== null
            && preg_match('/\(' . $jurisdiction . '\)/u', $context) === 1;
    }

    /**
     * Post-extraction normalizer: coerce a work whose title reads as a
     * legislative instrument to type 'legislation' (primary + every sub), and
     * drop the invented author that usually comes with the mistyping (an
     * instrument has no author; "Social Security Administration" as an author
     * poisons every author-weighted search downstream). Idempotent; applied by
     * the scan job wherever llm_metadata enters its map. $rawText is the
     * citation as printed — jurisdiction evidence the extraction may have
     * clipped off the title.
     */
    public static function coerceLegislativeTypes(?array $meta, ?string $rawText = null): ?array
    {
        if (!is_array($meta) || $meta === []) {
            return $meta;
        }

        $coerce = function (array $work) use ($rawText): array {
            $type = $work['type'] ?? null;
            if (!in_array($type, ['legislation', 'case-law'], true)
                && self::looksLegislative($work['title'] ?? null, $rawText)
            ) {
                $work['type'] = 'legislation';
                $work['authors'] = null;
            }
            return $work;
        };

        $meta = $coerce($meta);
        if (!empty($meta['sub_citations']) && is_array($meta['sub_citations'])) {
            foreach ($meta['sub_citations'] as $i => $sub) {
                if (is_array($sub)) {
                    $meta['sub_citations'][$i] = $coerce($sub);
                }
            }
        }

        return $meta;
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
            'news-article'     => 'news article',
            'archival-source'  => 'archival source',
            'youtube-video'    => 'YouTube video',
            'website'          => 'website',
            'legislation'      => 'piece of legislation',
            'case-law'         => 'court decision',
            default            => 'source',
        };
    }

    /**
     * The single "Source Not Found" explanation, worded by what the entry
     * actually cites. Type-aware — a report must NOT get the "may not be an
     * academic work" hedge when we already classified it as a report — and
     * multi-work-aware: each cited work gets its own assessment, and any
     * unfound journal article carries the 🚩 regardless of position.
     */
    public static function notFoundExplanation(array $claim): string
    {
        $works = self::works($claim);

        if (empty($works)) {
            // No parsed metadata at all — the only case the generic hedge is honest.
            return 'This source could not be found in any academic database (OpenAlex, '
                . 'Semantic Scholar, Open Library). This may be because it is not an '
                . 'academic work, is not professionally published, or uses a '
                . 'non-standard citation format. Human review recommended.';
        }

        if (count($works) === 1) {
            $text = self::singleWorkExplanation($works[0]['type'] ?? 'unknown');
            if (self::possiblyUnsplitMultiWork($claim)) {
                $text .= ' ⚠ The citation text appears to contain more than one work separated by '
                    . 'semicolons, but it was parsed as a single work — the other work(s) were '
                    . 'never searched. Check each cited work manually.';
            }

            return $text;
        }

        $count = count($works);
        $parts = ["This entry cites {$count} works; none could be found in the academic databases we search (OpenAlex, Semantic Scholar, Open Library)."];
        foreach ($works as $i => $work) {
            $n = $i + 1;
            $type = $work['type'] ?? 'unknown';
            $title = $work['title'] ?? '(untitled)';
            $parts[] = "({$n}) \u{201C}{$title}\u{201D} — " . self::perWorkNote($type);
        }

        return implode(' ', $parts);
    }

    private static function singleWorkExplanation(string $type): string
    {
        if (in_array($type, self::EXPECTED_IN_DATABASES, true)) {
            return '🚩 This citation is formatted as a journal article, yet it could not '
                . 'be found in any academic database (OpenAlex, Semantic Scholar, Open '
                . 'Library). Peer-reviewed journal articles are almost always indexed '
                . 'there, so its absence is a stronger warning sign — the reference may '
                . 'be miscited or fabricated. Human review strongly recommended.';
        }

        $label = self::label($type);
        $an = preg_match('/^[aeiou]/i', $label) ? 'an' : 'a';

        if (in_array($type, self::NOT_EXPECTED_IN_DATABASES, true)) {
            return "This citation is {$an} {$label}, which is typically not indexed in "
                . 'the academic databases we search (OpenAlex, Semantic Scholar, Open '
                . 'Library) — so its absence there is expected and is not itself a '
                . 'warning sign. To verify it, check directly with the publisher or '
                . 'issuing body.';
        }

        if (in_array($type, self::SOMETIMES_INDEXED, true)) {
            return "This citation is {$an} {$label}, which could not be found in any "
                . 'academic database (OpenAlex, Semantic Scholar, Open Library). Works '
                . 'of this type are sometimes legitimately unindexed, so absence alone '
                . 'is a weak signal. Human review recommended.';
        }

        // Unknown / unclassified type — the honest generic hedge.
        return 'This source could not be found in any academic database (OpenAlex, '
            . 'Semantic Scholar, Open Library). This may be because it is not an '
            . 'academic work, is not professionally published, or uses a non-standard '
            . 'citation format. Human review recommended.';
    }

    private static function perWorkNote(string $type): string
    {
        if (in_array($type, self::EXPECTED_IN_DATABASES, true)) {
            return '🚩 formatted as a journal article yet absent from every academic '
                . 'database, where journal articles are almost always indexed — possible '
                . 'miscited or fabricated reference; human review strongly recommended.';
        }

        $label = self::label($type);
        $an = preg_match('/^[aeiou]/i', $label) ? 'an' : 'a';

        if (in_array($type, self::NOT_EXPECTED_IN_DATABASES, true)) {
            return "{$an} {$label}, not expected in academic databases; absence there is "
                . 'normal — verify with the publisher or issuing body if needed.';
        }

        if (in_array($type, self::SOMETIMES_INDEXED, true)) {
            return "{$an} {$label}, sometimes legitimately unindexed; human review recommended.";
        }

        return 'a source of unrecognised type; human review recommended.';
    }
}
