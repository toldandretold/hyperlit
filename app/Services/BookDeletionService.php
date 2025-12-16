<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class BookDeletionService
{
    /**
     * Delete a book with proper cleanup
     * - Deletes content (nodes, footnotes, bibliography)
     * - Keeps hypercites (for citation display in pastes)
     * - Deletes only owner's highlights (preserves others)
     * - Always soft deletes library record (visibility: 'deleted')
     *
     * @param string $bookId - Book ID to delete
     * @return array - Stats about what was deleted/delinked
     */
    public function deleteBook(string $bookId): array
    {
        $stats = [
            'nodes_deleted' => 0,
            'footnotes_deleted' => 0,
            'bibliography_deleted' => 0,
            'hypercites_kept' => 0,
            'hypercites_delinked' => 0,
            'hyperlights_deleted' => 0,
            'hyperlights_orphaned' => 0,
            'library_action' => null,
        ];

        // Get book record first (need creator info)
        $book = DB::table('library')->where('book', $bookId)->first();
        if (!$book) {
            Log::warning('BookDeletionService: Book not found', ['book' => $bookId]);
            return $stats;
        }

        $bookCreator = $book->creator;
        $bookCreatorToken = $book->creator_token;

        DB::beginTransaction();
        try {
            // 1. Delete content (nodes, footnotes, bibliography)
            $stats['nodes_deleted'] = DB::table('nodes')->where('book', $bookId)->delete();
            $stats['footnotes_deleted'] = DB::table('footnotes')->where('book', $bookId)->delete();
            $stats['bibliography_deleted'] = DB::table('bibliography')->where('book', $bookId)->delete();

            // 2. Keep hypercites (needed for citation display when pastes link to this book)
            $stats['hypercites_kept'] = DB::table('hypercites')->where('book', $bookId)->count();

            // 3. Delete only the book owner's highlights (preserve others as orphaned)
            $stats['hyperlights_deleted'] = $this->deleteOwnerHighlights($bookId, $bookCreator, $bookCreatorToken);

            // Count orphaned highlights (by other users)
            $stats['hyperlights_orphaned'] = DB::table('hyperlights')
                ->where('book', $bookId)
                ->count();

            // 4. Always soft delete library record
            DB::table('library')
                ->where('book', $bookId)
                ->update(['visibility' => 'deleted']);
            $stats['library_action'] = 'soft_deleted';

            // Also delete any reference from creator's library nodes
            if ($bookCreator) {
                DB::table('nodes')
                    ->where('book', $bookCreator)
                    ->where('node_id', $bookId)
                    ->delete();

                DB::table('library')
                    ->where('book', $bookCreator)
                    ->update(['timestamp' => round(microtime(true) * 1000)]);
            }

            DB::commit();

            // 5. Delink orphaned hypercites in other books (outside transaction)
            $stats['hypercites_delinked'] = $this->delinkOrphanedHypercites($bookId);

            Log::info('BookDeletionService: Book deleted', [
                'book' => $bookId,
                'stats' => $stats
            ]);

            return $stats;

        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('BookDeletionService: Failed to delete book', [
                'book' => $bookId,
                'error' => $e->getMessage()
            ]);
            throw $e;
        }
    }

    /**
     * Delete only highlights made by the book owner
     */
    private function deleteOwnerHighlights(string $bookId, ?string $bookCreator, ?string $bookCreatorToken): int
    {
        $query = DB::table('hyperlights')->where('book', $bookId);

        if ($bookCreator !== null) {
            // Book has a logged-in creator - delete their highlights
            $query->where('creator', $bookCreator);
        } elseif ($bookCreatorToken !== null) {
            // Book has an anonymous creator - delete their highlights
            $query->where('creator_token', $bookCreatorToken);
        } else {
            // No creator info - don't delete any highlights (preserve all)
            return 0;
        }

        return $query->delete();
    }

    /**
     * De-link orphaned hypercites in other books that referenced the deleted book
     * Updates citedIN array and relationshipStatus
     */
    public function delinkOrphanedHypercites(string $deletedBook): int
    {
        // Find hypercites where citedIN contains references to deleted book
        // citedIN format: ["bookId#hypercite_xyz", ...]
        $hypercites = DB::table('hypercites')
            ->whereRaw('"citedIN"::text LIKE ?', ['%"' . $deletedBook . '#%'])
            ->get();

        $delinkedCount = 0;

        foreach ($hypercites as $hypercite) {
            $citedIN = json_decode($hypercite->citedIN, true) ?? [];

            // Filter out references to deleted book
            $filtered = array_values(array_filter($citedIN, function($ref) use ($deletedBook) {
                return !str_starts_with($ref, $deletedBook . '#');
            }));

            // Update if changed
            if (count($filtered) !== count($citedIN)) {
                // Determine new relationshipStatus based on citedIN length
                // (same logic as frontend: utils.js determineRelationshipStatus)
                $newStatus = match(count($filtered)) {
                    0 => 'single',
                    1 => 'couple',
                    default => 'poly'
                };

                DB::table('hypercites')
                    ->where('id', $hypercite->id)
                    ->update([
                        'citedIN' => json_encode($filtered),
                        'relationshipStatus' => $newStatus
                    ]);
                $delinkedCount++;
            }
        }

        return $delinkedCount;
    }
}
