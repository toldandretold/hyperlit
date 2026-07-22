<?php

namespace App\Services\Annotations;

use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Save-time reconciliation of hyperlight/hypercite charData against node content.
 *
 * A highlight/cite record stores per-node character ranges (charData). When a node's
 * text is edited so a range becomes impossible, the CLIENT cannot clean it up: the
 * mark being absent from the DOM is ambiguous there (gate filters, hidden anon
 * highlights, "show highlights" toggles, foreign-singles filtering all legitimately
 * hide marks). The SERVER has no such ambiguity — at write time it holds the node's
 * new content and every annotation claiming positions in it, unfiltered.
 *
 * SEAM: pruneIncomingItem() — before hyperlight/hypercite upserts persist a
 * payload, strip entries that are PROVABLY impossible against stored node text
 * (charStart >= text length), so a stale client re-syncing its un-pruned copy
 * can't re-introduce dead ranges. Rules (conservative — a wrong deletion is
 * worse than a stale pointer): never below one remaining entry; <latex> nodes,
 * unknown nodes and E2EE books are never judged.
 *
 * The STORED-side reconciliation lives in CharDataRecalculator (full
 * relocation + -1/-1 tombstoning at node-save time) — it superseded this
 * class's original pruneStoredForNodes.
 */
class StaleCharDataPruner
{
    /**
     * Strip provably-impossible entries from an incoming hyperlight/hypercite
     * payload item before it is persisted. Returns the (possibly modified) item.
     *
     * @param  array<string,mixed>  $item
     * @return array<string,mixed>
     */
    public static function pruneIncomingItem(string $book, array $item): array
    {
        if (EncryptedBookGuard::isEncrypted($book)) {
            return $item;
        }

        $nodeIdArr = is_array($item['node_id'] ?? null)
            ? $item['node_id']
            : (json_decode($item['node_id'] ?? '[]', true) ?: []);
        $charData = is_array($item['charData'] ?? null) ? $item['charData'] : [];
        if (count($nodeIdArr) < 2) {
            return $item; // never prune to zero — a single-entry record is left alone
        }

        $lengths = self::nodeTextLengths($book, $nodeIdArr);
        $stale = self::staleEntryIds($nodeIdArr, $charData, $lengths);
        if (empty($stale) || count($nodeIdArr) - count($stale) < 1) {
            return $item;
        }

        $item['node_id'] = array_values(array_diff($nodeIdArr, $stale));
        foreach ($stale as $nid) {
            unset($charData[$nid]);
        }
        $item['charData'] = $charData;

        Log::info('StaleCharDataPruner: stripped impossible entries from incoming annotation', [
            'book' => $book,
            'id' => $item['hyperlight_id'] ?? $item['hyperciteId'] ?? null,
            'pruned_nodes' => $stale,
        ]);

        return $item;
    }

    /**
     * Text length per node the pruner is allowed to judge. Unknown / unjudgeable
     * nodes are simply absent from the returned map.
     *
     * @param  string[]  $nodeIds
     * @return array<string,int>
     */
    private static function nodeTextLengths(string $book, array $nodeIds): array
    {
        $rows = DB::table('nodes')
            ->where('book', $book)
            ->whereIn('node_id', $nodeIds)
            ->get(['node_id', 'plainText', 'content']);

        $lengths = [];
        foreach ($rows as $row) {
            if ($row->plainText === null) {
                continue;
            }
            if (is_string($row->content) && str_contains($row->content, '<latex')) {
                continue; // KaTeX-rendered textContent can exceed stored plainText
            }
            $lengths[$row->node_id] = mb_strlen($row->plainText);
        }

        return $lengths;
    }

    /**
     * Entry ids whose charStart is provably beyond the node's text.
     *
     * @param  string[]  $nodeIdArr
     * @param  array<string,mixed>  $charData
     * @param  array<string,int>  $lengths
     * @return string[]
     */
    private static function staleEntryIds(array $nodeIdArr, array $charData, array $lengths): array
    {
        $stale = [];
        foreach ($nodeIdArr as $nid) {
            if (! array_key_exists($nid, $lengths)) {
                continue;
            }
            $entry = $charData[$nid] ?? null;
            $start = is_array($entry) ? ($entry['charStart'] ?? null) : null;
            if (is_numeric($start) && (int) $start >= $lengths[$nid]) {
                $stale[] = $nid;
            }
        }

        return $stale;
    }
}
