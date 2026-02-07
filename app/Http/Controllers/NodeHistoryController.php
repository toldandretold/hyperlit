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
                SELECT * FROM nodes
                WHERE book = ? AND sys_period @> ?::timestamptz

                UNION ALL

                -- Historical nodes that were active at that time
                SELECT
                    id, raw_json, book, chunk_id, \"startLine\", footnotes,
                    content, \"plainText\", type, created_at, updated_at,
                    node_id, sys_period
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
