<?php

namespace App\Services\Hypercites;

use App\Services\Annotations\AnnotationReattachmentService;

/**
 * Does this in-text citation carry a direct quote? Pure text analysis over the
 * citing node's plainText (and its ±1 neighbours for blockquotes) — no DB, no
 * network, so the whole class is unit-testable with strings.
 *
 * Two shapes are recognised:
 *  - INLINE: a paired quoted span ("…", “…”, '…', ‘…’) inside the claim
 *    sentence, long enough to be a quotation rather than a scare-quoted term,
 *    whose closing mark sits near the citation marker (same node).
 *  - BLOCKQUOTE: a node whose content root is <blockquote>, attributed to the
 *    marker when the marker is inside the blockquote itself, or in the first
 *    sentence of the node after it / the last sentence of the node before it.
 *
 * Coordinate space: plainText with entities decoded — the same space
 * CitationParser computes marker offsets in, and the same space the client's
 * charData indexes.
 */
class QuoteDetector
{
    /**
     * How many closing marks one single-quoted span may offer as alternative
     * readings (see detectInline). Bounds the scan; three covers a title with
     * two possessive plurals inside it.
     */
    private const MAX_CANDIDATES = 3;

    private const OPEN_MARKS = ["\u{201C}", '"', "\u{2018}", "'"];
    private const CLOSE_FOR = [
        "\u{201C}" => "\u{201D}",
        '"'        => '"',
        "\u{2018}" => "\u{2019}",
        "'"        => "'",
    ];

    /**
     * Find the quote (if any) belonging to a citation marker.
     *
     * `text` is the best single reading (the closer NEAREST the marker) and is
     * what gets stored when nothing can be verified. `candidates` holds every
     * plausible reading, LONGEST FIRST, for the caller to resolve against the
     * cited text — see detectInline for why a single reading is not enough.
     *
     * @param string $plainText   the citing node's decoded plainText
     * @param int    $markerOffset char offset of the citation marker in $plainText
     * @param array{node_id:string, plainText:string, is_blockquote:bool} $node       the citing node
     * @param ?array{node_id:string, plainText:string, is_blockquote:bool} $prevNode
     * @param ?array{node_id:string, plainText:string, is_blockquote:bool} $nextNode
     * @param int[] $markerOffsets EVERY citation-marker offset in the node,
     *        this one included. A quote belongs to the citation that
     *        attributes it, and only that one — see spanOwner.
     * @return ?array{kind:string, text:string, node_id:string, candidates:string[]}
     */
    public function detect(
        string $plainText,
        int $markerOffset,
        array $node,
        ?array $prevNode,
        ?array $nextNode,
        array $markerOffsets = [],
    ): ?array {
        // Our own marker always counts, whether the caller passed "all
        // markers" or only the others (and an empty list means "just me" —
        // no competition, so ownership can't spuriously reject).
        $markerOffsets = array_values(array_unique(array_merge($markerOffsets, [$markerOffset])));

        $spans = $this->detectInline($plainText, $markerOffset, $markerOffsets);
        if ($spans !== []) {
            // Fallback reading: closer nearest the marker (what a single-pass
            // scanner picks). Candidates: longest first — a longer span that
            // appears verbatim in the source is strictly better evidence than
            // its own prefix.
            $byDistance = $spans;
            usort($byDistance, fn ($a, $b) => $a['distance'] <=> $b['distance']);
            $primary = $byDistance[0]['text'];

            $byLength = $spans;
            usort($byLength, fn ($a, $b) => $b['len'] <=> $a['len']);
            $candidates = [];
            foreach ($byLength as $span) {
                if (! in_array($span['text'], $candidates, true)) {
                    $candidates[] = $span['text'];
                }
            }
            $candidates = array_slice($candidates, 0, self::MAX_CANDIDATES);
            if (! in_array($primary, $candidates, true)) {
                $candidates[] = $primary;
            }

            return [
                'kind'       => 'inline',
                'text'       => $primary,
                'node_id'    => $node['node_id'],
                'candidates' => $candidates,
            ];
        }

        // Blockquote attribution, nearest-first: the marker's own node, then ±1.
        if ($node['is_blockquote']) {
            return $this->blockquote(trim($plainText), $node['node_id']);
        }

        // Marker in the first sentence of the node AFTER a blockquote → the
        // blockquote is the quote ("…quote…\n(Author 2020) argues that…" is rare;
        // the common shape is quote then attribution, so prev wins over next).
        // Only the FIRST marker of that sentence may claim it: in "…(see A
        // 2020), unlike B (2021)" the block belongs to A.
        if ($prevNode && $prevNode['is_blockquote']
            && $this->inFirstSentence($plainText, $markerOffset)
            && ! $this->hasMarkerBefore($markerOffsets, $markerOffset)) {
            return $this->blockquote(trim($prevNode['plainText']), $prevNode['node_id']);
        }

        if ($nextNode && $nextNode['is_blockquote']
            && $this->inLastSentence($plainText, $markerOffset)
            && ! $this->hasMarkerAfter($markerOffsets, $markerOffset)) {
            return $this->blockquote(trim($nextNode['plainText']), $nextNode['node_id']);
        }

        return null;
    }

    /** @return array{kind:string, text:string, node_id:string, candidates:string[]} */
    private function blockquote(string $text, string $nodeId): array
    {
        return ['kind' => 'blockquote', 'text' => $text, 'node_id' => $nodeId, 'candidates' => [$text]];
    }

    /**
     * The claim-sentence bounds around a marker (same regex logic as
     * ClaimSpanExtractor::sentenceAtPosition, but returning OFFSETS).
     *
     * @return array{0:int,1:int} [start, end)
     */
    public function sentenceBounds(string $plainText, int $charPos): array
    {
        $before = mb_substr($plainText, 0, $charPos);
        $start = preg_match('/.*[.!?]\s+/su', $before, $m) ? mb_strlen($m[0]) : 0;

        $after = mb_substr($plainText, $charPos);
        $end = preg_match('/^.*?[.!?](?:\s|$)/su', $after, $m)
            ? $charPos + mb_strlen($m[0])
            : mb_strlen($plainText);

        return [$start, $end];
    }

    /**
     * Every plausible paired quoted span whose closing mark is within the
     * configured gap of the marker and at least the configured normalized
     * length — inner text, marks stripped.
     *
     * WHY A LIST, not a single answer: in single-quote house styles (this is
     * the British-journal norm) a possessive plural is character-identical to
     * a closing quote. In
     *
     *   In '(Dis)connection between curriculum, pedagogy and learners' lived
     *   experience in Nepal's secondary schools: an … perspective', …
     *
     * the apostrophe after `learners` is followed by a space, exactly like the
     * real closer after `perspective` — so a first-closer-wins scan truncates
     * the quote mid-title. (`Nepal's` is safe: a letter follows, so it is
     * rejected as a closer.) No amount of local text analysis settles this;
     * the disambiguator is the CITED DOCUMENT, which the caller already has —
     * it tries these candidates longest-first and keeps whichever actually
     * appears in the source. Double-quote spans are unambiguous, so they still
     * stop at their first closer.
     *
     * @param int[] $markerOffsets every citation-marker offset in the node
     * @return array<int, array{text:string, distance:int, len:int}>
     */
    private function detectInline(string $plainText, int $markerOffset, array $markerOffsets = []): array
    {
        [$sentStart, $sentEnd] = $this->sentenceBounds($plainText, $markerOffset);
        $maxGap = (int) config('hypercites.max_quote_marker_gap', 300);
        $minChars = (int) config('hypercites.min_quote_chars', 20);

        // Scan the sentence, widened by the gap on the marker side: a quote may
        // START in a previous sentence and end just before the marker ("…end of
        // quote." (Author 2020)) — the period ends the sentence at the quote's
        // close, so the span itself often straddles the sentence boundary.
        $scanStart = max(0, min($sentStart, $markerOffset - $maxGap));
        $scanEnd = min(mb_strlen($plainText), max($sentEnd, $markerOffset));
        $window = mb_substr($plainText, $scanStart, $scanEnd - $scanStart);

        $spans = [];
        $chars = mb_str_split($window);
        $n = count($chars);

        for ($i = 0; $i < $n; $i++) {
            $open = $chars[$i];
            if (! in_array($open, self::OPEN_MARKS, true)) {
                continue;
            }
            // Straight single-quote apostrophes are indistinguishable from quote
            // marks mid-word; only treat ' / ‘ as an opener at a word boundary.
            if (($open === "'" || $open === "\u{2018}") && $i > 0 && preg_match('/[\p{L}\p{N}]/u', $chars[$i - 1])) {
                continue;
            }
            $close = self::CLOSE_FOR[$open];
            $singleQuoted = in_array($close, ["'", "\u{2019}"], true);
            $closersSeen = 0;

            for ($j = $i + 1; $j < $n; $j++) {
                if ($chars[$j] !== $close) {
                    continue;
                }
                // An apostrophe inside a single-quoted span is a closer only at
                // a word END — `Nepal's` can never close, `learners'` can.
                if ($singleQuoted && $j + 1 < $n && preg_match('/[\p{L}\p{N}]/u', $chars[$j + 1])) {
                    continue;
                }
                $inner = implode('', array_slice($chars, $i + 1, $j - $i - 1));
                $normLen = mb_strlen(AnnotationReattachmentService::normalize($inner)['text']);
                $openAbs = $scanStart + $i;
                $closeAbs = $scanStart + $j;
                $distance = abs($markerOffset - $closeAbs);
                if ($normLen >= $minChars
                    && $distance <= $maxGap
                    && $this->spanOwner($markerOffsets, $openAbs, $closeAbs, $maxGap) === $markerOffset) {
                    $spans[] = ['text' => trim($inner), 'distance' => $distance, 'len' => $normLen];
                }

                $closersSeen++;
                // Double quotes: the first closer is THE closer. Single quotes:
                // keep going — a possessive plural reads exactly like one, and
                // the cited text decides between the readings (bounded scan).
                if (! $singleQuoted || $closersSeen >= self::MAX_CANDIDATES) {
                    break;
                }
            }
        }

        return $spans;
    }

    /**
     * Which citation marker OWNS this quoted span?
     *
     * Academic prose attributes a quotation to the citation that FOLLOWS it —
     * "…'quoted words' (Author 2020: 5)" — and only when nothing follows does
     * a preceding narrative citation own it — "Author (2020) writes that
     * '…'". So: the nearest marker after the closing mark wins; failing that,
     * the nearest before the opening mark. Both live failures this settles
     * come from one GSCJ paragraph:
     *
     *   …praxis is understood as a 'QUOTE' (Mehta et al, 2021a: 112). The
     *   articles in this collection (especially Srivastava et al, 2026)…
     *
     * — Srivastava is inside the gap window and their article quotes Mehta
     * too, so the words located there and minted a hypercite claiming they
     * were Srivastava's. Mehta follows the quote, so Mehta owns it. And:
     *
     *   Masaka (2019) … needs to go beyond 'QUOTE' (Keet, 2014: 27) to…
     *
     * — a preceding-marker-wins rule would hand Keet's words to Masaka.
     *
     * @param int[] $markers every citation-marker offset in the node
     */
    private function spanOwner(array $markers, int $openAbs, int $closeAbs, int $maxGap): ?int
    {
        $after = null;
        foreach ($markers as $pos) {
            if ($pos >= $closeAbs && $pos - $closeAbs <= $maxGap && ($after === null || $pos < $after)) {
                $after = $pos;
            }
        }
        if ($after !== null) {
            return $after;
        }

        $before = null;
        foreach ($markers as $pos) {
            if ($pos <= $openAbs && $openAbs - $pos <= $maxGap && ($before === null || $pos > $before)) {
                $before = $pos;
            }
        }

        return $before;
    }

    /** @param int[] $markerOffsets */
    private function hasMarkerBefore(array $markerOffsets, int $markerOffset): bool
    {
        foreach ($markerOffsets as $pos) {
            if ($pos < $markerOffset) {
                return true;
            }
        }

        return false;
    }

    /** @param int[] $markerOffsets */
    private function hasMarkerAfter(array $markerOffsets, int $markerOffset): bool
    {
        foreach ($markerOffsets as $pos) {
            if ($pos > $markerOffset) {
                return true;
            }
        }

        return false;
    }

    private function inFirstSentence(string $plainText, int $charPos): bool
    {
        [$start] = $this->sentenceBounds($plainText, $charPos);

        return $start === 0;
    }

    private function inLastSentence(string $plainText, int $charPos): bool
    {
        [, $end] = $this->sentenceBounds($plainText, $charPos);

        return $end >= mb_strlen(rtrim($plainText));
    }
}
