<?php

namespace App\Services\Hypercites;

use App\Services\Annotations\AnnotationReattachmentService as Reattach;

/**
 * Locate a quote inside the CITED book's nodes and return it in the exact
 * shape `hypercites.charData` stores: ordered node ids + per-node
 * {charStart, charEnd} in plainText coordinates.
 *
 * Pure: operates on an array of node rows the caller fetched (node_id,
 * plainText, ordered by startLine) — no DB, so unit tests feed strings.
 *
 * Three stages, strongest first:
 *  A. Per-node exact / normalized match via Reattach::findInText (offset-map
 *     normalization tolerates curly-quote, dash, whitespace and footnote-marker
 *     drift while still returning RAW offsets). Occurrences are counted across
 *     the whole book — >1 makes the match ambiguous, which blocks auto-approve.
 *  B. Cross-node window: the quote straddles a node boundary (an OCR paragraph
 *     split). Adjacent nodes' normalized texts are joined and searched; a hit
 *     is split back into per-node raw ranges via the offset maps.
 *  C. Fuzzy: trigram-Jaccard shortlist of candidate nodes, then a sliding
 *     normalized window scored with similar_text; accepted at the configured
 *     ratio. Catches OCR noise / elided words the exact stages can't.
 */
class QuoteLocator
{
    private const MAX_WINDOW_NODES = 4;
    private const FUZZY_SHORTLIST = 5;

    /**
     * @param array<int, object{node_id:string, plainText:?string}> $nodes ordered by startLine
     * @param bool $allowFuzzy false = exact/normalized evidence only. Used when
     *        DISAMBIGUATING competing readings of one quote (the apostrophe
     *        case in QuoteDetector): a fuzzy hit is not strong enough to
     *        choose between them, and it is the expensive stage.
     * @return ?array{
     *   node_ids: string[],
     *   char_data: array<string, array{charStart:int, charEnd:int}>,
     *   method: string,      // exact | normalized | fts_fuzzy
     *   score: float,
     *   occurrences: int
     * }
     */
    public function locate(array $nodes, string $quote, bool $allowFuzzy = true): ?array
    {
        $quote = trim($quote);
        if ($quote === '' || $nodes === []) {
            return null;
        }

        // ── Stage A: single-node exact/normalized, all occurrences counted ──
        $hits = [];
        foreach ($nodes as $node) {
            $plain = $this->plainOf($node);
            if ($plain === '') {
                continue;
            }
            $found = Reattach::findInText($quote, $plain);
            if ($found !== null) {
                $hits[] = ['node' => $node, 'range' => $found];
            }
        }
        if ($hits !== []) {
            $best = $hits[0];
            [$start, $end, $technique] = $best['range'];

            return [
                'node_ids'    => [$best['node']->node_id],
                'char_data'   => [$best['node']->node_id => ['charStart' => $start, 'charEnd' => $end]],
                'method'      => $technique === 'raw' ? 'exact' : 'normalized',
                'score'       => $technique === 'raw' ? 1.0 : 0.95,
                'occurrences' => count($hits),
            ];
        }

        // ── Stage B: the quote straddles adjacent nodes ──
        $straddle = $this->locateAcrossNodes($nodes, $quote);
        if ($straddle !== null) {
            return $straddle;
        }

        // ── Stage C: fuzzy ──
        return $allowFuzzy ? $this->locateFuzzy($nodes, $quote) : null;
    }

    /** @param object $node */
    private function plainOf($node): string
    {
        return html_entity_decode((string) ($node->plainText ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    private function locateAcrossNodes(array $nodes, string $quote): ?array
    {
        $normSeg = Reattach::normalize($quote)['text'];
        if ($normSeg === '') {
            return null;
        }

        $count = count($nodes);
        $norms = [];
        $getNorm = function (int $i) use (&$norms, $nodes) {
            return $norms[$i] ??= Reattach::normalize($this->plainOf($nodes[$i]));
        };

        for ($start = 0; $start < $count - 1; $start++) {
            for ($size = 2; $size <= self::MAX_WINDOW_NODES && $start + $size <= $count; $size++) {
                // Join normalized texts with one space; per normalized char keep
                // (node index, raw offset) so a hit maps back per node.
                $joined = '';
                $charMap = []; // [nodeIdx, rawOffset] per normalized char of $joined
                for ($k = $start; $k < $start + $size; $k++) {
                    $norm = $getNorm($k);
                    if ($norm['text'] === '') {
                        continue;
                    }
                    if ($joined !== '') {
                        $joined .= ' ';
                        $charMap[] = null; // separator maps to nothing
                    }
                    foreach (mb_str_split($norm['text']) as $ci => $c) {
                        $charMap[] = [$k, $norm['map'][$ci]];
                    }
                    $joined .= $norm['text'];
                }
                if ($joined === '') {
                    continue;
                }

                $pos = mb_strpos($joined, $normSeg);
                if ($pos === false) {
                    continue;
                }
                // Must actually straddle: single-node hits were stage A's job.
                $spanEntries = array_slice($charMap, $pos, mb_strlen($normSeg));
                $spanEntries = array_values(array_filter($spanEntries));
                $nodeIdxs = array_values(array_unique(array_map(fn ($e) => $e[0], $spanEntries)));
                if (count($nodeIdxs) < 2) {
                    continue;
                }

                $charData = [];
                $nodeIds = [];
                foreach ($nodeIdxs as $idx) {
                    $offsets = array_map(fn ($e) => $e[1], array_filter($spanEntries, fn ($e) => $e[0] === $idx));
                    $nodeId = $nodes[$idx]->node_id;
                    $nodeIds[] = $nodeId;
                    $charData[$nodeId] = [
                        'charStart' => min($offsets),
                        'charEnd'   => max($offsets) + 1,
                    ];
                }

                return [
                    'node_ids'    => $nodeIds,
                    'char_data'   => $charData,
                    'method'      => 'normalized',
                    'score'       => 0.95,
                    'occurrences' => 1,
                ];
            }
        }

        return null;
    }

    private function locateFuzzy(array $nodes, string $quote): ?array
    {
        $accept = (float) config('hypercites.fuzzy_accept', 0.85);
        $normSeg = Reattach::normalize($quote)['text'];
        $segLen = mb_strlen($normSeg);
        if ($segLen < 12) {
            return null; // too short to score reliably
        }
        $segGrams = Reattach::trigrams($normSeg);

        // Shortlist by trigram overlap (pure PHP — a book is a few hundred nodes).
        $scored = [];
        foreach ($nodes as $node) {
            $norm = Reattach::normalize($this->plainOf($node));
            if (mb_strlen($norm['text']) < $segLen / 2) {
                continue;
            }
            $j = Reattach::jaccard($segGrams, Reattach::trigrams($norm['text']));
            if ($j > 0) {
                $scored[] = ['node' => $node, 'norm' => $norm, 'jaccard' => $j];
            }
        }
        usort($scored, fn ($a, $b) => $b['jaccard'] <=> $a['jaccard']);
        $scored = array_slice($scored, 0, self::FUZZY_SHORTLIST);

        $best = null; // [ratio, node, normStart, normEnd, norm]
        foreach ($scored as $cand) {
            $text = $cand['norm']['text'];
            $textLen = mb_strlen($text);
            $step = max(1, (int) floor($segLen / 10));
            for ($pos = 0; $pos + $segLen <= $textLen; $pos += $step) {
                $window = mb_substr($text, $pos, $segLen);
                similar_text($normSeg, $window, $pct);
                $ratio = $pct / 100;
                if ($ratio >= $accept && ($best === null || $ratio > $best[0])) {
                    $best = [$ratio, $cand['node'], $pos, $pos + $segLen, $cand['norm']];
                }
            }
        }
        if ($best === null) {
            return null;
        }

        [$ratio, $node, $normStart, $normEnd, $norm] = $best;
        $rawStart = $norm['map'][$normStart];
        $rawEnd = $norm['map'][min($normEnd, count($norm['map'])) - 1] + 1;

        return [
            'node_ids'    => [$node->node_id],
            'char_data'   => [$node->node_id => ['charStart' => $rawStart, 'charEnd' => $rawEnd]],
            'method'      => 'fts_fuzzy',
            'score'       => round($ratio, 3),
            'occurrences' => 1,
        ];
    }
}
