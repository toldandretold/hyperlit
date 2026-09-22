<?php

namespace App\Services\CitationReview\Support;

/**
 * "The source we verified against is not the work this citation is about."
 *
 * The one condition that makes a verdict MEANINGLESS rather than negative. Whatever the LLM
 * concluded — supported, unsupported, rejected — it concluded it about a different work, so the
 * verdict says nothing about the citation and must not be read as though it did.
 *
 * THREE CAUSES, and naming the right one decides what the reader does about it. Measured across
 * phase2 (11 cases in 6 books, every one on a non-flagged verdict and therefore buried):
 *
 *  - MULTI-WORK (8 of 11). The footnote cites several works and we matched a NON-PRIMARY one.
 *    "Pedregosa et al., Scikit-learn… ; Images are produced using Hadley Wickham, ggplot2…"
 *    matched ggplot2, then checked a claim about logistic regression against a graphics book.
 *    The identifier is CORRECT for the work it named — nothing is mistyped — so telling the
 *    reader to check the DOI sends them to look at something that is fine.
 *  - IDENTIFIER (2 of 11). A DOI that genuinely names another work: author's typo, or our own
 *    extraction taking a neighbouring reference's DOI.
 *  - CONTAINER (the residue). A chapter resolving to the book that contains it — "What Dialogue?"
 *    → "Confronting the North-South Dilemma". Not wrong so much as coarse, but the reviewer still
 *    judged the whole volume rather than the chapter.
 *
 * ONE definition, three readers: the resolver (flags at match time), the report (its own section)
 * and the /maintainer/study workbench. Duplicating the threshold is how the console and the
 * report end up disagreeing about the same citation.
 */
final class SourceWorkMismatch
{
    /**
     * Below this token overlap, two titles are describing different works.
     *
     * Measured over every low-overlap resolution in the study corpora: the same work with
     * formatting differences scores 0.73+ ("MarketizingHindutva" vs "Marketizing Hindutva",
     * "RegCheck: a tool for automating…" vs "…for structured…"), real mismatches 0.00-0.17.
     * Nothing lands between, so the bar sits in the gap.
     */
    public const TITLE_OVERLAP_FLOOR = 0.35;

    public const CAUSE_MULTI_WORK = 'multi_work';
    public const CAUSE_IDENTIFIER = 'identifier';
    public const CAUSE_TITLE_SEARCH = 'title_search';

    /**
     * Do these two titles describe different works? The raw comparison, used by the resolver at
     * match time when there is no claim yet.
     *
     * @return array<string, mixed>|null null when they agree, or when either side is missing —
     *                                   silence is not disagreement
     */
    public static function compare(
        ?string $citedTitle,
        ?string $matchedTitle,
        ?int $citedYear = null,
        ?int $matchedYear = null,
    ): ?array {
        $cited = trim((string) $citedTitle);
        $matched = trim((string) $matchedTitle);
        if ($cited === '' || $matched === '') {
            return null;
        }
        $overlap = self::overlap($cited, $matched);
        if ($overlap === null || $overlap >= self::TITLE_OVERLAP_FLOOR) {
            return null;
        }

        return [
            'cited_title'   => mb_substr($cited, 0, 200),
            'matched_title' => mb_substr($matched, 0, 200),
            'cited_year'    => $citedYear,
            'matched_year'  => $matchedYear,
            'overlap'       => round($overlap, 3),
        ];
    }

    /**
     * The mismatch for a finished CLAIM, with its cause.
     *
     * DERIVED from the claim rather than read from a stored flag: the flag is written at resolve
     * time, so relying on it would show nothing for every run that predates it and make seeing
     * the finding cost a full re-scan. It also could not classify the cause — sub_citations are
     * only known once the claim exists.
     *
     * @param  array<string, mixed>  $claim
     * @return array<string, mixed>|null
     */
    public static function forClaim(array $claim): ?array
    {
        if (empty($claim['source_book_id'])) {
            return null; // nothing was matched, so nothing can be mismatched
        }
        $meta = $claim['llm_metadata'] ?? null;
        if (!is_array($meta)) {
            return null;
        }

        $flag = self::compare(
            $meta['title'] ?? null,
            $claim['source_title'] ?? null,
            isset($meta['year']) ? (int) $meta['year'] : null,
            isset($claim['source_year']) ? (int) $claim['source_year'] : null,
        );
        if ($flag === null) {
            return null;
        }

        // Which of the cited works IS the matched source? If one of the entry's other works
        // agrees, the identifier did its job and the failure is that we verified the wrong member
        // of a multi-work citation.
        $subs = [];
        foreach ($meta['sub_citations'] ?? [] as $sub) {
            if (is_array($sub)) {
                $subs[] = $sub;
            }
        }
        $matchedIndex = null;
        foreach ($subs as $i => $sub) {
            $o = self::overlap((string) ($sub['title'] ?? ''), (string) ($claim['source_title'] ?? ''));
            if ($o !== null && $o >= self::TITLE_OVERLAP_FLOOR) {
                $matchedIndex = $i;
                break;
            }
        }

        if ($matchedIndex !== null) {
            $flag['cause'] = self::CAUSE_MULTI_WORK;
            $flag['matched_work_position'] = $matchedIndex + 2; // primary is #1, subs follow
            $flag['total_works'] = count($subs) + 1;
            $flag['matched_work_title'] = mb_substr((string) ($subs[$matchedIndex]['title'] ?? ''), 0, 200);

            return $flag;
        }

        // TWO ESCAPES, measured on phase2's own false positives — both must run AFTER the
        // multi-work check, whose footnotes also put the record's title in the citation text.
        //
        // ESCAPE 1 — COMPONENT OF THE CITED WORK. "What Dialogue?" in "Confronting the
        // North-South Dilemma" (Kissinger 1982) resolves, at its own printed DOI, to the
        // containing piece: the record's title appears VERBATIM in the citation because the
        // author wrote it there. Nothing is broken and the record is the right thing to verify
        // against; flagging it sends the reader to fix a citation with nothing wrong in it.
        $bibText = html_entity_decode(strip_tags((string) ($claim['bib_citation'] ?? '')), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $recordTokens = self::tokens((string) ($claim['source_title'] ?? ''));
        if (count($recordTokens) >= 3
            && $bibText !== ''
            && array_diff($recordTokens, self::tokens($bibText)) === []
            && self::yearsAgree($flag['cited_year'], $flag['matched_year'], $meta)
        ) {
            return null;
        }

        // ESCAPE 2 — SAME WORK, DIFFERENT TITLE. Nature's print headline ("Scientists split on
        // ethics of AI use", 641:574-577) vs the web headline of the SAME article at the SAME
        // DOI. When the identifier is self-consistent and author AND year both corroborate the
        // record, a divergent title is headline/edition variance, not a different work.
        // Author is corroboration, not a veto: OCR routinely mangles the author field ("Diana
        // Kwon" arrived as "G., G."), and an UNREADABLE author must not overrule a printed DOI
        // and an agreeing year. A readable author that DISAGREES still blocks the escape.
        if (self::isIdentifierMatch($claim)
            && self::printedDoiAgrees($meta, $claim)
            && self::yearsAgree($flag['cited_year'], $flag['matched_year'], $meta)
            && self::authorsOverlap($meta['authors'] ?? null, $claim['source_author'] ?? null) !== false
        ) {
            return null;
        }

        if (self::isIdentifierMatch($claim)) {
            $flag['cause'] = self::CAUSE_IDENTIFIER;
        } else {
            $flag['cause'] = self::CAUSE_TITLE_SEARCH;
        }

        return $flag;
    }

    /**
     * Was this claim resolved by an IDENTIFIER rather than a title search?
     *
     * `match_method` alone cannot answer it: Wave 2a (local DOI) did not PERSIST the method until
     * 2026-09-21, so claims it resolved before then read as method-less while plainly being DOI
     * matches. A resolved `source_doi` is the durable evidence.
     *
     * @param  array<string, mixed>  $claim
     */
    public static function isIdentifierMatch(array $claim): bool
    {
        $method = $claim['match_method'] ?? null;
        if (in_array($method, ['doi', 'local_doi'], true)) {
            return true;
        }

        return $method === null && !empty($claim['source_doi']);
    }

    /** Years corroborate when the record has one and the cited year (or original_year) sits within ±1. */
    private static function yearsAgree(?int $cited, ?int $matched, array $meta): bool
    {
        if ($matched === null) {
            return false;
        }
        $original = isset($meta['original_year']) ? (int) $meta['original_year'] : null;
        foreach ([$cited, $original] as $candidate) {
            if ($candidate !== null && abs($candidate - $matched) <= 1) {
                return true;
            }
        }

        return false;
    }

    /** The citation's own printed DOI, when present, must be the record's DOI. */
    private static function printedDoiAgrees(array $meta, array $claim): bool
    {
        $printed = strtolower(trim((string) ($meta['doi'] ?? '')));
        if ($printed === '') {
            return true; // nothing printed to disagree with
        }
        $record = strtolower(trim((string) ($claim['source_doi'] ?? '')));

        return $record !== '' && $printed === $record;
    }

    /**
     * Tri-state author agreement: true = a cited surname appears in the record's author string;
     * false = both sides are readable and none does; null = one side has nothing usable to
     * compare (no surname-length token survives), so the field is EVIDENCE-FREE, not contrary.
     */
    private static function authorsOverlap($citedAuthors, ?string $recordAuthor): ?bool
    {
        $cited = is_array($citedAuthors) ? $citedAuthors : (is_string($citedAuthors) ? [$citedAuthors] : []);
        $usable = [];
        foreach ($cited as $author) {
            foreach (self::tokens((string) $author) as $token) {
                if (mb_strlen($token) >= 3) {
                    $usable[] = $token;
                }
            }
        }
        if ($usable === [] || empty($recordAuthor)) {
            return null;
        }
        $record = mb_strtolower((string) $recordAuthor);
        foreach ($usable as $token) {
            if (str_contains($record, $token)) {
                return true;
            }
        }

        return false;
    }

    /** Public face of the overlap measure, so the broken-source probe scores candidates the
     * same way the detector does — two similarity definitions would disagree at the margins. */
    public static function titleOverlap(string $a, string $b): ?float
    {
        return self::overlap($a, $b);
    }

    /** Jaccard overlap of the two titles' word sets, or null when either is empty. */
    private static function overlap(string $a, string $b): ?float
    {
        $x = self::tokens($a);
        $y = self::tokens($b);
        if ($x === [] || $y === []) {
            return null;
        }

        return count(array_intersect($x, $y)) / max(1, count(array_unique(array_merge($x, $y))));
    }

    /** @return list<string> */
    private static function tokens(string $s): array
    {
        $words = preg_split('/\s+/', trim((string) preg_replace('/[^a-z0-9 ]/', ' ', mb_strtolower($s))));

        return array_values(array_unique(array_filter($words ?: [])));
    }
}
