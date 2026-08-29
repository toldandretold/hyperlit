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
     * Minimum normalized title length before the front-matter demotion applies.
     * A three-word title ("Peer Review 2027") occurs inside ordinary prose all
     * over its own article; demoting on that would rank the body LAST.
     */
    private const MIN_TITLE_CHARS = 25;

    /**
     * The single best location, in the shape callers have always consumed.
     * `occurrences` is the size of the full ranked list — >1 means the reviewer
     * has a choice to make, which is why it blocks auto-approve.
     *
     * @param array<int, object{node_id:string, plainText:?string, type?:?string}> $nodes ordered by startLine
     * @param bool $allowFuzzy false = exact/normalized evidence only. Used when
     *        DISAMBIGUATING competing readings of one quote (the apostrophe
     *        case in QuoteDetector): a fuzzy hit is not strong enough to
     *        choose between them, and it is the expensive stage.
     * @param ?string $citedTitle the cited work's title, for ranking — see rank()
     * @return ?array{
     *   node_ids: string[],
     *   char_data: array<string, array{charStart:int, charEnd:int}>,
     *   method: string,      // exact | normalized | fts_fuzzy
     *   score: float,
     *   occurrences: int
     * }
     */
    public function locate(array $nodes, string $quote, bool $allowFuzzy = true, ?string $citedTitle = null): ?array
    {
        $all = $this->locateAll($nodes, $quote, $allowFuzzy, $citedTitle);
        if ($all === []) {
            return null;
        }

        return $all[0] + ['occurrences' => count($all)];
    }

    /**
     * EVERY plausible location, ranked best-first — the list the console's
     * occurrence picker steps through.
     *
     * This exists because a quote that appears N times used to be reduced to
     * `occurrences => N` and one location: the console told the reviewer to
     * "check it's the right one" while showing the only one it had kept. The
     * discarded locations are what made that check impossible.
     *
     * @param array<int, object{node_id:string, plainText:?string, type?:?string}> $nodes ordered by startLine
     * @return list<array{node_ids:string[], char_data:array<string, array{charStart:int, charEnd:int}>, method:string, score:float}>
     */
    public function locateAll(array $nodes, string $quote, bool $allowFuzzy = true, ?string $citedTitle = null): array
    {
        $quote = trim($quote);
        if ($quote === '' || $nodes === []) {
            return [];
        }

        // ── Stage A: single-node exact/normalized. One hit per NODE — a quote
        // repeating inside one node counts once, which is what `occurrences`
        // has always meant. ──
        $hits = [];
        foreach ($nodes as $node) {
            $plain = $this->plainOf($node);
            if ($plain === '') {
                continue;
            }
            $found = Reattach::findInText($quote, $plain);
            if ($found !== null) {
                [$start, $end, $technique] = $found;
                $hits[] = [
                    'node_ids'  => [$node->node_id],
                    'char_data' => [$node->node_id => ['charStart' => $start, 'charEnd' => $end]],
                    'method'    => $technique === 'raw' ? 'exact' : 'normalized',
                    'score'     => $technique === 'raw' ? 1.0 : 0.95,
                ];
            }
        }
        if ($hits !== []) {
            return $this->rank($hits, $nodes, $citedTitle);
        }

        // ── Stage B: the quote straddles adjacent nodes. Deliberately still
        // first-only: a verbatim quote that spans a node boundary AND repeats
        // is vanishingly rare, and the nested start/size loops would emit
        // overlapping windows of different sizes at the same start. ──
        $straddle = $this->locateAcrossNodes($nodes, $quote);
        if ($straddle !== null) {
            return [$straddle];
        }

        // ── Stage C: fuzzy ──
        if (! $allowFuzzy) {
            return [];
        }

        return $this->rank($this->locateFuzzyAll($nodes, $quote), $nodes, $citedTitle);
    }

    /**
     * Order the locations so the BODY occurrence is the default.
     *
     * Locations arrive in document order, and in an open-access article that
     * makes location 0 wrong by construction: the earliest node carrying the
     * quote is the title block, not the prose. (Live case: a quote of "meaningful
     * and equitable" parked the reviewer on `Grieve, T., & Mitchell, R. (2020).
     * Promoting meaningful and equitable relationships? Exploring the UK's
     * Global Challenges Research Fund…` — the front matter — with the real
     * sentence eight occurrences away.)
     *
     * Demoting by `type` alone does not work: a Taylor & Francis capture has
     * `type` NULL on every node, and its front matter (title, author, "Pages
     * 891-901 | Received…", "Cite this article…doi", ABSTRACT, KEYWORDS) is
     * indistinguishable from body prose by type. What IS reliable is that a
     * front-matter node contains the work's own TITLE — which we already hold,
     * so this is a containment test against data in hand rather than a guess
     * about document structure. Running heads fall out of it for free.
     *
     * Order: least-demoted first, then strongest evidence, then document order.
     * Every demotion is overridable in one click, so a mis-rank costs a click.
     *
     * @param list<array{node_ids:string[], char_data:array, method:string, score:float}> $locations
     * @param array<int, object> $nodes
     * @return list<array{node_ids:string[], char_data:array, method:string, score:float}>
     */
    private function rank(array $locations, array $nodes, ?string $citedTitle): array
    {
        $nodeById = [];
        $orderOf = [];
        foreach ($nodes as $i => $node) {
            $nodeById[$node->node_id] = $node;
            $orderOf[$node->node_id] = $i;
        }

        $normTitle = $citedTitle !== null ? Reattach::normalize($citedTitle)['text'] : '';
        if (mb_strlen($normTitle) < self::MIN_TITLE_CHARS) {
            $normTitle = '';
        }

        $keyed = [];
        foreach ($locations as $i => $loc) {
            $nodeId = $loc['node_ids'][0] ?? '';
            $node = $nodeById[$nodeId] ?? null;

            $demote = 0;
            if ($normTitle !== '' && $node !== null) {
                $plain = Reattach::normalize($this->plainOf($node))['text'];
                if ($plain !== '' && str_contains($plain, $normTitle)) {
                    $demote += 4;
                }
            }
            if (preg_match('/^h[1-6]$/i', (string) ($node->type ?? ''))) {
                $demote += 2;
            }

            $keyed[] = ['loc' => $loc, 'demote' => $demote, 'order' => $orderOf[$nodeId] ?? $i];
        }

        usort($keyed, fn ($a, $b) => [$a['demote'], -$a['loc']['score'], $a['order']]
            <=> [$b['demote'], -$b['loc']['score'], $b['order']]);

        $max = (int) config('hypercites.max_match_locations', 12);

        return array_map(fn ($k) => $k['loc'], array_slice($keyed, 0, max(1, $max)));
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
                    'node_ids'  => $nodeIds,
                    'char_data' => $charData,
                    'method'    => 'normalized',
                    'score'     => 0.95,
                ];
            }
        }

        return null;
    }

    /**
     * Every fuzzy location, one per REGION rather than one per window.
     *
     * The sliding window steps by segLen/10, so a single real occurrence
     * produces ~10 heavily overlapping spans that all clear the threshold.
     * Emitting them raw would hand the reviewer ten copies of one location and
     * bury the genuinely distinct ones past the cap. Overlapping windows within
     * a node are therefore collapsed into one group, keeping the group's local
     * maximum — which is also the span the old single-best version returned.
     *
     * @return list<array{node_ids:string[], char_data:array, method:string, score:float}>
     */
    private function locateFuzzyAll(array $nodes, string $quote): array
    {
        $accept = (float) config('hypercites.fuzzy_accept', 0.85);
        $normSeg = Reattach::normalize($quote)['text'];
        $segLen = mb_strlen($normSeg);
        if ($segLen < 12) {
            return []; // too short to score reliably
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

        $out = [];
        foreach ($scored as $cand) {
            $text = $cand['norm']['text'];
            $textLen = mb_strlen($text);
            $step = max(1, (int) floor($segLen / 10));

            // Groups of overlapping accepted windows; `best` is the local max.
            $groups = [];
            for ($pos = 0; $pos + $segLen <= $textLen; $pos += $step) {
                similar_text($normSeg, mb_substr($text, $pos, $segLen), $pct);
                $ratio = $pct / 100;
                if ($ratio < $accept) {
                    continue;
                }
                $end = $pos + $segLen;
                $last = count($groups) - 1;
                if ($last >= 0 && $pos < $groups[$last]['end']) {
                    $groups[$last]['end'] = max($groups[$last]['end'], $end);
                    if ($ratio > $groups[$last]['ratio']) {
                        $groups[$last]['ratio'] = $ratio;
                        $groups[$last]['start'] = $pos;
                    }
                    continue;
                }
                $groups[] = ['start' => $pos, 'end' => $end, 'ratio' => $ratio];
            }

            $norm = $cand['norm'];
            foreach ($groups as $g) {
                $rawStart = $norm['map'][$g['start']];
                $rawEnd = $norm['map'][min($g['start'] + $segLen, count($norm['map'])) - 1] + 1;
                $out[] = [
                    'node_ids'  => [$cand['node']->node_id],
                    'char_data' => [$cand['node']->node_id => ['charStart' => $rawStart, 'charEnd' => $rawEnd]],
                    'method'    => 'fts_fuzzy',
                    'score'     => round($g['ratio'], 3),
                ];
            }
        }

        return $out;
    }
}
