<?php

namespace App\Services;

use App\Models\PgNode;
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
                       \"plainText\", type, footnotes
                FROM nodes
                WHERE book = ? AND sys_period @> (?::timestamptz - interval '1 microsecond')
                UNION ALL
                SELECT id, book, node_id, \"startLine\", chunk_id, content,
                       \"plainText\", type, footnotes
                FROM nodes_history
                WHERE book = ? AND sys_period @> (?::timestamptz - interval '1 microsecond')
            ", [$bookId, $timestamp, $bookId, $timestamp]);

            if (empty($historicalNodes)) {
                DB::rollBack();
                throw new \RuntimeException("No nodes found for {$bookId} at {$timestamp}");
            }

            // Delete current nodes (archived via trigger), then recreate the historical state.
            PgNode::where('book', $bookId)->delete();

            $restored = 0;
            foreach ($historicalNodes as $node) {
                PgNode::create([
                    'book' => $node->book,
                    'node_id' => $node->node_id,
                    'startLine' => $node->startLine,
                    'chunk_id' => $node->chunk_id,
                    'content' => $node->content,
                    'plainText' => $node->plainText,
                    'type' => $node->type,
                    'footnotes' => is_string($node->footnotes)
                        ? json_decode($node->footnotes, true) : $node->footnotes,
                ]);
                $restored++;
            }

            // Bump the library timestamp so open clients re-pull the parent's NODES.
            $now = round(microtime(true) * 1000);
            PgLibrary::where('book', $bookId)->update(['timestamp' => $now]);

            // CRITICAL: also bump every SUB-BOOK (footnote) timestamp. A version restore only rewrites
            // the parent's nodes (footnote-ref markers), but footnotes live in their own `book = $bookId/FnId`
            // sub-book rows that this restore never touches. The client's enrichSubBookFromDB
            // (subBookLoader.js) skips re-syncing a sub-book whenever server.timestamp <= local.timestamp —
            // so without this bump the reader keeps whatever STALE/half-cleared footnote state IndexedDB was
            // left in by the revert churn, and footnotes render broken even though the DB rows are correct.
            // Footnotes aren't versioned (their server content is always current), so re-pulling them is safe.
            $likeBook = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $bookId) . '/%';
            PgLibrary::where('book', 'like', $likeBook)->update(['timestamp' => $now]);

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
