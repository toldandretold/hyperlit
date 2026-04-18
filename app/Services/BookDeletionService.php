<?php

namespace App\Services;

use App\Helpers\SubBookIdHelper;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Database\ConnectionInterface;

class BookDeletionService
{
    private ?ConnectionInterface $db = null;

    /**
     * Set a specific database connection (e.g., admin connection to bypass RLS)
     */
    public function useConnection(ConnectionInterface $connection): self
    {
        $this->db = $connection;
        return $this;
    }

    /**
     * Get the database connection to use
     */
    private function db()
    {
        return $this->db ?? DB::connection();
    }

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

        $db = $this->db();

        // Get book record first (need creator info)
        $book = $db->table('library')->where('book', $bookId)->first();
        if (!$book) {
            Log::warning('BookDeletionService: Book not found', ['book' => $bookId]);
            return $stats;
        }

        $bookCreator = $book->creator;
        $bookCreatorToken = $book->creator_token;

        $db->beginTransaction();
        try {
            // 1. Delete content (nodes, footnotes, bibliography)
            $stats['nodes_deleted'] = $db->table('nodes')->where('book', $bookId)->delete();
            $stats['footnotes_deleted'] = $db->table('footnotes')->where('book', $bookId)->delete();
            $stats['bibliography_deleted'] = $db->table('bibliography')->where('book', $bookId)->delete();

            // 2. Keep hypercites (needed for citation display when pastes link to this book)
            $stats['hypercites_kept'] = $db->table('hypercites')->where('book', $bookId)->count();

            // 3. Delete only the book owner's highlights (preserve others as orphaned)
            $stats['hyperlights_deleted'] = $this->deleteOwnerHighlights($bookId, $bookCreator, $bookCreatorToken, $db);

            // Count orphaned highlights (by other users)
            $stats['hyperlights_orphaned'] = $db->table('hyperlights')
                ->where('book', $bookId)
                ->count();

            // 4. Always soft delete library record
            $db->table('library')
                ->where('book', $bookId)
                ->update(['visibility' => 'deleted']);
            $stats['library_action'] = 'soft_deleted';

            // Also delete any reference from creator's library nodes (both public and private user home pages)
            if ($bookCreator) {
                // Remove spaces from username to match user home book naming convention
                $sanitizedCreator = str_replace(' ', '', $bookCreator);

                // Node ID pattern: {userHomeBook}_{deletedBookId}_card
                $publicNodeId = $sanitizedCreator . '_' . $bookId . '_card';
                $privateNodeId = $sanitizedCreator . 'Private_' . $bookId . '_card';

                // Delete from public user home page
                $db->table('nodes')
                    ->where('book', $sanitizedCreator)
                    ->where('node_id', $publicNodeId)
                    ->delete();

                // Delete from private user home page
                $db->table('nodes')
                    ->where('book', $sanitizedCreator . 'Private')
                    ->where('node_id', $privateNodeId)
                    ->delete();

                // Update timestamps on both user home pages
                $db->table('library')
                    ->where('book', $sanitizedCreator)
                    ->update(['timestamp' => round(microtime(true) * 1000)]);

                $db->table('library')
                    ->where('book', $sanitizedCreator . 'Private')
                    ->update(['timestamp' => round(microtime(true) * 1000)]);
            }

            $db->commit();

            // 5. Delink orphaned hypercites in other books (outside transaction)
            $stats['hypercites_delinked'] = $this->delinkOrphanedHypercites($bookId);

            Log::info('BookDeletionService: Book deleted', [
                'book' => $bookId,
                'stats' => $stats
            ]);

            return $stats;

        } catch (\Exception $e) {
            $db->rollBack();
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
    private function deleteOwnerHighlights(string $bookId, ?string $bookCreator, ?string $bookCreatorToken, $db): int
    {
        $query = $db->table('hyperlights')->where('book', $bookId);

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
     * Delete a sub-book's content (nodes, footnotes, bibliography, library)
     * without starting its own transaction — safe to call inside UnifiedSyncController's transaction.
     *
     * @param string $subBookId - Sub-book ID to clean up (e.g. "TheBible/HL_abc123")
     * @return array - Stats about what was deleted
     */
    public function deleteSubBookContent(string $subBookId): array
    {
        $db = $this->db();

        $stats = [
            'nodes_deleted' => $db->table('nodes')->where('book', $subBookId)->delete(),
            'footnotes_deleted' => $db->table('footnotes')->where('book', $subBookId)->delete(),
            'bibliography_deleted' => $db->table('bibliography')->where('book', $subBookId)->delete(),
        ];

        // Soft-delete library record (if it exists)
        $libraryUpdated = $db->table('library')
            ->where('book', $subBookId)
            ->update(['visibility' => 'deleted']);
        $stats['library_action'] = $libraryUpdated ? 'soft_deleted' : 'not_found';

        Log::info('BookDeletionService: Sub-book content deleted', [
            'sub_book_id' => $subBookId,
            'stats' => $stats,
        ]);

        return $stats;
    }

    /**
     * De-link orphaned hypercites in other books that referenced the deleted book
     * Updates citedIN array and relationshipStatus
     */
    public function delinkOrphanedHypercites(string $deletedBook): int
    {
        $db = $this->db();

        // Find hypercites where citedIN contains references to deleted book
        // citedIN format: ["/bookId#hypercite_xyz", ...] (leading slash from hyperciteHandler.js)
        $hypercites = $db->table('hypercites')
            ->where(function ($q) use ($deletedBook) {
                $q->whereRaw('"citedIN"::text LIKE ?', ['%"/' . $deletedBook . '#%'])
                  ->orWhereRaw('"citedIN"::text LIKE ?', ['%"/' . $deletedBook . '/%']);
            })
            ->get();

        $delinkedCount = 0;
        $affectedBooks = [];

        foreach ($hypercites as $hypercite) {
            $citedIN = json_decode($hypercite->citedIN, true) ?? [];

            // Filter out references to deleted book (citedIN entries have leading slash)
            $filtered = array_values(array_filter($citedIN, function($ref) use ($deletedBook) {
                $prefix = '/' . $deletedBook;
                if (!str_starts_with($ref, $prefix)) return true;
                $nextChar = $ref[strlen($prefix)] ?? '';
                return $nextChar !== '#' && $nextChar !== '/';
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

                $db->table('hypercites')
                    ->where('id', $hypercite->id)
                    ->update([
                        'citedIN' => json_encode($filtered),
                        'relationshipStatus' => $newStatus
                    ]);
                $delinkedCount++;

                if ($hypercite->book) {
                    $affectedBooks[] = $hypercite->book;
                }
            }
        }

        // Bump annotations_updated_at on affected books so clients re-fetch.
        // For sub-books, also bump the foundation book — the client only checks
        // the top-level book's timestamp during sync.
        $booksToBump = [];
        foreach (array_unique($affectedBooks) as $book) {
            $booksToBump[] = $book;
            if (str_contains($book, '/')) {
                $booksToBump[] = SubBookIdHelper::parse($book)['foundation'];
            }
        }
        $booksToBump = array_unique($booksToBump);

        if (!empty($booksToBump)) {
            $now = round(microtime(true) * 1000);
            foreach ($booksToBump as $bookId) {
                DB::select('SELECT update_annotations_timestamp(?, ?)', [$bookId, $now]);
            }
            Log::info('Delink: bumped annotations_updated_at', ['books' => $booksToBump]);
        }

        return $delinkedCount;
    }
}
