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
 *  - BLOCKQUOTE: a contiguous run of <blockquote> nodes, attributed to the
 *    marker when the marker is inside the blockquote itself, or in the first
 *    sentence of the node after the run / the last sentence of the node before
 *    it. Unlike an inline span, a blockquote carries no delimiters saying where
 *    the quoted words stop — see blockquoteText for what has to come off.
 *
 * Coordinate space: plainText with entities decoded — the same space
 * CitationParser computes marker offsets in, and the same space the client's
 * charData indexes. BLOCKQUOTE text is the exception: it is rebuilt from the
 * node's HTML and whitespace-collapsed, so it does NOT index the citing node.
 * That is safe because a blockquote candidate stores only `quote_node_id` on
 * the citing side (the console marks the whole node) — all charData offsets
 * live on the CITED side, which QuoteLocator computes independently.
 *
 * @phpstan-type NodeShape array{node_id: string, plainText: string, is_blockquote: bool, content?: ?string}
 */
class QuoteDetector
{
    /**
     * How many closing marks one single-quoted span may offer as alternative
     * readings (see detectInline). Bounds the scan; three covers a title with
     * two possessive plurals inside it.
     */
    private const MAX_CANDIDATES = 3;

    /**
     * How many adjacent <blockquote> nodes may be joined into one quote.
     * Matches QuoteLocator::MAX_WINDOW_NODES — a run longer than the window the
     * cited side can straddle could never be located anyway.
     */
    private const MAX_RUN_NODES = 4;

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
     * @param NodeShape  $node      the citing node
     * @param NodeShape[] $prevNodes the nodes immediately BEFORE the citing node,
     *        in DOCUMENT order (so the LAST entry is the nearest neighbour). The
     *        detector walks back through them for a contiguous blockquote run —
     *        a quote split over several <blockquote> siblings is one quotation,
     *        and taking only the nearest silently truncated it to its final
     *        paragraph (100 blockquote nodes in the local corpus sit in a run).
     * @param NodeShape[] $nextNodes the nodes immediately AFTER, in document
     *        order (the FIRST entry is the nearest neighbour).
     * @param int[] $markerOffsets EVERY citation-marker offset in the node,
     *        this one included. A quote belongs to the citation that
     *        attributes it, and only that one — see spanOwner.
     * @return ?array{kind:string, text:string, node_id:string, candidates:string[]}
     */
    public function detect(
        string $plainText,
        int $markerOffset,
        array $node,
        array $prevNodes = [],
        array $nextNodes = [],
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

        // Blockquote attribution, nearest-first: the marker's own node, then ±1
        // (extended through any contiguous run of blockquote siblings).
        if ($node['is_blockquote']) {
            return $this->blockquote([$node]);
        }

        // Marker in the first sentence of the node AFTER a blockquote → the
        // blockquote is the quote ("…quote…\n(Author 2020) argues that…" is rare;
        // the common shape is quote then attribution, so prev wins over next).
        // Only the FIRST marker of that sentence may claim it: in "…(see A
        // 2020), unlike B (2021)" the block belongs to A.
        $prevRun = $this->blockquoteRunBefore($prevNodes);
        if ($prevRun !== []
            && $this->inFirstSentence($plainText, $markerOffset)
            && ! $this->hasMarkerBefore($markerOffsets, $markerOffset)) {
            return $this->blockquote($prevRun);
        }

        $nextRun = $this->blockquoteRunAfter($nextNodes);
        if ($nextRun !== []
            && $this->inLastSentence($plainText, $markerOffset)
            && ! $this->hasMarkerAfter($markerOffsets, $markerOffset)) {
            return $this->blockquote($nextRun);
        }

        return null;
    }

    /**
     * The contiguous blockquote run ending at the nearest preceding neighbour,
     * returned in document order. Empty when the nearest neighbour is not a
     * blockquote — a non-blockquote node between the marker and a block ends
     * the attribution (the intervening node is the thing being cited).
     *
     * @param NodeShape[] $prevNodes document order, last = nearest
     * @return NodeShape[]
     */
    private function blockquoteRunBefore(array $prevNodes): array
    {
        $run = [];
        for ($i = count($prevNodes) - 1; $i >= 0 && count($run) < self::MAX_RUN_NODES; $i--) {
            if (! ($prevNodes[$i]['is_blockquote'] ?? false)) {
                break;
            }
            array_unshift($run, $prevNodes[$i]);
        }

        return $run;
    }

    /**
     * The contiguous blockquote run starting at the nearest following
     * neighbour, in document order.
     *
     * @param NodeShape[] $nextNodes document order, first = nearest
     * @return NodeShape[]
     */
    private function blockquoteRunAfter(array $nextNodes): array
    {
        $run = [];
        foreach ($nextNodes as $candidate) {
            if (! ($candidate['is_blockquote'] ?? false) || count($run) >= self::MAX_RUN_NODES) {
                break;
            }
            $run[] = $candidate;
        }

        return $run;
    }

    /**
     * Build the blockquote result for a run: each node cleaned (blockquoteText),
     * joined with a single space — the same shape QuoteLocator::locateAcrossNodes
     * builds on the cited side, so a run that maps to several cited nodes still
     * matches. `node_id` is the run's FIRST node (what the console pane scrolls
     * to; the whole node is marked regardless).
     *
     * Null when nothing survives cleaning, or when the result is below the
     * length floor that separates a quotation from a stray fragment — the same
     * `min_quote_chars` the inline path uses.
     *
     * @param NodeShape[] $run document order, non-empty
     * @return ?array{kind:string, text:string, node_id:string, candidates:string[]}
     */
    private function blockquote(array $run): ?array
    {
        $parts = [];
        foreach ($run as $node) {
            $cleaned = $this->blockquoteText($node);
            if ($cleaned !== '') {
                $parts[] = $cleaned;
            }
        }
        if ($parts === []) {
            return null;
        }

        $text = implode(' ', $parts);
        $normLen = mb_strlen(AnnotationReattachmentService::normalize($text)['text']);
        if ($normLen < (int) config('hypercites.min_quote_chars', 20)) {
            return null;
        }

        return [
            'kind'       => 'blockquote',
            'text'       => $text,
            'node_id'    => $run[0]['node_id'],
            'candidates' => [$text],
        ];
    }

    /**
     * The QUOTED WORDS of one blockquote node, with the citing author's
     * furniture removed — this is what gets searched in the cited work.
     *
     * An inline quote arrives pre-delimited: the marks say exactly where the
     * borrowed words start and stop. A blockquote says only "this block is a
     * quotation", and the block routinely carries text the source does not:
     *
     *  - its own attribution, `…of the document content.(Qin,2000, p. 166)`, or
     *    a full bibliographic one, `…the bidding of the CIA” (The Armies of
     *    Ignorance, New York: Dial Press, 1977, 312)`;
     *  - an em-dash epigraph credit, `…no substitute for reality.—Franz Fanon,
     *    The Wretched of the Earth, 1963, p. 61`;
     *  - enclosing quote marks in the citing book's house style, which the
     *    cited edition need not share;
     *  - PARAGRAPH-JOIN GLUE. `plainText` is BeautifulSoup's
     *    `get_text(strip=True)` (and `strip_tags()` on re-save), neither of
     *    which inserts a separator — so a multi-paragraph block reads
     *    `…—(2023)ABSTRACT (summary only…`, a word that exists in no source.
     *    Only the HTML can repair this, hence the `content` walk.
     *
     * Measured over the 11,279 blockquote nodes of the local corpus, cleaning
     * changes 6,938 of them: 6,047 gain a repaired separator and 891 shed a
     * trailing attribution. In other words the majority of blockquotes could
     * not have matched their source verbatim before this ran.
     *
     * Left uncleaned, none of this can match: QuoteLocator stages A and B are
     * substring searches, so a single glued word or a trailing citation defeats
     * them, and stage C's fuzzy window is a FIXED length equal to the segment —
     * contamination both depresses the ratio and slides the window off the true
     * span, which is how a wrong char range gets minted on the cited side.
     *
     * Over-stripping is deliberately the safe direction: a shorter span is
     * still a substring of the cited text, so it still locates (on a narrower
     * range). Under-stripping locates nothing. The bounds below therefore lean
     * toward removing.
     *
     * @param NodeShape $node
     */
    public function blockquoteText(array $node): string
    {
        $content = (string) ($node['content'] ?? '');
        $text = $content !== ''
            ? $this->textFromHtml($content)
            : $this->collapseWhitespace((string) ($node['plainText'] ?? ''));

        if ($text === '' || $this->looksLikeCaption($text)) {
            return '';
        }

        // Twice, around the mark strip: the attribution sits either outside the
        // enclosing marks (`'…quote…' (Qin 2000)`) or inside them
        // (`'…quote… (Qin 2000)'`), and one pass can only catch one of those.
        $text = $this->stripTrailingAttribution($text);
        $text = $this->stripEnclosingMarks($text);

        return $this->stripTrailingAttribution($text);
    }

    /**
     * Node HTML → text, with block boundaries becoming spaces. This is the
     * whole reason blockquoteText prefers `content` over `plainText`: the
     * stored plainText has already lost the paragraph separators.
     */
    private function textFromHtml(string $html): string
    {
        $spaced = preg_replace('#<br\s*/?>#i', ' ', $html) ?? $html;
        $spaced = preg_replace(
            '#</(?:p|div|li|blockquote|h[1-6]|tr|td|th|dd|dt|figcaption)\s*>#i',
            ' ',
            $spaced
        ) ?? $spaced;

        return $this->collapseWhitespace(
            html_entity_decode(strip_tags($spaced), ENT_QUOTES | ENT_HTML5, 'UTF-8')
        );
    }

    /**
     * Collapse every run of whitespace to one space. NBSP and friends are
     * listed explicitly — PCRE's `\s` does not match them without /u + UCP, and
     * OCR'd blocks are full of them.
     */
    private function collapseWhitespace(string $text): string
    {
        return trim(preg_replace('/[\s\x{00A0}\x{2007}\x{202F}]+/u', ' ', $text) ?? $text);
    }

    /**
     * A lifted figure/table caption, not a quotation. Upstream deliberately
     * emits these as blockquotes: ar5iv_preprocessor's lift_figures() wraps
     * every caption in <blockquote> for its browser styling, so an arXiv book's
     * captions would otherwise be claimed by any marker in the next paragraph.
     */
    private function looksLikeCaption(string $text): bool
    {
        return (bool) preg_match(
            '/^(?:fig(?:ure|\.)?|table|chart|plate|scheme|exhibit)\s*\.?\s*(?:\d+|[IVXLCDM]+)\b/iu',
            $text
        );
    }

    /**
     * A year or page reference — what makes a trailing group an ATTRIBUTION
     * rather than an ordinary aside. Same shape as the conversion pipeline's
     * `_QUOTE_CITE_YEARISH_RE` (app/Python/ingestion/pdf/assembly.py), which
     * decides the mirror-image question of what to wrap in a blockquote.
     */
    private const CITE_ISH_RE = '/\b(?:1[5-9]\d\d|20\d\d)[a-z]?\b|\bpp?\.\s*\d|\bibid\b|\bop\.\s*cit\b/iu';

    /**
     * Remove ONE trailing attribution — a bracket group or an em-dash credit.
     *
     * Two bounds, because two things can go wrong. A group that reads as a
     * citation (carries a year or a page number) is removed however much of the
     * block it is: `Citations only occur at the end of this cycle (Bollen, Van
     * de Sompel, & Rodriguez, 2008, p. 231)` is mostly citation by length, and
     * a proportional rule alone would keep it and lose the match. A group with
     * no such signal is an ordinary aside — `Value (understood here as socially
     * necessary labour time expended)` — and is removed only when it is a small
     * tail, so the quotation is not amputated.
     *
     * The dash form is deliberately narrow: it must follow whitespace or
     * sentence-ending punctuation (so `Anti-Federalists` is not split), lead
     * with a capital, and read as a citation. Without those guards a hyphenated
     * word at the end of a quote is taken for a credit line.
     */
    private function stripTrailingAttribution(string $text): string
    {
        $len = mb_strlen($text);
        if ($len === 0) {
            return $text;
        }

        // "(Qin, 2000, p. 166)" / "[emphasis added]", optionally punctuated.
        if (preg_match('/\s*[\(\[]([^()\[\]]{0,120})[\)\]][\s.,;:]*$/u', $text, $m)) {
            $tail = mb_strlen($m[0]);
            $citeIsh = (bool) preg_match(self::CITE_ISH_RE, $m[1]);
            if ($tail <= 120 && ($citeIsh || $tail <= $len * 0.25)) {
                return trim(mb_substr($text, 0, $len - $tail));
            }
        }

        // "—Franz Fanon, The Wretched of the Earth, 1963, p. 61"
        if (preg_match(
            '/(?<=[\s.!?)\]"\x{201D}\x{2019}])\s*[-\x{2010}-\x{2015}]\s*\p{Lu}[^\n]{4,120}$/u',
            $text,
            $m
        ) && preg_match(self::CITE_ISH_RE, $m[0])) {
            return trim(mb_substr($text, 0, $len - mb_strlen($m[0])));
        }

        return $text;
    }

    /**
     * Strip a matched pair of enclosing quote marks. Only a MATCHED pair — a
     * lone leading mark is left alone, since it may be the source's own.
     */
    private function stripEnclosingMarks(string $text): string
    {
        if (mb_strlen($text) < 3) {
            return $text;
        }
        $first = mb_substr($text, 0, 1);
        if (! isset(self::CLOSE_FOR[$first]) || mb_substr($text, -1) !== self::CLOSE_FOR[$first]) {
            return $text;
        }

        return trim(mb_substr($text, 1, mb_strlen($text) - 2));
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
