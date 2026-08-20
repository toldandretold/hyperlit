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
     * @param string $plainText   the citing node's decoded plainText
     * @param int    $markerOffset char offset of the citation marker in $plainText
     * @param array{node_id:string, plainText:string, is_blockquote:bool} $node       the citing node
     * @param ?array{node_id:string, plainText:string, is_blockquote:bool} $prevNode
     * @param ?array{node_id:string, plainText:string, is_blockquote:bool} $nextNode
     * @return ?array{kind:string, text:string, node_id:string}
     */
    public function detect(string $plainText, int $markerOffset, array $node, ?array $prevNode, ?array $nextNode): ?array
    {
        $inline = $this->detectInline($plainText, $markerOffset);
        if ($inline !== null) {
            return ['kind' => 'inline', 'text' => $inline, 'node_id' => $node['node_id']];
        }

        // Blockquote attribution, nearest-first: the marker's own node, then ±1.
        if ($node['is_blockquote']) {
            return ['kind' => 'blockquote', 'text' => trim($plainText), 'node_id' => $node['node_id']];
        }

        // Marker in the first sentence of the node AFTER a blockquote → the
        // blockquote is the quote ("…quote…\n(Author 2020) argues that…" is rare;
        // the common shape is quote then attribution, so prev wins over next).
        if ($prevNode && $prevNode['is_blockquote'] && $this->inFirstSentence($plainText, $markerOffset)) {
            return ['kind' => 'blockquote', 'text' => trim($prevNode['plainText']), 'node_id' => $prevNode['node_id']];
        }

        if ($nextNode && $nextNode['is_blockquote'] && $this->inLastSentence($plainText, $markerOffset)) {
            return ['kind' => 'blockquote', 'text' => trim($nextNode['plainText']), 'node_id' => $nextNode['node_id']];
        }

        return null;
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
     * Nearest paired quoted span whose closing mark is within the configured
     * gap of the marker, at least the configured normalized length, and inside
     * the claim sentence. Returns the inner text (marks stripped) or null.
     */
    private function detectInline(string $plainText, int $markerOffset): ?string
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

        $best = null;      // [distance to marker, innerText]
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
            for ($j = $i + 1; $j < $n; $j++) {
                if ($chars[$j] !== $close) {
                    continue;
                }
                // An apostrophe inside a '-quoted span is a closer only at a word end.
                if ($close === "'" && $j + 1 < $n && preg_match('/[\p{L}\p{N}]/u', $chars[$j + 1])) {
                    continue;
                }
                $inner = implode('', array_slice($chars, $i + 1, $j - $i - 1));
                $normLen = mb_strlen(AnnotationReattachmentService::normalize($inner)['text']);
                if ($normLen >= $minChars) {
                    $closeAbs = $scanStart + $j;
                    $distance = abs($markerOffset - $closeAbs);
                    if ($distance <= $maxGap && ($best === null || $distance < $best[0])) {
                        $best = [$distance, trim($inner)];
                    }
                }
                break; // first closer ends this span; move to the next opener
            }
        }

        return $best[1] ?? null;
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
