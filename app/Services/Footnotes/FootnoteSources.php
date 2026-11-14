<?php

namespace App\Services\Footnotes;

use Illuminate\Support\Facades\DB;

/**
 * Which works a citation footnote was matched to — for the reader's footnote popup.
 *
 * The scan (CitationScanBibliographyJob) records a footnote's match as `foundation_source`
 * (the matched work's library row; 'unknown' = searched, nothing found), and for a footnote
 * citing several works ("report; journal article") each further work under
 * `llm_metadata.sub_citations[i].resolution`. Short-form ("Ibid.") and pointer footnotes
 * inherit their antecedent's `foundation_source`, so they resolve here like any other.
 *
 * Returned as canonical_source ids — the same identity a bibliography reference carries — so
 * the client resolves each through /api/canonical/{id}/best-version, which applies the
 * per-viewer visibility rules. Nothing here is a book id or body text.
 *
 * Reads on pgsql_admin: the matched rows are system stubs, often private (held for review),
 * which the RLS'd connection hides — and this is also called from BookCache's queue-side warm.
 * The caller has already authorised the BOOK; a canonical id is public bibliographic identity.
 *
 * ONE definition, used by both the live load path (DatabaseToIndexedDBController::getFootnotes)
 * and its cache mirror (BookCache::buildFootnotes) so the two cannot drift.
 */
final class FootnoteSources
{
    /**
     * @return array<string, list<string>>  footnoteId => canonical_source ids, in citation order.
     *                                       Footnotes with no matched work are absent.
     */
    public static function forBook(string $bookId): array
    {
        $db = DB::connection('pgsql_admin');

        $rows = $db->table('footnotes')
            ->where('book', $bookId)
            ->where('is_citation', true)
            ->get(['footnoteId', 'foundation_source', 'llm_metadata']);
        if ($rows->isEmpty()) {
            return [];
        }

        // footnoteId => matched library rows, primary first then each matched sub-citation.
        $booksByFootnote = [];
        foreach ($rows as $row) {
            $books = [];
            if (! empty($row->foundation_source) && $row->foundation_source !== 'unknown') {
                $books[] = (string) $row->foundation_source;
            }
            foreach (self::decode($row->llm_metadata)['sub_citations'] ?? [] as $sub) {
                $resolution = is_array($sub) ? ($sub['resolution'] ?? null) : null;
                if (is_array($resolution) && ($resolution['status'] ?? null) === 'matched' && ! empty($resolution['book'])) {
                    $books[] = (string) $resolution['book'];
                }
            }
            if ($books) {
                $booksByFootnote[$row->footnoteId] = $books;
            }
        }
        if (! $booksByFootnote) {
            return [];
        }

        $canonicalByBook = $db->table('library')
            ->whereIn('book', array_values(array_unique(array_merge(...array_values($booksByFootnote)))))
            ->whereNotNull('canonical_source_id')
            ->pluck('canonical_source_id', 'book');

        $out = [];
        foreach ($booksByFootnote as $footnoteId => $books) {
            $ids = [];
            foreach ($books as $book) {
                $canonical = $canonicalByBook[$book] ?? null;
                if ($canonical && ! in_array($canonical, $ids, true)) {
                    $ids[] = (string) $canonical;
                }
            }
            if ($ids) {
                $out[$footnoteId] = $ids;
            }
        }

        return $out;
    }

    /** llm_metadata is jsonb, and some legacy rows hold a JSON string inside it (double-encoded). */
    private static function decode(mixed $raw): array
    {
        for ($i = 0; $i < 2 && is_string($raw); $i++) {
            $raw = json_decode($raw, true);
        }

        return is_array($raw) ? $raw : [];
    }
}
