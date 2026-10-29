<?php

namespace App\Services\Annotations;

/**
 * The CLIENT-coordinate plain text of stored node HTML, and (for the MCP
 * tools) quote → charData anchor location against it.
 *
 * Why this exists as its own leaf: hyperlight/hypercite charData indexes the
 * browser's DOM textContent — tags gone, entities DECODED. Three things in
 * the codebase must agree on that definition byte for byte (the client's
 * calculateCleanTextOffset, CharDataRecalculator's re-anchoring, and the MCP
 * server's quote locator), so the definition lives once, here.
 * `nodes.plainText` is NOT this text — it is bare strip_tags with entities
 * still encoded (PgNode), and indexing into it anchors marks off-by-N on any
 * node containing &amp;, &nbsp; etc.
 */
class AnnotationAnchorService
{
    /** The client-coordinate plain text of stored node HTML. */
    public static function plainOf(?string $content): string
    {
        if ($content === null) {
            return '';
        }

        return html_entity_decode(strip_tags($content), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    /**
     * Locate a verbatim quote in a book's nodes and return the charData
     * anchor a hyperlight/hypercite stores.
     *
     * Matching is whitespace-TOLERANT (any run of whitespace/NBSP in the
     * quote matches any run in the text — read_book output, model retyping
     * and the stored text may disagree on newlines) but otherwise exact.
     * Nodes containing <latex> are unanchorable (KaTeX inflates the live
     * textContent, so offsets measured here would be wrong in the DOM) and
     * are excluded from the searchable text.
     *
     * Offsets are UTF-16 CODE UNITS: the client computes charData from DOM
     * Range lengths (JS string semantics), so astral-plane characters
     * (emoji, some CJK) count as 2. CharDataRecalculator tolerates small
     * drifts, but matching the client exactly means no drift at all.
     *
     * @param  array<int, array{node_id: string, startLine: mixed, content: ?string}>  $nodes  in reading order
     * @return array{node_ids: array<int, string>, charData: array<string, array{charStart: int, charEnd: int}>, startLine: mixed, highlightedText: string}
     *
     * @throws AnchorNotFoundException|AnchorAmbiguousException
     */
    public static function locate(array $nodes, string $quote, ?int $occurrence = null): array
    {
        $quote = trim($quote);
        if ($quote === '') {
            throw new AnchorNotFoundException('The quote is empty.');
        }

        // Concatenate node plains with "\n" separators, remembering where
        // each node starts (codepoint offsets into the concatenation).
        $doc = '';
        $spans = []; // [{node: original node, startCp, lenCp, plain}]
        foreach ($nodes as $node) {
            $content = $node['content'] ?? null;
            $plain = (is_string($content) && str_contains($content, '<latex'))
                ? '' // unanchorable — excluded, but keeps its boundary
                : self::plainOf($content);
            if ($doc !== '') {
                $doc .= "\n";
            }
            $spans[] = [
                'node' => $node,
                'startCp' => mb_strlen($doc, 'UTF-8'),
                'lenCp' => mb_strlen($plain, 'UTF-8'),
                'plain' => $plain,
            ];
            $doc .= $plain;
        }

        // Whitespace-tolerant pattern over the exact quote.
        $tokens = preg_split('/[\s\x{00A0}]+/u', $quote, -1, PREG_SPLIT_NO_EMPTY);
        if (! $tokens) {
            throw new AnchorNotFoundException('The quote is empty.');
        }
        $pattern = '/'.implode('[\s\x{00A0}]+', array_map(
            fn (string $t) => preg_quote($t, '/'),
            $tokens
        )).'/u';

        if (! preg_match_all($pattern, $doc, $m, PREG_OFFSET_CAPTURE)) {
            throw new AnchorNotFoundException(
                'The quote was not found in the book. Quote it VERBATIM from read_book output '
                .'(plain format), without ellipses or paraphrase.'
            );
        }

        $matches = $m[0]; // [[matchedText, byteOffset], …]

        if (count($matches) > 1 && $occurrence === null) {
            $contexts = [];
            foreach ($matches as $i => [$text, $byteOffset]) {
                $cp = mb_strlen(substr($doc, 0, $byteOffset), 'UTF-8');
                $before = mb_substr($doc, max(0, $cp - 40), min(40, $cp), 'UTF-8');
                $after = mb_substr($doc, $cp + mb_strlen($text, 'UTF-8'), 40, 'UTF-8');
                $contexts[] = '…'.str_replace("\n", ' ', $before.'['.$text.']'.$after).'…';
            }
            throw new AnchorAmbiguousException($contexts);
        }

        $index = ($occurrence ?? 1) - 1;
        if (! isset($matches[$index])) {
            throw new AnchorNotFoundException(
                'occurrence='.($occurrence ?? 1).' but the quote appears only '.count($matches).' time(s).'
            );
        }

        [$matchedText, $byteOffset] = $matches[$index];
        $startCp = mb_strlen(substr($doc, 0, $byteOffset), 'UTF-8');
        $endCp = $startCp + mb_strlen($matchedText, 'UTF-8'); // exclusive

        // Map the codepoint span onto the overlapped nodes.
        $nodeIds = [];
        $charData = [];
        $firstNode = null;
        foreach ($spans as $span) {
            $nodeStart = $span['startCp'];
            $nodeEnd = $nodeStart + $span['lenCp']; // exclusive
            if ($nodeEnd <= $startCp || $nodeStart >= $endCp || $span['lenCp'] === 0) {
                continue;
            }
            $localStart = max(0, $startCp - $nodeStart);
            $localEnd = min($span['lenCp'], $endCp - $nodeStart);
            $nodeId = (string) $span['node']['node_id'];
            $nodeIds[] = $nodeId;
            $charData[$nodeId] = [
                'charStart' => self::utf16Units($span['plain'], $localStart),
                'charEnd' => self::utf16Units($span['plain'], $localEnd),
            ];
            $firstNode ??= $span['node'];
        }

        if ($firstNode === null) {
            // The match landed entirely on separators/excluded nodes.
            throw new AnchorNotFoundException('The quote only matches inside non-anchorable (math) content.');
        }

        return [
            'node_ids' => $nodeIds,
            'charData' => $charData,
            'startLine' => $firstNode['startLine'] ?? null,
            'highlightedText' => $matchedText,
        ];
    }

    /** UTF-16 code units in the first $codepoints of $s (astral chars count 2). */
    private static function utf16Units(string $s, int $codepoints): int
    {
        if ($codepoints <= 0) {
            return 0;
        }
        $prefix = mb_substr($s, 0, $codepoints, 'UTF-8');
        $astral = preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $prefix);

        return $codepoints + (int) $astral;
    }
}
