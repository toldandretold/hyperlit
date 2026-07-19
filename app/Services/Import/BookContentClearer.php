<?php

namespace App\Services\Import;

use Illuminate\Database\ConnectionInterface;

/**
 * The ONE implementation of "clear a book's content for reconversion" —
 * previously duplicated in ImportController and ReconvertSystemVersionCommand,
 * both with the same data-loss bug: deleting every `{book}/%` sub-book also
 * destroyed HYPERLIGHT ANNOTATION sub-books (the documents readers write
 * under a highlight), which — unlike footnote sub-books — nothing ever
 * regenerates. Annotation sub-books are now excluded by their exact ids
 * (hyperlights.sub_book_id), not by pattern: sub-book id formats vary.
 *
 * Deletes: the book's nodes, footnotes, bibliography rows, and footnote
 * sub-book nodes + library rows. Preserves: the library row itself,
 * hyperlights, hypercites, and every annotation sub-book (nodes + library).
 */
class BookContentClearer
{
    /** $db: a connection that can see/delete the rows (admin from console/jobs, RLS session from HTTP). */
    public function clear(string $bookId, ConnectionInterface $db): void
    {
        // Annotation sub-books to KEEP (user-authored; never regenerated).
        // Read via the BYPASSRLS admin connection: a public book carries
        // OTHER readers' highlights too, and an RLS-filtered keep-list would
        // let their annotation documents be deleted.
        $keep = \Illuminate\Support\Facades\DB::connection('pgsql_admin')
            ->table('hyperlights')
            ->where('book', $bookId)
            ->whereNotNull('sub_book_id')
            ->pluck('sub_book_id')
            ->unique()
            ->values()
            ->all();

        $db->table('nodes')->where('book', $bookId)->delete();
        $db->table('footnotes')->where('book', $bookId)->delete();
        $db->table('bibliography')->where('book', $bookId)->delete();

        $db->table('nodes')->where('book', 'LIKE', "{$bookId}/%")
            ->when($keep, fn ($q) => $q->whereNotIn('book', $keep))
            ->delete();
        $db->table('library')->where('book', 'LIKE', "{$bookId}/%")
            ->where('type', 'sub_book')
            ->when($keep, fn ($q) => $q->whereNotIn('book', $keep))
            ->delete();
    }
}
