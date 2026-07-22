<?php

namespace App\Services\Annotations;

use App\Models\PgHypercite;
use App\Models\PgHyperlight;
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
 * Prune rule (deliberately conservative — a wrong deletion is worse than a stale
 * pointer):
 *  - Only entries that are PROVABLY impossible are pruned: charStart >= the node's
 *    stored text length. plainText is strip_tags() output with entities un-decoded,
 *    so it is >= the client's textContent length — an entry impossible against
 *    plainText is impossible against any client measurement.
 *  - Nodes containing <latex> are skipped entirely (KaTeX injects glyphs into live
 *    textContent, so server length can under-estimate there).
 *  - A record is NEVER pruned to zero entries. A wholly-impossible single-node
 *    highlight can still be resurrected by an undo that restores the text; whole-
 *    record orphaning stays with the client's _orphaned_* machinery.
 *  - Unknown nodes (not in the nodes table, or NULL plainText) are never judged.
 *  - E2EE books are skipped — the server can't read their plaintext.
 *
 * Two seams, both needed:
 *  - pruneStoredForNodes(): after node upserts, cleans STORED records referencing
 *    the saved nodes (fixes existing fossils the moment the node is edited again).
 *    Writes via pgsql_admin: the annotation may belong to a different creator than
 *    the node's editor, and RLS would silently no-op the cleanup otherwise.
 *  - pruneIncomingItem(): before hyperlight/hypercite upserts persist a payload,
 *    strips impossible entries from it (a stale client re-syncing its un-pruned
 *    copy would otherwise re-introduce the fossil on every sync).
 */
class StaleCharDataPruner
{
    /**
     * Prune stored hyperlight/hypercite entries that reference any of the given
     * (just-saved) nodes with provably-impossible positions.
     *
     * @param  string[]  $nodeIds  data-node-ids of the nodes just written
     * @return int number of node-entries pruned across all records
     */
    public static function pruneStoredForNodes(string $book, array $nodeIds): int
    {
        $nodeIds = array_values(array_unique(array_filter($nodeIds)));
        if (empty($nodeIds) || EncryptedBookGuard::isEncrypted($book)) {
            return 0;
        }

        $lengths = self::nodeTextLengths($book, $nodeIds);
        if (empty($lengths)) {
            return 0;
        }

        // node_id is a jsonb array of strings; ?| matches records containing ANY of
        // the saved ids ("??|" — Laravel treats a lone "?" as a binding placeholder).
        $pgArray = '{'.implode(',', array_map(
            fn ($id) => '"'.str_replace(['\\', '"'], '', $id).'"',
            array_keys($lengths)
        )).'}';

        $prunedTotal = 0;
        foreach ([PgHyperlight::class, PgHypercite::class] as $model) {
            $records = $model::on('pgsql_admin')
                ->where('book', $book)
                ->whereRaw('node_id ??| ?::text[]', [$pgArray])
                ->get();

            foreach ($records as $record) {
                $pruned = self::pruneRecordEntries($record, $lengths);
                $prunedTotal += $pruned;
            }
        }

        return $prunedTotal;
    }

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

    /**
     * Prune a stored record's stale entries (node_id + charData + raw_json mirror).
     * Returns the number of entries removed (0 if untouched).
     */
    private static function pruneRecordEntries(PgHyperlight|PgHypercite $record, array $lengths): int
    {
        $nodeIdArr = is_array($record->node_id) ? $record->node_id : [];
        $charData = is_array($record->charData) ? $record->charData : [];

        $stale = self::staleEntryIds($nodeIdArr, $charData, $lengths);
        if (empty($stale) || count($nodeIdArr) - count($stale) < 1) {
            return 0;
        }

        $record->node_id = array_values(array_diff($nodeIdArr, $stale));
        foreach ($stale as $nid) {
            unset($charData[$nid]);
        }
        $record->charData = $charData;

        // Mirror into raw_json — the read API returns it, so a stale copy there
        // would resurrect the fossil on the next client hydration.
        $raw = $record->raw_json; // hyperlight accessor / hypercite cast → array|null
        if (is_array($raw)) {
            $raw['node_id'] = $record->node_id;
            $raw['charData'] = $charData;
            // PgHyperlight has no raw_json cast (needs manual encode); PgHypercite casts to array.
            $record->raw_json = $record instanceof PgHyperlight ? json_encode($raw) : $raw;
        }

        $record->save();

        Log::info('StaleCharDataPruner: pruned impossible entries from stored annotation', [
            'book' => $record->book,
            'id' => $record->hyperlight_id ?? $record->hyperciteId ?? null,
            'pruned_nodes' => $stale,
        ]);

        return count($stale);
    }
}
