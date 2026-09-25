<?php

namespace App\Services\CitationReview\Support;

/**
 * Extract the claim text span around a citation marker in plain text.
 * Extracted verbatim from CitationReviewService::extractPrecedingClauseSpan /
 * ::extractSentenceAtPosition.
 *
 * Every "where does this claim start and stop" question in the review goes
 * through here — the prompt's span hint, the fallback claim when the model's
 * answer is unusable, the highlight window, and the scoping guard that clips a
 * claim which has swallowed a neighbouring citation's material.
 */
final class ClaimSpanExtractor
{
    /**
     * Words whose trailing period does NOT end a sentence. A single letter is
     * handled separately (an initial — "Robert W. Cox"), which is the case that
     * actually bit: the naive boundary split that sentence in two and left the
     * Cox citation a 24-character claim ("all agreed.") in the 2026-09-20 run.
     */
    private const ABBREVIATIONS = [
        'al', 'etc', 'cf', 'vs', 'viz', 'ed', 'eds', 'vol', 'vols', 'no', 'nos', 'pp', 'p',
        'trans', 'ibid', 'op', 'cit', 'esp', 'repr', 'rev', 'fig', 'figs', 'ch', 'chap',
        'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'jr', 'sr', 'inc', 'ltd', 'co',
    ];

    /** Shortest run of quoted text that counts as an attributed quotation rather than a scare quote. */
    private const MIN_QUOTATION_CHARS = 25;

    /** How far a citation may sit from the quotation mark it signs off. */
    private const MAX_ATTRIBUTION_GAP = 60;

    /** Closing quote character → the openers that can legitimately pair with it. */
    private const QUOTE_PAIRS = [
        '"' => ['"', '“'],
        '”' => ['"', '“'],
        "'" => ["'", '‘'],
        '’' => ["'", '‘'],
    ];

    /**
     * Claim span for a FOOTNOTE marker: the text immediately BEFORE the marker,
     * starting at the sentence boundary or the previous citation marker —
     * whichever is nearer. Footnote markers attach backwards; extending the
     * span forward (or back across another marker) attributes a neighbouring
     * clause's claim to the wrong source.
     */
    public function precedingClauseSpan(string $plainText, int $charPos, array $allMarkerPositions): string
    {
        [$start] = $this->sentenceBoundsAt($plainText, $charPos);

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
     */
    public function sentenceAtPosition(string $plainText, int $charPos): string
    {
        [$start, $end] = $this->sentenceBoundsAt($plainText, $charPos);

        return trim(mb_substr($plainText, $start, $end - $start));
    }

    /**
     * The character bounds of the sentence containing $charPos — the one
     * definition of a sentence in the review, so the claim text, the highlight
     * window and the scoping guard cannot disagree about where one ends.
     *
     * @return array{0: int, 1: int} [startChar, endChar)
     */
    public function sentenceBoundsAt(string $plainText, int $charPos): array
    {
        $starts = $this->sentenceStarts($plainText);
        $start = 0;
        $end = mb_strlen($plainText);

        foreach ($starts as $s) {
            if ($s <= $charPos) {
                $start = $s;
            } elseif ($s < $end) {
                $end = $s;
                break;
            }
        }

        return [$start, $end];
    }

    /**
     * The span THIS citation owns, used when a claim has to be scoped back to
     * one citation's own material. The sentence, plus the two corrections that
     * an attributed quotation demands:
     *
     *  - a citation standing directly after a closing quote OWNS the quotation,
     *    so the span reaches back over it even though the quote runs across
     *    several sentences ("'We never became aggressors… spirituality' (Doval
     *    quoted in TNN, 2020)" — the citation is offered for the quote, and a
     *    span cut at the last full stop quotes a third of it);
     *  - a citation standing BEFORE such a quotation does not own it, so the
     *    span stops at the quotation's opening mark. That is the c161 defect
     *    read the other way round: the BJP manifesto is cited for the viśvaguru
     *    doctrine, not for what Doval said to the Times of India.
     *
     * Bounded by the neighbouring markers on both sides, so scoping can never
     * reach across another citation into material that citation answers for.
     */
    public function ownSegmentSpan(string $plainText, int $charPos, array $allMarkerPositions): string
    {
        [$start, $end] = $this->sentenceBoundsAt($plainText, $charPos);

        $previous = 0;
        $next = null;
        foreach ($allMarkerPositions as $pos) {
            if ($pos < $charPos && $pos > $previous) {
                $previous = $pos;
            }
            if ($pos > $charPos && ($next === null || $pos < $next)) {
                $next = $pos;
            }
        }

        // Backwards over a quotation this citation signs off.
        $quotation = $this->quotationClosedBy($plainText, $charPos, $previous);
        if ($quotation !== null && $quotation[0] < $start) {
            $start = $quotation[0];
        }

        // Forwards only as far as a quotation the NEXT citation signs off.
        if ($next !== null) {
            $theirs = $this->quotationClosedBy($plainText, $next, $charPos);
            if ($theirs !== null && $theirs[0] > $charPos && $theirs[0] < $end) {
                $end = $theirs[0];
            }
        }

        // A span cut at a quotation opener ends on the colon that introduced it.
        return trim(mb_substr($plainText, $start, $end - $start), " \t\n\r\0\x0B:;,");
    }

    /**
     * The attributed quotation a citation at $charPos signs off — "…quoted
     * text" (Author, 2020) — as [openerChar, closerChar], or null when the
     * citation does not follow a quotation.
     *
     * $lowerBound stops the search at the previous citation: a quotation may
     * cross sentence boundaries, so this is the one span rule that deliberately
     * ignores them, and the marker is what keeps it honest.
     *
     * @return array{0: int, 1: int}|null
     */
    public function quotationClosedBy(string $plainText, int $charPos, int $lowerBound = 0): ?array
    {
        if ($charPos <= $lowerBound) {
            return null;
        }

        $tail = mb_substr($plainText, $lowerBound, $charPos - $lowerBound);

        // The closing mark, then the attribution and NOTHING else: optional
        // punctuation, then the citation's own parenthesis — "' (Doval quoted
        // in TNN, ". Running prose in between means the citation belongs to a
        // sentence of its own. That distinction is the whole test: "…ask
        // itself: 'Why did we lose last time round?' Curiously, similar
        // questions were asked by Samir Amin (1982)" reads as an attribution
        // under any looser rule, and hands Varoufakis's question to Amin.
        $gap = self::MAX_ATTRIBUTION_GAP;
        $attribution = '["\'”’]?\s*[,;:.\-—–]?\s*(?:[(\[][^)\]]{0,' . $gap . '})?';
        if (!preg_match('/(["\'”’])' . $attribution . '$/u', $tail, $m, PREG_OFFSET_CAPTURE)) {
            return null;
        }
        $closerChar = $m[1][0];
        $closer = $lowerBound + mb_strlen(substr($tail, 0, $m[1][1]));

        $openers = self::QUOTE_PAIRS[$closerChar] ?? null;
        if ($openers === null) {
            return null;
        }

        // The opening mark is the one INTRODUCED by punctuation (": '", ", “")
        // — the test that tells a quotation from the apostrophe in "Doval's"
        // and from the scare quotes around 'viśvaguru' in the same sentence.
        $head = mb_substr($plainText, $lowerBound, $closer - $lowerBound);
        $class = '';
        foreach ($openers as $openChar) {
            $class .= preg_quote($openChar, '/');
        }
        if (!preg_match_all('/[:;,—–-]\s*([' . $class . '])/u', $head, $om, PREG_OFFSET_CAPTURE)) {
            return null;
        }

        $last = end($om[1]);
        $opener = $lowerBound + mb_strlen(substr($head, 0, $last[1]));

        if ($closer - $opener < self::MIN_QUOTATION_CHARS) {
            return null;
        }

        return [$opener, $closer];
    }

    /**
     * Character offsets at which a sentence STARTS. Abbreviation-aware, because
     * the boundary decides what a citation is held to: "Robert W. Cox (1981)"
     * split there, and the claim that three named theorists "all agreed" was
     * scoped down to the two words after the initial.
     *
     * @return list<int>
     */
    private function sentenceStarts(string $plainText): array
    {
        $starts = [0];

        if (!preg_match_all('/[.!?]+["\'”’\)\]]*\s+/u', $plainText, $m, PREG_OFFSET_CAPTURE)) {
            return $starts;
        }

        foreach ($m[0] as [$match, $byteOffset]) {
            $punctAt = mb_strlen(substr($plainText, 0, $byteOffset));
            $nextStart = $punctAt + mb_strlen($match);
            if ($this->isSentenceEnd($plainText, $punctAt, $nextStart)) {
                $starts[] = $nextStart;
            }
        }

        return $starts;
    }

    private function isSentenceEnd(string $plainText, int $punctAt, int $nextStart): bool
    {
        $before = mb_substr($plainText, 0, $punctAt);
        if (preg_match('/([\p{L}\p{N}\'’.]+)$/u', $before, $w)) {
            $word = mb_strtolower(trim($w[1], '.'));
            // A single letter is an initial ("Robert W. Cox"); an internal period
            // makes it a lettered abbreviation ("e.g.", "U.S.", "Ph.D."). Neither
            // ends a sentence, and that rule needs no list to maintain.
            if (mb_strlen($word) <= 1 || str_contains($word, '.')) {
                return false;
            }
            if (in_array($word, self::ABBREVIATIONS, true)) {
                return false;
            }
        }

        // A sentence does not begin lower-case. Catches the abbreviations no
        // list will ever cover, which is most of them.
        $next = mb_substr($plainText, $nextStart, 1);

        return $next === '' || !preg_match('/\p{Ll}/u', $next);
    }
}
