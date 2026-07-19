<?php

namespace App\Services\Annotations;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Re-anchor a book's hyperlights + hypercites onto its NEW nodes after a
 * reconvert. Inputs: the annotation rows (which survive clearing, still
 * pointing at dead node ids) + annotation_snapshot.json (the OLD nodes'
 * text, written by AnnotationSnapshotService before the clear) + the new
 * nodes now in the DB.
 *
 * Two stages:
 *   1. OLD node → NEW node matching (exact normalized-text buckets, then
 *      windowed trigram-Jaccard fuzzy with order monotonicity),
 *   2. per-annotation segment location inside the matched node (raw find →
 *      normalized find → global search → adjacent-node concat fallback),
 *      recomputing charStart/charEnd against the NEW plainText.
 *
 * Everything unmatchable is KEPT and stamped raw_json.reattach.status =
 * 'orphaned' — a dead pointer renders as nothing (hydration finds no node),
 * and a better matcher can retry from the .used.json snapshot later. Rows
 * are never deleted here.
 *
 * All writes go through the query builder on pgsql_admin: queue workers have
 * no RLS session, and PgHyperlight's raw_json has no array cast (its model
 * comment warns to json_encode by hand) — the builder + explicit encoding
 * sidesteps both.
 *
 * Offsets are CHARACTER offsets (mb_*), matching the client's use of JS
 * string indices against node textContent.
 */
class AnnotationReattachmentService
{
    // Stage-1 fuzzy-match tuning — revisit against real pulled prod cases.
    private const FUZZY_WINDOW = 25;        // candidate new nodes each side of expected rank
    private const FUZZY_ACCEPT = 0.6;       // min trigram Jaccard
    private const FUZZY_MARGIN = 0.1;       // best must beat runner-up by this
    private const FUZZY_HEAD_TAIL = 300;    // long nodes compared on first+last N normalized chars

    // Stage-2 segment location.
    private const GLOBAL_MIN_CHARS = 12;    // shorter segments only search near the expected rank
    private const NEAR_WINDOW = 3;
    private const CONCAT_MAX_NODES = 4;     // split/merge fallback window

    /**
     * @return array report: {skipped?|total, reattached, orphaned, methods{}}
     */
    public function reattach(string $bookId): array
    {
        $snapshotPath = AnnotationSnapshotService::pathFor($bookId);
        if (!$snapshotPath) {
            return ['skipped' => 'no snapshot'];
        }

        $snapshot = json_decode((string) File::get($snapshotPath), true) ?: [];
        $oldNodes = array_values($snapshot['nodes'] ?? []);
        $oldTextById = [];
        $oldIndexById = [];
        foreach ($oldNodes as $i => $n) {
            $oldTextById[$n['node_id']] = (string) $n['plainText'];
            $oldIndexById[$n['node_id']] = $i;
        }

        $db = DB::connection('pgsql_admin');
        $newRows = $db->table('nodes')->where('book', $bookId)
            ->orderBy('startLine')->get(['node_id', 'startLine', 'plainText']);
        $newNodes = [];
        $newIndexById = [];
        foreach ($newRows as $i => $n) {
            $newNodes[$i] = [
                'node_id'   => $n->node_id,
                'startLine' => (float) $n->startLine,
                'plainText' => (string) ($n->plainText ?? ''),
            ];
            $newIndexById[$n->node_id] = $i;
        }

        $report = ['total' => 0, 'reattached' => 0, 'orphaned' => 0, 'methods' => [], 'per_id' => []];

        $tableSpecs = [
            ['table' => 'hyperlights', 'idCol' => 'hyperlight_id', 'textCol' => 'highlightedText'],
            ['table' => 'hypercites',  'idCol' => 'hyperciteId',   'textCol' => 'hypercitedText'],
        ];

        // Stage 1 runs ONCE over the union of every row's referenced old nodes:
        // the order-preserving bucket consumption (duplicate-paragraph
        // disambiguation) only works with a single shared consumed-set.
        $rowsByTable = [];
        $referencedOldIds = [];
        foreach ($tableSpecs as $spec) {
            $rows = $db->table($spec['table'])->where('book', $bookId)->get();
            $rowsByTable[$spec['table']] = $rows;
            foreach ($rows as $row) {
                foreach (json_decode((string) $row->node_id, true) ?: [] as $id) {
                    $referencedOldIds[$id] = true;
                }
            }
        }
        $nodeMatch = self::matchNodes(
            array_keys($referencedOldIds),
            $oldTextById, $oldIndexById, count($oldNodes), $newNodes,
        );

        foreach ($tableSpecs as $spec) {
            $rows = $rowsByTable[$spec['table']];
            if ($rows->isEmpty()) {
                continue;
            }

            foreach ($rows as $row) {
                $report['total']++;
                $publicId = $row->{$spec['idCol']};

                $nodeIds = json_decode((string) $row->node_id, true) ?: [];
                $charData = json_decode((string) $row->charData, true) ?: [];
                $fallback = (string) ($row->{$spec['textCol']} ?? '');

                $result = $this->reanchorRow(
                    $nodeIds, $charData, $fallback,
                    $oldTextById, $oldIndexById, count($oldNodes),
                    $newNodes, $nodeMatch,
                );

                if ($result !== null) {
                    $update = [
                        'node_id'  => json_encode($result['node_id']),
                        'charData' => json_encode($result['charData']),
                        'raw_json' => $this->stampRawJson($row->raw_json, [
                            'status'        => 'reattached',
                            'method'        => $result['method'],
                            'at'            => now()->toIso8601String(),
                            'from_node_ids' => $nodeIds,
                        ]),
                    ];
                    // hyperlights carry a legacy startLine column; hypercites don't.
                    if (property_exists($row, 'startLine')) {
                        $update['startLine'] = (string) $result['startLine'];
                    }
                    $db->table($spec['table'])->where('id', $row->id)->update($update);
                    $report['reattached']++;
                    $report['methods'][$result['method']] = ($report['methods'][$result['method']] ?? 0) + 1;
                    $report['per_id'][$publicId] = $result['method'];
                } else {
                    $db->table($spec['table'])->where('id', $row->id)->update([
                        'raw_json' => $this->stampRawJson($row->raw_json, [
                            'status' => 'orphaned',
                            'at'     => now()->toIso8601String(),
                            'reason' => 'segments not found in reconverted text',
                        ]),
                    ]);
                    $report['orphaned']++;
                    $report['per_id'][$publicId] = 'orphaned';
                }
            }
        }

        AnnotationSnapshotService::markUsed($bookId);

        $dir = resource_path("markdown/{$bookId}");
        if (is_dir($dir)) {
            File::put("{$dir}/reattach_report.json", json_encode($report, JSON_PRETTY_PRINT));
        }
        Log::info('Annotation reattachment complete', ['book' => $bookId] + array_diff_key($report, ['per_id' => 0]));

        return $report;
    }

    // ── Stage 2: one annotation row ────────────────────────────────────────

    /**
     * @return ?array{node_id: string[], charData: array, startLine: float, method: string}
     */
    private function reanchorRow(
        array $nodeIds,
        array $charData,
        string $fallbackText,
        array $oldTextById,
        array $oldIndexById,
        int $oldCount,
        array $newNodes,
        array $nodeMatch,
    ): ?array {
        if ($nodeIds === [] || $newNodes === []) {
            return null;
        }

        // Ghost hypercites anchor at {-1,-1} in every node — remap ids only.
        $isGhost = $charData !== [] && collect($charData)->every(
            fn ($cd) => (int) ($cd['charStart'] ?? 0) === -1,
        );

        if ($isGhost) {
            $newIds = [];
            foreach ($nodeIds as $oldId) {
                if (!isset($nodeMatch[$oldId])) {
                    return null;
                }
                $newIds[] = $newNodes[$nodeMatch[$oldId]]['node_id'];
            }
            return [
                'node_id'   => $newIds,
                'charData'  => array_fill_keys($newIds, ['charStart' => -1, 'charEnd' => -1]),
                'startLine' => $newNodes[$nodeMatch[$nodeIds[0]]]['startLine'],
                'method'    => 'ghost',
            ];
        }

        // Locate each anchored segment.
        $located = []; // list of [newIndex, start, end]
        $method = 'exact';
        foreach ($nodeIds as $oldId) {
            $cd = $charData[$oldId] ?? null;
            $oldText = $oldTextById[$oldId] ?? null;

            $segment = null;
            $oldStart = 0;
            if ($cd !== null && $oldText !== null) {
                $oldStart = max(0, (int) $cd['charStart']);
                $segment = mb_substr($oldText, $oldStart, max(0, (int) $cd['charEnd'] - $oldStart));
            }
            if ($segment === null || $segment === '') {
                // Snapshot missing this node (legacy data): single-node rows can
                // fall back to the full selected text; multi-node rows go to concat.
                if (count($nodeIds) === 1 && $fallbackText !== '') {
                    $segment = $fallbackText;
                } else {
                    $located = [];
                    break;
                }
            }

            $hit = $this->locateSegment(
                $segment, $oldId, $oldStart,
                $nodeMatch, $oldIndexById, $oldCount, $newNodes, $method,
            );
            if ($hit === null) {
                $located = [];
                break;
            }
            $located[] = $hit;
        }

        // Concat fallback: the selection as a whole against adjacent new nodes.
        if ($located === [] && $fallbackText !== '') {
            $located = $this->locateAcrossNodes($fallbackText, $nodeIds, $nodeMatch, $oldIndexById, $oldCount, $newNodes);
            $method = 'concat';
        }
        if ($located === []) {
            return null;
        }

        // Merge per new node (a multi-node highlight can land in fewer nodes).
        usort($located, fn ($a, $b) => [$a[0], $a[1]] <=> [$b[0], $b[1]]);
        $byNode = [];
        foreach ($located as [$idx, $start, $end]) {
            $id = $newNodes[$idx]['node_id'];
            if (!isset($byNode[$id])) {
                $byNode[$id] = ['charStart' => $start, 'charEnd' => $end];
            } else {
                $byNode[$id]['charStart'] = min($byNode[$id]['charStart'], $start);
                $byNode[$id]['charEnd'] = max($byNode[$id]['charEnd'], $end);
            }
        }

        return [
            'node_id'   => array_keys($byNode),
            'charData'  => $byNode,
            'startLine' => $newNodes[$located[0][0]]['startLine'],
            'method'    => $method,
        ];
    }

    /**
     * Find one segment. Prefers the Stage-1-matched node; falls back to a
     * search ordered by distance from the expected position. Sets $method to
     * the weakest technique used ('exact' → 'fuzzy').
     *
     * @return ?array{0:int,1:int,2:int} [newIndex, charStart, charEnd]
     */
    private function locateSegment(
        string $segment,
        string $oldId,
        int $oldStart,
        array $nodeMatch,
        array $oldIndexById,
        int $oldCount,
        array $newNodes,
        string &$method,
    ): ?array {
        // (a) Inside the matched node.
        if (isset($nodeMatch[$oldId])) {
            $idx = $nodeMatch[$oldId];
            $hit = $this->findInText($segment, $newNodes[$idx]['plainText'], $oldStart);
            if ($hit !== null) {
                if ($hit[2] === 'normalized') {
                    $method = 'fuzzy';
                }
                return [$idx, $hit[0], $hit[1]];
            }
        }

        // (b) Search outward from the expected position.
        $expected = $this->expectedRank($oldId, $oldIndexById, $oldCount, count($newNodes), $nodeMatch);
        $normLen = mb_strlen(self::normalize($segment)['text']);
        $reach = $normLen >= self::GLOBAL_MIN_CHARS ? count($newNodes) : self::NEAR_WINDOW;

        $order = array_keys($newNodes);
        usort($order, fn ($a, $b) => abs($a - $expected) <=> abs($b - $expected));
        foreach ($order as $idx) {
            if (abs($idx - $expected) > $reach) {
                break;
            }
            $hit = $this->findInText($segment, $newNodes[$idx]['plainText'], $oldStart);
            if ($hit !== null) {
                $method = 'fuzzy';
                return [$idx, $hit[0], $hit[1]];
            }
        }

        return null;
    }

    /**
     * The split/merge fallback: locate the WHOLE selection in a sliding
     * concatenation of up to CONCAT_MAX_NODES adjacent new nodes, then carve
     * per-node segments out of the match span.
     *
     * @return array list of [newIndex, charStart, charEnd] (empty on failure)
     */
    private function locateAcrossNodes(
        string $selection,
        array $nodeIds,
        array $nodeMatch,
        array $oldIndexById,
        int $oldCount,
        array $newNodes,
    ): array {
        $normSel = self::normalize($selection)['text'];
        if ($normSel === '') {
            return [];
        }

        $expected = $this->expectedRank($nodeIds[0], $oldIndexById, $oldCount, count($newNodes), $nodeMatch);
        $starts = array_keys($newNodes);
        usort($starts, fn ($a, $b) => abs($a - $expected) <=> abs($b - $expected));

        foreach ($starts as $first) {
            for ($span = 1; $span <= self::CONCAT_MAX_NODES; $span++) {
                $last = $first + $span - 1;
                if (!isset($newNodes[$last])) {
                    break;
                }

                // Concat normalized node texts with a single space between,
                // tracking each node's normalized range + raw offset map.
                $parts = [];
                $concat = '';
                for ($i = $first; $i <= $last; $i++) {
                    $n = self::normalize($newNodes[$i]['plainText']);
                    if ($concat !== '' && $n['text'] !== '') {
                        $concat .= ' ';
                    }
                    $parts[] = ['idx' => $i, 'from' => mb_strlen($concat), 'norm' => $n];
                    $concat .= $n['text'];
                }

                $pos = mb_strpos($concat, $normSel);
                if ($pos === false) {
                    continue;
                }
                $endPos = $pos + mb_strlen($normSel); // exclusive, normalized-concat space

                $out = [];
                foreach ($parts as $part) {
                    $len = mb_strlen($part['norm']['text']);
                    if ($len === 0) {
                        continue;
                    }
                    $nodeFrom = $part['from'];
                    $nodeTo = $nodeFrom + $len; // exclusive
                    $s = max($pos, $nodeFrom);
                    $e = min($endPos, $nodeTo);
                    if ($s >= $e) {
                        continue; // node not covered by the match
                    }
                    $map = $part['norm']['map'];
                    $rawStart = $map[$s - $nodeFrom];
                    $rawEnd = $map[$e - $nodeFrom - 1] + 1;
                    $out[] = [$part['idx'], $rawStart, $rawEnd];
                }
                if ($out !== []) {
                    return $out;
                }
            }
        }

        return [];
    }

    /** Interpolated "where should this old node be among the new nodes". */
    private function expectedRank(string $oldId, array $oldIndexById, int $oldCount, int $newCount, array $nodeMatch): int
    {
        // If the node itself matched, that IS the position.
        if (isset($nodeMatch[$oldId])) {
            return $nodeMatch[$oldId];
        }
        $oldIdx = $oldIndexById[$oldId] ?? 0;

        return $oldCount > 0 ? (int) round($oldIdx / max(1, $oldCount) * $newCount) : 0;
    }

    // ── Stage 1: node matching (pure; public static for unit tests) ────────

    /**
     * Match referenced OLD node ids to NEW node indices. Exact normalized
     * buckets first (order-consuming, handles duplicate paragraphs), then
     * windowed trigram fuzzy with monotonic order enforcement.
     *
     * @param string[] $oldIds referenced old node ids (any order)
     * @return array<string,int> oldId => new node index
     */
    public static function matchNodes(
        array $oldIds,
        array $oldTextById,
        array $oldIndexById,
        int $oldCount,
        array $newNodes,
    ): array {
        // Order the referenced ids by old document position.
        usort($oldIds, fn ($a, $b) => ($oldIndexById[$a] ?? 0) <=> ($oldIndexById[$b] ?? 0));

        $newNorm = [];
        $buckets = [];
        foreach ($newNodes as $i => $n) {
            $t = self::normalize($n['plainText'])['text'];
            $newNorm[$i] = $t;
            $buckets[$t][] = $i;
        }

        $consumed = [];
        $match = [];

        // Pass 1 — exact normalized text.
        foreach ($oldIds as $oldId) {
            $text = $oldTextById[$oldId] ?? null;
            if ($text === null) {
                continue;
            }
            $norm = self::normalize($text)['text'];
            foreach ($buckets[$norm] ?? [] as $i) {
                if (!isset($consumed[$i])) {
                    $match[$oldId] = $i;
                    $consumed[$i] = true;
                    break;
                }
            }
        }

        // Pass 2 — windowed fuzzy for the rest, monotonic w.r.t. accepted pairs.
        foreach ($oldIds as $oldId) {
            if (isset($match[$oldId]) || !isset($oldTextById[$oldId])) {
                continue;
            }
            $oldIdx = $oldIndexById[$oldId] ?? 0;

            // Bounds from accepted neighbours (old-index order).
            $lo = -1;
            $hi = count($newNodes);
            $loOld = -1;
            $hiOld = $oldCount;
            foreach ($match as $mOldId => $mNewIdx) {
                $mOldIdx = $oldIndexById[$mOldId] ?? 0;
                if ($mOldIdx < $oldIdx && $mOldIdx > $loOld) {
                    $loOld = $mOldIdx;
                    $lo = $mNewIdx;
                }
                if ($mOldIdx > $oldIdx && $mOldIdx < $hiOld) {
                    $hiOld = $mOldIdx;
                    $hi = $mNewIdx;
                }
            }
            $expected = ($lo >= 0 && $hi < count($newNodes))
                ? (int) round($lo + ($hi - $lo) * (($oldIdx - $loOld) / max(1, $hiOld - $loOld)))
                : (int) round($oldIdx / max(1, $oldCount) * count($newNodes));

            $oldSig = self::headTail(self::normalize($oldTextById[$oldId])['text']);
            $oldGrams = self::trigrams($oldSig);
            if ($oldGrams === []) {
                continue;
            }

            $best = null;
            $bestScore = 0.0;
            $second = 0.0;
            for ($i = max(0, $expected - self::FUZZY_WINDOW); $i <= min(count($newNodes) - 1, $expected + self::FUZZY_WINDOW); $i++) {
                if (isset($consumed[$i]) || $i <= $lo || $i >= $hi) {
                    continue; // consumed or would invert order
                }
                $score = self::jaccard($oldGrams, self::trigrams(self::headTail($newNorm[$i])));
                if ($score > $bestScore) {
                    $second = $bestScore;
                    $bestScore = $score;
                    $best = $i;
                } elseif ($score > $second) {
                    $second = $score;
                }
            }

            if ($best !== null && $bestScore >= self::FUZZY_ACCEPT && ($bestScore - $second) >= self::FUZZY_MARGIN) {
                $match[$oldId] = $best;
                $consumed[$best] = true;
            }
        }

        return $match;
    }

    // ── Text primitives (pure; public static for unit tests) ───────────────

    /**
     * Normalize text for matching, with an offset map back to RAW character
     * indices: map[i] = raw index of the char that produced normalized char i.
     * Handles: zero-widths, ↗, superscript digits, [N] footnote markers,
     * curly quotes/dashes, whitespace collapse, lowercase.
     *
     * @return array{text:string, map:int[]}
     */
    public static function normalize(string $raw): array
    {
        $chars = mb_str_split($raw);
        $out = '';
        $map = [];
        $n = count($chars);

        $skip = ["\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}", "\u{2060}", "\u{2197}",
            "\u{00B9}", "\u{00B2}", "\u{00B3}", "\u{2070}", "\u{2074}", "\u{2075}",
            "\u{2076}", "\u{2077}", "\u{2078}", "\u{2079}"];
        $mapChars = [
            "\u{2018}" => "'", "\u{2019}" => "'", "\u{201C}" => '"', "\u{201D}" => '"',
            "\u{2013}" => '-', "\u{2014}" => '-', "\u{00A0}" => ' ',
        ];

        for ($i = 0; $i < $n; $i++) {
            $c = $chars[$i];

            if (in_array($c, $skip, true)) {
                continue;
            }

            // [N] footnote marker (1–3 digits) — skip the whole group.
            if ($c === '[') {
                $j = $i + 1;
                $digits = 0;
                while ($j < $n && $digits < 3 && ctype_digit($chars[$j])) {
                    $j++;
                    $digits++;
                }
                if ($digits > 0 && $j < $n && $chars[$j] === ']') {
                    $i = $j;
                    continue;
                }
            }

            if (isset($mapChars[$c])) {
                $c = $mapChars[$c];
            }

            if (preg_match('/\s/u', $c)) {
                if ($out === '' || mb_substr($out, -1) === ' ') {
                    continue; // collapse runs; drop leading space
                }
                $out .= ' ';
                $map[] = $i;
                continue;
            }

            $lower = mb_strtolower($c);
            foreach (mb_str_split($lower) as $lc) {
                $out .= $lc;
                $map[] = $i;
            }
        }

        // Trim a trailing space.
        if ($out !== '' && mb_substr($out, -1) === ' ') {
            $out = mb_substr($out, 0, -1);
            array_pop($map);
        }

        return ['text' => $out, 'map' => $map];
    }

    /** @return array<string,true> character-trigram set */
    public static function trigrams(string $s): array
    {
        $grams = [];
        $len = mb_strlen($s);
        for ($i = 0; $i + 3 <= $len; $i++) {
            $grams[mb_substr($s, $i, 3)] = true;
        }

        return $grams;
    }

    public static function jaccard(array $a, array $b): float
    {
        if ($a === [] || $b === []) {
            return 0.0;
        }
        $inter = count(array_intersect_key($a, $b));

        return $inter / (count($a) + count($b) - $inter);
    }

    /** Long texts compare on first+last chunk (order-of-magnitude speedup). */
    private static function headTail(string $s): string
    {
        $n = self::FUZZY_HEAD_TAIL;

        return mb_strlen($s) <= 2 * $n
            ? $s
            : mb_substr($s, 0, $n) . mb_substr($s, -$n);
    }

    /**
     * Find a segment in a node's plainText: raw first (occurrence nearest the
     * old offset), then normalized-with-offset-map. Returns raw char range +
     * which technique hit.
     *
     * @return ?array{0:int,1:int,2:string} [charStart, charEnd, 'raw'|'normalized']
     */
    public static function findInText(string $segment, string $text, int $nearOffset = 0): ?array
    {
        if ($segment === '' || $text === '') {
            return null;
        }

        // Raw: all occurrences, choose nearest the old position.
        $positions = [];
        $offset = 0;
        while (($pos = mb_strpos($text, $segment, $offset)) !== false) {
            $positions[] = $pos;
            $offset = $pos + 1;
            if (count($positions) > 50) {
                break; // degenerate repetition guard
            }
        }
        if ($positions !== []) {
            usort($positions, fn ($a, $b) => abs($a - $nearOffset) <=> abs($b - $nearOffset));

            return [$positions[0], $positions[0] + mb_strlen($segment), 'raw'];
        }

        // Normalized: tolerate footnote-marker/quote/whitespace drift.
        $normSeg = self::normalize($segment)['text'];
        if ($normSeg === '') {
            return null;
        }
        $normText = self::normalize($text);
        $pos = mb_strpos($normText['text'], $normSeg);
        if ($pos === false) {
            return null;
        }
        $rawStart = $normText['map'][$pos];
        $rawEnd = $normText['map'][$pos + mb_strlen($normSeg) - 1] + 1;

        return [$rawStart, $rawEnd, 'normalized'];
    }

    /** Merge the reattach stamp into raw_json (stored as a jsonb string). */
    private function stampRawJson($rawJson, array $stamp): string
    {
        $data = is_string($rawJson) ? (json_decode($rawJson, true) ?: []) : (array) ($rawJson ?? []);
        $data['reattach'] = $stamp;

        return json_encode($data);
    }
}
