<?php

namespace App\Http\Controllers;

use App\Models\PgNodeChunk;
use App\Models\PgLibrary;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Auth;

class NodeHistoryController extends Controller
{
    /**
     * Check if user has permission to access/modify the book
     */
    private function checkBookPermission(Request $request, $bookId, $requireOwnership = true)
    {
        $user = Auth::user();
        $book = PgLibrary::where('book', $bookId)->first();

        if (!$book) {
            return false;
        }

        // If book is public and we don't require ownership, allow read access
        if (!$requireOwnership && $book->visibility === 'public') {
            return true;
        }

        if ($user) {
            // Logged in user - check they own the book
            return $book->creator === $user->name;
        } else {
            // Anonymous user - check token
            $anonymousToken = $request->cookie('anon_token');
            return $book->creator_token === $anonymousToken && is_null($book->creator);
        }
    }

    /**
     * Get distinct save-point snapshots for a book's version history.
     *
     * GET /api/books/{book}/snapshots
     */
    public function getSnapshots(Request $request, string $book)
    {
        if (!$this->checkBookPermission($request, $book, false)) {
            return response()->json([
                'success' => false,
                'message' => 'Access denied'
            ], 403);
        }

        try {
            // Fetch current library timestamp so we can exclude the "now" snapshot
            $library = PgLibrary::where('book', $book)->first();
            $libraryTimestamp = $library?->timestamp;

            $excludeClause = '';
            $params = [];

            // Recent query params: $book, optionally $libraryTimestamp
            $params[] = $book;
            if ($libraryTimestamp) {
                $excludeClause = "AND upper(sys_period) < to_timestamp(? / 1000.0) - interval '2 seconds'";
                $params[] = $libraryTimestamp;
            }

            // Older query params: $book, optionally $libraryTimestamp
            $params[] = $book;
            if ($libraryTimestamp) {
                $params[] = $libraryTimestamp;
            }

            $snapshots = DB::select("
                (
                    -- Recent (last 24h): individual snapshots
                    SELECT
                        upper(sys_period) as changed_at,
                        COUNT(*) as nodes_changed,
                        array_agg(DISTINCT type) as types_changed,
                        false as is_condensed
                    FROM nodes_history
                    WHERE book = ?
                    AND upper(sys_period) IS NOT NULL
                    AND upper(sys_period) >= NOW() - interval '24 hours'
                    {$excludeClause}
                    GROUP BY upper(sys_period)
                )
                UNION ALL
                (
                    -- Older (before 24h): one entry per hour
                    SELECT
                        MAX(upper(sys_period)) as changed_at,
                        COUNT(*) as nodes_changed,
                        array_agg(DISTINCT type) as types_changed,
                        true as is_condensed
                    FROM nodes_history
                    WHERE book = ?
                    AND upper(sys_period) IS NOT NULL
                    AND upper(sys_period) < NOW() - interval '24 hours'
                    {$excludeClause}
                    GROUP BY date_trunc('hour', upper(sys_period))
                )
                ORDER BY changed_at DESC
                LIMIT 2000
            ", $params);

            return response()->json([
                'success' => true,
                'snapshots' => $snapshots,
                'count' => count($snapshots)
            ]);

        } catch (\Exception $e) {
            Log::error('Failed to get snapshots', [
                'book' => $book,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to retrieve snapshots',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    /**
     * Get all versions of a specific node
     *
     * GET /api/nodes/{book}/{nodeId}/history
     */
    public function getNodeHistory(Request $request, string $book, string $nodeId)
    {
        if (!$this->checkBookPermission($request, $book, false)) {
            return response()->json([
                'success' => false,
                'message' => 'Access denied'
            ], 403);
        }

        try {
            // Get all versions: current + historical
            $history = DB::select("
                -- Current version (if exists)
                SELECT
                    id,
                    book,
                    node_id,
                    \"startLine\",
                    chunk_id,
                    content,
                    \"plainText\",
                    type,
                    raw_json,
                    footnotes,
                    created_at,
                    updated_at,
                    sys_period,
                    true as is_current,
                    lower(sys_period) as valid_from,
                    null::timestamptz as valid_to
                FROM nodes
                WHERE book = ? AND node_id = ?

                UNION ALL

                -- Historical versions
                SELECT
                    id,
                    book,
                    node_id,
                    \"startLine\",
                    chunk_id,
                    content,
                    \"plainText\",
                    type,
                    raw_json,
                    footnotes,
                    created_at,
                    updated_at,
                    sys_period,
                    false as is_current,
                    lower(sys_period) as valid_from,
                    upper(sys_period) as valid_to
                FROM nodes_history
                WHERE book = ? AND node_id = ?

                ORDER BY valid_from DESC
            ", [$book, $nodeId, $book, $nodeId]);

            return response()->json([
                'success' => true,
                'book' => $book,
                'node_id' => $nodeId,
                'versions' => $history,
                'total_versions' => count($history)
            ]);

        } catch (\Exception $e) {
            Log::error('Failed to get node history', [
                'book' => $book,
                'node_id' => $nodeId,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to retrieve history',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    /**
     * Get node state at a specific point in time
     *
     * GET /api/nodes/{book}/{nodeId}/at/{timestamp}
     */
    public function getNodeAtTimestamp(Request $request, string $book, string $nodeId, string $timestamp)
    {
        if (!$this->checkBookPermission($request, $book, false)) {
            return response()->json([
                'success' => false,
                'message' => 'Access denied'
            ], 403);
        }

        try {
            // Query for the version that was active at that timestamp
            $node = DB::selectOne("
                -- Check current version first
                SELECT
                    id,
                    book,
                    node_id,
                    \"startLine\",
                    chunk_id,
                    content,
                    \"plainText\",
                    type,
                    raw_json,
                    footnotes,
                    created_at,
                    updated_at,
                    sys_period,
                    true as is_current_version
                FROM nodes
                WHERE book = ?
                AND node_id = ?
                AND sys_period @> ?::timestamptz

                UNION ALL

                -- Check history if not in current
                SELECT
                    id,
                    book,
                    node_id,
                    \"startLine\",
                    chunk_id,
                    content,
                    \"plainText\",
                    type,
                    raw_json,
                    footnotes,
                    created_at,
                    updated_at,
                    sys_period,
                    false as is_current_version
                FROM nodes_history
                WHERE book = ?
                AND node_id = ?
                AND sys_period @> ?::timestamptz

                LIMIT 1
            ", [$book, $nodeId, $timestamp, $book, $nodeId, $timestamp]);

            if (!$node) {
                return response()->json([
                    'success' => false,
                    'message' => 'Node did not exist at the specified timestamp'
                ], 404);
            }

            return response()->json([
                'success' => true,
                'node' => $node,
                'queried_timestamp' => $timestamp
            ]);

        } catch (\Exception $e) {
            Log::error('Failed to get node at timestamp', [
                'book' => $book,
                'node_id' => $nodeId,
                'timestamp' => $timestamp,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to retrieve node',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    /**
     * Get complete book state at a specific point in time
     *
     * GET /api/books/{book}/at/{timestamp}
     */
    public function getBookAtTimestamp(Request $request, string $book, string $timestamp)
    {
        if (!$this->checkBookPermission($request, $book, false)) {
            return response()->json([
                'success' => false,
                'message' => 'Access denied'
            ], 403);
        }

        try {
            $nodes = DB::select("
                -- Current nodes that existed at that time
                SELECT
                    id, book, node_id, \"startLine\", chunk_id, content,
                    \"plainText\", type, raw_json, footnotes, created_at, updated_at,
                    true as is_current
                FROM nodes
                WHERE book = ?
                AND sys_period @> ?::timestamptz

                UNION ALL

                -- Historical nodes that were active at that time
                SELECT
                    id, book, node_id, \"startLine\", chunk_id, content,
                    \"plainText\", type, raw_json, footnotes, created_at, updated_at,
                    false as is_current
                FROM nodes_history
                WHERE book = ?
                AND sys_period @> ?::timestamptz

                ORDER BY \"startLine\"
            ", [$book, $timestamp, $book, $timestamp]);

            return response()->json([
                'success' => true,
                'book' => $book,
                'timestamp' => $timestamp,
                'nodes' => $nodes,
                'node_count' => count($nodes)
            ]);

        } catch (\Exception $e) {
            Log::error('Failed to get book at timestamp', [
                'book' => $book,
                'timestamp' => $timestamp,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to retrieve book state',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    /**
     * Get recent changes for a book (for undo UI)
     *
     * GET /api/books/{book}/changes
     */
    public function getRecentChanges(Request $request, string $book)
    {
        if (!$this->checkBookPermission($request, $book)) {
            return response()->json([
                'success' => false,
                'message' => 'Access denied'
            ], 403);
        }

        $limit = min($request->input('limit', 50), 200);

        try {
            // Get recent changes from history, ordered by when they were superseded
            $changes = DB::select("
                SELECT
                    history_id,
                    id as original_id,
                    node_id,
                    \"startLine\",
                    LEFT(content, 200) as content_preview,
                    type,
                    lower(sys_period) as valid_from,
                    upper(sys_period) as changed_at
                FROM nodes_history
                WHERE book = ?
                ORDER BY upper(sys_period) DESC
                LIMIT ?
            ", [$book, $limit]);

            return response()->json([
                'success' => true,
                'book' => $book,
                'changes' => $changes,
                'count' => count($changes)
            ]);

        } catch (\Exception $e) {
            Log::error('Failed to get recent changes', [
                'book' => $book,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to retrieve changes',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    /**
     * Restore a node to a specific historical version (server-side undo)
     *
     * POST /api/nodes/{book}/{nodeId}/restore
     * Body: { "history_id": 12345 }
     *   OR: { "timestamp": "2024-01-15T10:30:00Z" }
     */
    public function restoreNodeVersion(Request $request, string $book, string $nodeId)
    {
        if (!$this->checkBookPermission($request, $book)) {
            return response()->json([
                'success' => false,
                'message' => 'Access denied'
            ], 403);
        }

        $historyId = $request->input('history_id');
        $timestamp = $request->input('timestamp');

        if (!$historyId && !$timestamp) {
            return response()->json([
                'success' => false,
                'message' => 'Either history_id or timestamp is required'
            ], 400);
        }

        try {
            // Get the historical version to restore
            if ($historyId) {
                $historicalNode = DB::selectOne("
                    SELECT * FROM nodes_history
                    WHERE history_id = ? AND book = ? AND node_id = ?
                ", [$historyId, $book, $nodeId]);
            } else {
                $historicalNode = DB::selectOne("
                    SELECT * FROM nodes_history
                    WHERE book = ? AND node_id = ? AND sys_period @> ?::timestamptz
                ", [$book, $nodeId, $timestamp]);
            }

            if (!$historicalNode) {
                return response()->json([
                    'success' => false,
                    'message' => 'Historical version not found'
                ], 404);
            }

            // Check if the node still exists
            $currentNode = PgNodeChunk::where('book', $book)
                ->where('node_id', $nodeId)
                ->first();

            if ($currentNode) {
                // Update existing node - the trigger will archive current version
                $currentNode->update([
                    'startLine' => $historicalNode->startLine,
                    'chunk_id' => $historicalNode->chunk_id,
                    'content' => $historicalNode->content,
                    'plainText' => $historicalNode->plainText,
                    'type' => $historicalNode->type,
                    'raw_json' => is_string($historicalNode->raw_json)
                        ? json_decode($historicalNode->raw_json, true)
                        : $historicalNode->raw_json,
                    'footnotes' => is_string($historicalNode->footnotes)
                        ? json_decode($historicalNode->footnotes, true)
                        : $historicalNode->footnotes,
                ]);

                $action = 'updated';
            } else {
                // Node was deleted - recreate it
                // Note: This INSERT will trigger versioning to set sys_period
                PgNodeChunk::create([
                    'book' => $historicalNode->book,
                    'node_id' => $historicalNode->node_id,
                    'startLine' => $historicalNode->startLine,
                    'chunk_id' => $historicalNode->chunk_id,
                    'content' => $historicalNode->content,
                    'plainText' => $historicalNode->plainText,
                    'type' => $historicalNode->type,
                    'raw_json' => is_string($historicalNode->raw_json)
                        ? json_decode($historicalNode->raw_json, true)
                        : $historicalNode->raw_json,
                    'footnotes' => is_string($historicalNode->footnotes)
                        ? json_decode($historicalNode->footnotes, true)
                        : $historicalNode->footnotes,
                ]);

                $action = 'recreated';
            }

            Log::info('Node restored from history', [
                'book' => $book,
                'node_id' => $nodeId,
                'history_id' => $historyId,
                'timestamp' => $timestamp,
                'action' => $action
            ]);

            return response()->json([
                'success' => true,
                'message' => "Node {$action} from historical version",
                'action' => $action,
                'restored_from' => $historyId ? "history_id: {$historyId}" : "timestamp: {$timestamp}"
            ]);

        } catch (\Exception $e) {
            Log::error('Failed to restore node version', [
                'book' => $book,
                'node_id' => $nodeId,
                'history_id' => $historyId,
                'timestamp' => $timestamp,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to restore node',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    /**
     * Get complete book data at a specific timestamp, formatted for IndexedDB loading.
     * Returns the same shape as DatabaseToIndexedDBController::getBookData()
     * but with the book field rewritten to a virtual timemachine ID.
     *
     * GET /api/books/{book}/timemachine-data?at={timestamp}
     */
    public function getTimeMachineData(Request $request, string $book)
    {
        if (!$this->checkBookPermission($request, $book, false)) {
            return response()->json([
                'success' => false,
                'message' => 'Access denied'
            ], 403);
        }

        $timestamp = $request->query('at');
        if (!$timestamp) {
            return response()->json([
                'success' => false,
                'message' => 'Missing "at" query parameter'
            ], 400);
        }

        $virtualBookId = $book . '/timemachine';

        try {
            // Get all nodes as they were at the timestamp (same query as getBookAtTimestamp)
            $nodes = DB::select("
                SELECT
                    id, book, node_id, \"startLine\", chunk_id, content,
                    \"plainText\", type, raw_json, footnotes, created_at, updated_at
                FROM nodes
                WHERE book = ?
                AND sys_period @> ?::timestamptz

                UNION ALL

                SELECT
                    id, book, node_id, \"startLine\", chunk_id, content,
                    \"plainText\", type, raw_json, footnotes, created_at, updated_at
                FROM nodes_history
                WHERE book = ?
                AND sys_period @> ?::timestamptz

                ORDER BY \"startLine\"
            ", [$book, $timestamp, $book, $timestamp]);

            if (empty($nodes)) {
                return response()->json([
                    'success' => false,
                    'message' => 'No nodes found at the specified timestamp'
                ], 404);
            }

            // Rewrite each node's book field to the virtual book ID and add empty annotations
            $processedNodes = array_map(function ($node) use ($virtualBookId) {
                return [
                    'book'      => $virtualBookId,
                    'chunk_id'  => (int) $node->chunk_id,
                    'startLine' => (int) $node->startLine,
                    'node_id'   => $node->node_id,
                    'content'   => $node->content,
                    'plainText' => $node->plainText,
                    'type'      => $node->type,
                    'footnotes' => $node->footnotes,
                    'hypercites'=> [],
                    'hyperlights'=> [],
                    'raw_json'  => $node->raw_json,
                ];
            }, $nodes);

            // Get the parent book's library record for title
            $parentLibrary = PgLibrary::where('book', $book)->first();
            $title = $parentLibrary ? ($parentLibrary->title . ' (Version History)') : 'Version History';

            // Build synthetic library record
            $library = [
                'book'       => $virtualBookId,
                'title'      => $title,
                'timestamp'  => time(),
                'creator'    => $parentLibrary->creator ?? null,
                'visibility' => 'private',
                'is_owner'   => true,
            ];

            return response()->json([
                'nodes'        => $processedNodes,
                'footnotes'    => ['book' => $virtualBookId, 'data' => []],
                'bibliography' => ['book' => $virtualBookId, 'data' => []],
                'hyperlights'  => [],
                'hypercites'   => [],
                'library'      => $library,
                'metadata'     => [
                    'book_id'       => $virtualBookId,
                    'total_chunks'  => count($processedNodes),
                    'generated_at'  => now()->toIso8601String(),
                ],
            ]);

        } catch (\Exception $e) {
            Log::error('Failed to get time machine data', [
                'book' => $book,
                'timestamp' => $timestamp,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to retrieve time machine data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    /**
     * Restore entire book to a specific point in time
     *
     * POST /api/books/{book}/restore
     * Body: { "timestamp": "2024-01-15T10:30:00Z" }
     */
    public function restoreBookToTimestamp(Request $request, string $book)
    {
        if (!$this->checkBookPermission($request, $book)) {
            return response()->json([
                'success' => false,
                'message' => 'Access denied'
            ], 403);
        }

        $timestamp = $request->input('timestamp');

        if (!$timestamp) {
            return response()->json([
                'success' => false,
                'message' => 'timestamp is required'
            ], 400);
        }

        try {
            DB::beginTransaction();

            // Get all nodes as they were at the timestamp
            $historicalNodes = DB::select("
                -- Current nodes that existed at that time
                SELECT
                    id, book, node_id, \"startLine\", chunk_id, content,
                    \"plainText\", type, raw_json, footnotes
                FROM nodes
                WHERE book = ? AND sys_period @> ?::timestamptz

                UNION ALL

                -- Historical nodes that were active at that time
                SELECT
                    id, book, node_id, \"startLine\", chunk_id, content,
                    \"plainText\", type, raw_json, footnotes
                FROM nodes_history
                WHERE book = ? AND sys_period @> ?::timestamptz
            ", [$book, $timestamp, $book, $timestamp]);

            if (empty($historicalNodes)) {
                DB::rollBack();
                return response()->json([
                    'success' => false,
                    'message' => 'No nodes found at the specified timestamp'
                ], 404);
            }

            // Delete all current nodes (this archives them via trigger)
            PgNodeChunk::where('book', $book)->delete();

            // Recreate nodes from historical state
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
                        ? json_decode($node->raw_json, true)
                        : $node->raw_json,
                    'footnotes' => is_string($node->footnotes)
                        ? json_decode($node->footnotes, true)
                        : $node->footnotes,
                ]);
                $restored++;
            }

            // Update library timestamp so clients detect the change
            PgLibrary::where('book', $book)->update([
                'timestamp' => round(microtime(true) * 1000)
            ]);

            DB::commit();

            Log::info('Book restored to timestamp', [
                'book' => $book,
                'timestamp' => $timestamp,
                'nodes_restored' => $restored
            ]);

            return response()->json([
                'success' => true,
                'message' => "Book restored to state at {$timestamp}",
                'nodes_restored' => $restored
            ]);

        } catch (\Exception $e) {
            DB::rollBack();

            Log::error('Failed to restore book to timestamp', [
                'book' => $book,
                'timestamp' => $timestamp,
                'error' => $e->getMessage()
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Failed to restore book',
                'error' => $e->getMessage()
            ], 500);
        }
    }
}
