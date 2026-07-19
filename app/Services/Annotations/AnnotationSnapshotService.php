<?php

namespace App\Services\Annotations;

use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Facades\File;

/**
 * Before a reconvert clears a book's nodes, snapshot the OLD nodes' text so
 * AnnotationReattachmentService can re-anchor hyperlights/hypercites onto the
 * NEW nodes afterwards. The annotation rows themselves survive the clear —
 * only the node text they were anchored in is about to vanish, so that text
 * (ordered, with ids and startLines) is all the snapshot holds.
 *
 * Written to resources/markdown/{book}/annotation_snapshot.json — the same
 * artifact dir the conversion reads/writes, so it travels in book:export
 * bundles and the reattachment hook can gate on its existence (fresh imports
 * never write one → reattachment is a no-op for them).
 */
class AnnotationSnapshotService
{
    public const FILENAME = 'annotation_snapshot.json';

    /**
     * Snapshot iff the book has any annotations. Returns true if written.
     * $db must be a connection that can SEE the rows (admin from console/jobs).
     */
    public function snapshot(string $bookId, ConnectionInterface $db): bool
    {
        $hasAnnotations = $db->table('hyperlights')->where('book', $bookId)->exists()
            || $db->table('hypercites')->where('book', $bookId)->exists();
        if (!$hasAnnotations) {
            return false;
        }

        $nodes = $db->table('nodes')->where('book', $bookId)
            ->orderBy('startLine')
            ->get(['node_id', 'startLine', 'plainText'])
            ->map(fn ($n) => [
                'node_id'   => $n->node_id,
                'startLine' => (float) $n->startLine,
                'plainText' => (string) ($n->plainText ?? ''),
            ])
            ->values()
            ->all();

        $dir = resource_path("markdown/{$bookId}");
        File::ensureDirectoryExists($dir);
        File::put($dir . '/' . self::FILENAME, json_encode([
            'book'     => $bookId,
            'taken_at' => now()->toIso8601String(),
            'nodes'    => $nodes,
        ], JSON_INVALID_UTF8_SUBSTITUTE));

        return true;
    }

    /** The snapshot path for a book (null if none exists). */
    public static function pathFor(string $bookId): ?string
    {
        $path = resource_path("markdown/{$bookId}/" . self::FILENAME);

        return File::exists($path) ? $path : null;
    }

    /** Rename a consumed snapshot so a retry can still find the material. */
    public static function markUsed(string $bookId): void
    {
        $path = self::pathFor($bookId);
        if ($path) {
            File::move($path, preg_replace('/\.json$/', '.used.json', $path));
        }
    }
}
