<?php

namespace App\Mcp\Support;

use App\Http\Controllers\UnifiedSyncController;
use App\Jobs\WarmBookCacheJob;
use App\Models\User;
use App\Services\BookCache;
use Illuminate\Support\Facades\DB;

/**
 * Shared plumbing for the MCP write tools (update_node / append_nodes /
 * cite_passage). Every content write rides UnifiedSyncController::sync — the
 * SAME guarded path the SPA uses — so it inherits the E2EE 422 backstop,
 * NodeHtmlSanitizer, the 409 stale check, server-side annotation recalc
 * (recalcAnnotationsForNodes), embedding invalidation, the sync audit trail,
 * and the nodes_history trigger snapshot that makes MCP edits restorable.
 *
 * Two things the sync path does NOT give a non-SPA caller for free, handled
 * here: a `library` block so library.timestamp advances (without it BookCache
 * serves stale content forever), and the BookCache invalidate + re-warm pair
 * after the write.
 *
 * Ownership is PRE-checked: bulkTargetedUpsert's permission denial silently
 * `continue`s while the response stays success:true, so a tool that trusted
 * the 200 would report a write that never happened.
 */
class BookContentWriter
{
    /** The user must be the book's creator (same rule as DbNodeController::checkBookPermission). */
    public static function ownsBook(User $user, string $bookId): bool
    {
        return DB::table('library')
            ->where('book', $bookId)
            ->where('creator', $user->name)
            ->exists();
    }

    /** Current library content clock, for an honest base_timestamp. */
    public static function currentTimestamp(string $bookId): ?int
    {
        $ts = DB::table('library')->where('book', $bookId)->value('timestamp');

        return $ts !== null ? (int) $ts : null;
    }

    /**
     * One atomic unified-sync write: the given node rows (and optionally
     * hypercite rows, each carrying its own `book`) plus a library block that
     * advances $bookId's content clock. Returns [ok, error, result].
     *
     * $baseTimestamp is the content clock AT THE MOMENT THE CALLER READ the
     * node it is now rewriting. Pass it whenever the write was derived from a
     * read (cite_passage's splice, update_node's replace) — a fresh read here
     * would make the 409 blind to anything that landed between the caller's
     * read and this call, which is exactly the window where OpenCode's
     * parallel cite_passage calls silently ate each other's arrows (each call
     * read the node, spliced, and the last writer won — every call "succeeded").
     *
     * @param  list<array<string,mixed>>  $nodes
     * @param  list<array<string,mixed>>  $hypercites
     * @return array{ok: bool, error: ?string, result: array}
     */
    public static function sync(User $user, string $bookId, array $nodes, array $hypercites = [], ?int $baseTimestamp = null): array
    {
        $payload = [
            'book' => $bookId,
            'nodes' => $nodes,
            'hypercites' => $hypercites,
            // The caller's read-time clock when given; else a fresh read, which
            // only protects the window between here and the transaction.
            'base_timestamp' => $baseTimestamp ?? self::currentTimestamp($bookId),
            'library' => [
                'book' => $bookId,
                'timestamp' => (int) round(microtime(true) * 1000),
            ],
        ];

        $result = InternalCall::call(UnifiedSyncController::class, 'sync', $payload, $user);

        $json = is_array($result['json'] ?? null) ? $result['json'] : [];

        if (($json['error'] ?? null) === 'STALE_DATA') {
            return [
                'ok' => false,
                'error' => 'The book changed while this write was being prepared (concurrent edit). Re-read the node and retry.',
                'result' => $json,
            ];
        }
        if ($result['status'] === 422 || ($result['status'] >= 400 && $result['status'] < 600)) {
            return [
                'ok' => false,
                'error' => $json['message'] ?? "The write was rejected (HTTP {$result['status']}).",
                'result' => $json,
            ];
        }
        if (($json['success'] ?? false) !== true) {
            return ['ok' => false, 'error' => $json['message'] ?? 'The write did not succeed.', 'result' => $json];
        }

        // Permission denials inside bulkTargetedUpsert are silent — verify the
        // rows actually landed.
        if ($nodes !== [] && (int) ($json['results']['nodes']['upserted'] ?? 0) < count($nodes)) {
            return [
                'ok' => false,
                'error' => 'The node write was skipped by the server (permission or validation). Nothing was saved.',
                'result' => $json,
            ];
        }

        // The content clock moved: drop the file cache and re-warm it so the
        // next reader (and the prerender) sees this write.
        try {
            app(BookCache::class)->invalidate($bookId);
        } catch (\Throwable) {
            // best-effort — a stale cache self-corrects on the timestamp check
        }
        WarmBookCacheJob::dispatch($bookId);

        return ['ok' => true, 'error' => null, 'result' => $json];
    }

    /**
     * Fetch one node row (default/RLS connection — the MCP route set the
     * session vars, so visibility matches what this user may read).
     */
    public static function nodeRow(string $bookId, string $nodeId): ?object
    {
        return DB::table('nodes')
            ->where('book', $bookId)
            ->where('node_id', $nodeId)
            ->first();
    }

    /**
     * A stored node row re-shaped as a unified-sync upsert item, with the new
     * content in place. footnotes/type are carried forward VERBATIM — the
     * upsert SQL replaces them wholesale, so omitting them would wipe the
     * node's footnote links.
     */
    public static function nodeItemFrom(object $row, string $newContent): array
    {
        $footnotes = $row->footnotes ?? [];
        if (is_string($footnotes)) {
            $footnotes = json_decode($footnotes, true) ?: [];
        }

        return [
            'book' => $row->book,
            'node_id' => $row->node_id,
            'startLine' => $row->startLine,
            'chunk_id' => $row->chunk_id ?? 0,
            'content' => $newContent,
            'footnotes' => $footnotes,
            'type' => $row->type ?? null,
        ];
    }
}
