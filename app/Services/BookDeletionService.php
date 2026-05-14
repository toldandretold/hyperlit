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

        // Collect descendants BEFORE deleting anything (BFS needs footnotes/hyperlights rows to exist)
        $descendants = $this->collectDescendantsWithPolicy($bookId);
        $fullDeleteIds = array_slice($descendants['full_delete'], 1); // skip bookId (handled separately)
        $allDescendantIds = array_merge($descendants['full_delete'], $descendants['metadata_only']);

        $db->beginTransaction();
        try {
            // 1. Delete content (nodes, footnotes, bibliography) for parent book
            $stats['nodes_deleted'] = $db->table('nodes')->where('book', $bookId)->delete();
            $stats['footnotes_deleted'] = $db->table('footnotes')->where('book', $bookId)->delete();
            $stats['bibliography_deleted'] = $db->table('bibliography')->where('book', $bookId)->delete();

            // 1b. Delete sub-book content — only for footnote-chain descendants (not past hyperlight boundary)
            foreach ($fullDeleteIds as $descId) {
                $stats['nodes_deleted'] += $db->table('nodes')->where('book', $descId)->delete();
                $stats['footnotes_deleted'] += $db->table('footnotes')->where('book', $descId)->delete();
                $stats['bibliography_deleted'] += $db->table('bibliography')->where('book', $descId)->delete();
            }
            // metadata_only descendants: content preserved (library soft-deleted below)

            // 2. Keep hypercites (needed for citation display when pastes link to this book)
            $stats['hypercites_kept'] = $db->table('hypercites')->where('book', $bookId)->count();

            // 3. Preserve ALL highlights (they link to sub-books whose content must survive)
            // Owner's highlights become ghosts (parent content gone) but sub-book content is preserved
            $stats['hyperlights_orphaned'] = $db->table('hyperlights')
                ->whereIn('book', $allDescendantIds)
                ->count();

            // 4. Always soft delete library record for ALL descendants
            $db->table('library')
                ->where('book', $bookId)
                ->update(['visibility' => 'deleted']);
            $stats['library_action'] = 'soft_deleted';

            // Soft delete sub-book library records (all descendants, both categories)
            $allSubBookIds = array_merge($fullDeleteIds, $descendants['metadata_only']);
            if (!empty($allSubBookIds)) {
                $db->table('library')
                    ->whereIn('book', $allSubBookIds)
                    ->update(['visibility' => 'deleted']);
            }

            // Also delete any reference from creator's library nodes (public, private, and All home pages)
            if ($bookCreator) {
                $sanitizedCreator = str_replace(' ', '', $bookCreator);
                $publicHome = $sanitizedCreator;
                $privateHome = $sanitizedCreator . 'Private';
                $allHome = $sanitizedCreator . 'All';
                $nowMs = round(microtime(true) * 1000);

                // Delete the card from each home book that may contain it
                foreach ([$publicHome, $privateHome, $allHome] as $homeBook) {
                    $db->table('nodes')
                        ->where('book', $homeBook)
                        ->where('node_id', $homeBook . '_' . $bookId . '_card')
                        ->delete();
                }

                // Insert an empty-state card into any home book that now has zero real cards
                $generator = new \App\Services\LibraryCardGenerator();
                foreach ([$publicHome => 'public', $privateHome => 'private', $allHome => 'public'] as $homeBook => $emptyVisibility) {
                    if (!$db->table('library')->where('book', $homeBook)->exists()) {
                        continue;
                    }
                    $realCardCount = $db->table('nodes')
                        ->where('book', $homeBook)
                        ->where('node_id', '!=', $homeBook . '_empty_card')
                        ->count();
                    if ($realCardCount === 0) {
                        $db->table('nodes')
                            ->where('book', $homeBook)
                            ->where('node_id', $homeBook . '_empty_card')
                            ->delete();
                        $db->table('nodes')->insert(
                            $generator->generateLibraryCardChunk(null, $homeBook, 1, true, true, 0, $emptyVisibility)
                        );
                    }
                }

                // Bump timestamps on all three home books
                $db->table('library')
                    ->whereIn('book', [$publicHome, $privateHome, $allHome])
                    ->update(['timestamp' => $nowMs]);

                // Invalidate sorted variants (the deleted card may appear in any of them)
                foreach (['public', 'private', 'all'] as $v) {
                    $db->table('nodes')->where('book', 'LIKE', $sanitizedCreator . '_' . $v . '_%')->delete();
                    $db->table('library')->where('book', 'LIKE', $sanitizedCreator . '_' . $v . '_%')->delete();
                }
            }

            // 5. Mark hypercites as dead for ALL descendants (both categories)
            $deadResult = $this->markHypercitesAsDead($bookId, $allDescendantIds);
            $stats['hypercites_marked_dead'] = $deadResult['count'];

            $db->commit();

            // Bump annotation timestamps for citing books (outside transaction)
            if (!empty($deadResult['citing_books'])) {
                $now = round(microtime(true) * 1000);
                foreach ($deadResult['citing_books'] as $bId) {
                    DB::select('SELECT update_annotations_timestamp(?, ?)', [$bId, $now]);
                }
            }

            // 6. Delink orphaned hypercites in other books (outside transaction)
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
     * Delete a sub-book's content (nodes, footnotes, bibliography, library)
     * without starting its own transaction — safe to call inside UnifiedSyncController's transaction.
     *
     * @param string $subBookId - Sub-book ID to clean up (e.g. "TheBible/HL_abc123")
     * @return array - Stats about what was deleted
     */
    public function deleteSubBookContent(string $subBookId): array
    {
        $db = $this->db();

        // Collect descendants BEFORE deleting anything (BFS needs footnotes/hyperlights rows to exist)
        $descendants = $this->collectDescendantsWithPolicy($subBookId);
        $fullDeleteIds = array_slice($descendants['full_delete'], 1); // skip subBookId (handled below)

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

        foreach ($fullDeleteIds as $descId) {
            $stats['nodes_deleted'] += $db->table('nodes')->where('book', $descId)->delete();
            $stats['footnotes_deleted'] += $db->table('footnotes')->where('book', $descId)->delete();
            $stats['bibliography_deleted'] += $db->table('bibliography')->where('book', $descId)->delete();
            $db->table('library')->where('book', $descId)->update(['visibility' => 'deleted']);
        }
        foreach ($descendants['metadata_only'] as $descId) {
            // Preserve content — only soft-delete library
            $db->table('library')->where('book', $descId)->update(['visibility' => 'deleted']);
        }
        $stats['descendants_content_deleted'] = count($fullDeleteIds);
        $stats['descendants_metadata_only'] = count($descendants['metadata_only']);

        // Mark hypercites as dead for ALL descendants (both categories)
        $allDescendantIds = array_merge($descendants['full_delete'], $descendants['metadata_only']);
        $deadResult = $this->markHypercitesAsDead($subBookId, $allDescendantIds);
        $stats['hypercites_marked_dead'] = $deadResult['count'];
        $stats['dead_citing_books'] = $deadResult['citing_books'];

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

    /**
     * Recursively find all descendant sub-book IDs, categorized by deletion policy.
     * - full_delete: footnote-only chains (same author) — content can be deleted
     * - metadata_only: anything at or below a hyperlight boundary — preserve content
     *
     * The rule: footnotes inherit their parent's mode, hyperlights always switch to metadata_only.
     */
    private function collectDescendantsWithPolicy(string $bookId): array
    {
        $db = $this->db();
        $fullDelete = [$bookId];
        $metadataOnly = [];
        $seen = [$bookId => true];
        $toProcess = [[$bookId, 'full']]; // [id, mode]

        while (!empty($toProcess)) {
            [$current, $mode] = array_shift($toProcess);

            // Footnotes in this book → child sub-books (inherit parent's mode)
            $footnotes = $db->table('footnotes')
                ->where('book', $current)
                ->select('footnoteId')
                ->distinct()
                ->get();

            foreach ($footnotes as $fn) {
                $childId = SubBookIdHelper::build($current, $fn->footnoteId);
                if (!isset($seen[$childId])) {
                    $seen[$childId] = true;
                    if ($mode === 'full') {
                        $fullDelete[] = $childId;
                    } else {
                        $metadataOnly[] = $childId;
                    }
                    $toProcess[] = [$childId, $mode];
                }
            }

            // Hyperlights in this book → child sub-books (ALWAYS metadata_only)
            $highlights = $db->table('hyperlights')
                ->where('book', $current)
                ->select('hyperlight_id')
                ->distinct()
                ->get();

            foreach ($highlights as $hl) {
                $childId = SubBookIdHelper::build($current, $hl->hyperlight_id);
                if (!isset($seen[$childId])) {
                    $seen[$childId] = true;
                    $metadataOnly[] = $childId;
                    $toProcess[] = [$childId, 'metadata'];
                }
            }
        }

        return ['full_delete' => $fullDelete, 'metadata_only' => $metadataOnly];
    }

    /**
     * Get all descendant IDs (both categories merged) for callers that don't need the categorization.
     */
    private function getAllDescendantIds(string $bookId): array
    {
        $result = $this->collectDescendantsWithPolicy($bookId);
        return array_merge($result['full_delete'], $result['metadata_only']);
    }

    /**
     * Mark hypercites as 'dead' for a book and all its descendant sub-books.
     * Returns the count of marked hypercites and the list of citing books that need timestamp bumps.
     */
    public function markHypercitesAsDead(string $bookId, ?array $preCollectedIds = null): array
    {
        $db = $this->db();
        $affectedBooks = $preCollectedIds ?? $this->getAllDescendantIds($bookId);

        // Find hypercites in these books that have citations
        $hypercites = $db->table('hypercites')
            ->whereIn('book', $affectedBooks)
            ->whereRaw('"citedIN" is not null')
            ->whereRaw('jsonb_array_length("citedIN"::jsonb) > 0')
            ->get();

        if ($hypercites->isEmpty()) {
            return ['count' => 0, 'citing_books' => []];
        }

        // Bulk-update to 'dead'
        $ids = $hypercites->pluck('id')->all();
        $db->table('hypercites')
            ->whereIn('id', $ids)
            ->update(['relationshipStatus' => 'dead']);

        // Collect citing books for annotation timestamp bumps
        $citingBooks = [];
        foreach ($hypercites as $hc) {
            $citedIN = json_decode($hc->citedIN, true) ?? [];
            foreach ($citedIN as $ref) {
                $bookPart = explode('#', ltrim($ref, '/'))[0];
                if ($bookPart) {
                    $citingBooks[] = $bookPart;
                    if (str_contains($bookPart, '/')) {
                        $citingBooks[] = SubBookIdHelper::parse($bookPart)['foundation'];
                    }
                }
            }
        }

        return [
            'count' => count($ids),
            'citing_books' => array_values(array_unique($citingBooks)),
        ];
    }
}
