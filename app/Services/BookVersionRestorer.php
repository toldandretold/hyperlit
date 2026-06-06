<?php

namespace App\Services;

use App\Models\PgNodeChunk;
use App\Models\PgLibrary;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Rebuild a book's nodes to the state they were in at a given timestamp, from the temporal
 * `nodes` + `nodes_history` tables (the `nodes_versioning_trigger` archives every superseded
 * row with a closed `sys_period`). Shared by NodeHistoryController's version-history restore AND
 * the vibe-convert "Revert to original" path — one place, no duplication.
 */
class BookVersionRestorer
{
    /**
     * Restore $bookId's nodes to their state at $timestamp (an ISO-8601 / timestamptz string).
     * Returns the number of nodes restored. Throws on failure; throws RuntimeException if no nodes
     * were active at that instant (nothing to restore to).
     */
    public function restoreTo(string $bookId, string $timestamp): int
    {
        DB::beginTransaction();
        try {
            // The nodes that were ACTIVE at $timestamp — current rows whose range still contains it,
            // plus archived rows whose closed range contained it.
            $historicalNodes = DB::select("
                SELECT id, book, node_id, \"startLine\", chunk_id, content,
                       \"plainText\", type, raw_json, footnotes
                FROM nodes
                WHERE book = ? AND sys_period @> (?::timestamptz - interval '1 microsecond')
                UNION ALL
                SELECT id, book, node_id, \"startLine\", chunk_id, content,
                       \"plainText\", type, raw_json, footnotes
                FROM nodes_history
                WHERE book = ? AND sys_period @> (?::timestamptz - interval '1 microsecond')
            ", [$bookId, $timestamp, $bookId, $timestamp]);

            if (empty($historicalNodes)) {
                DB::rollBack();
                throw new \RuntimeException("No nodes found for {$bookId} at {$timestamp}");
            }

            // Delete current nodes (archived via trigger), then recreate the historical state.
            PgNodeChunk::where('book', $bookId)->delete();

            $restored = 0;
            foreach ($historicalNodes as $node) {
                PgNodeChunk::create([
                    'book' => $node->book,
                    'node_id' => $node->node_id,
                    'startLine' => $node->startLine,
                    'chunk_id' => $node->chunk_id,
                    'content' => $node->content,
                    'plainText' => $node->plainText,
                    'type' => $node->type,
                    'raw_json' => is_string($node->raw_json)
                        ? json_decode($node->raw_json, true) : $node->raw_json,
                    'footnotes' => is_string($node->footnotes)
                        ? json_decode($node->footnotes, true) : $node->footnotes,
                ]);
                $restored++;
            }

            // Bump the library timestamp so open clients re-sync.
            PgLibrary::where('book', $bookId)->update([
                'timestamp' => round(microtime(true) * 1000),
            ]);

            DB::commit();
            Log::info('BookVersionRestorer: restored', [
                'book' => $bookId, 'timestamp' => $timestamp, 'nodes_restored' => $restored,
            ]);
            return $restored;
        } catch (\Throwable $e) {
            DB::rollBack();
            throw $e;
        }
    }
}
